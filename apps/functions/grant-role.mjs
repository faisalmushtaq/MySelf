import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/**
 * Give somebody a role, once, from a machine with admin credentials.
 *
 * There is a callable for this — `setRole` in admin.ts — but it requires an
 * existing owner to authorise it, and a fresh project has none. Somebody has
 * to be first, and being first cannot be done through a permission check that
 * nobody can yet pass.
 *
 * So this is the bootstrap, and it is deliberately not part of the deployed
 * surface: it runs on a laptop, against credentials that person already holds,
 * and can only do what they could already do in the console. After the first
 * owner exists, every other account is administered through the researcher
 * view.
 *
 *   node grant-role.mjs you@leeds.ac.uk owner --project myself-research
 *   node grant-role.mjs you@leeds.ac.uk owner --project p --key-file sa.json
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const [email, role = "owner"] = positional;
const projectId = flag("project") ?? process.env.GCLOUD_PROJECT;
const keyFile = flag("key-file") ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;

const ROLES = ["owner", "researcher", "analyst"];

if (!email || !projectId) {
  console.error(
    [
      "Give somebody a role on the study.",
      "",
      "  node grant-role.mjs <email> [owner|researcher|analyst] --project <project-id>",
      "",
      "Needs credentials for that project, either:",
      "  gcloud auth application-default login",
      "",
      "or, without installing gcloud, a service-account key from the Firebase console",
      "(Project settings -> Service accounts -> Generate new private key):",
      "  node grant-role.mjs <email> owner --project <id> --key-file ~/Downloads/key.json",
    ].join("\n"),
  );
  process.exit(2);
}
if (!ROLES.includes(role)) {
  console.error(`'${role}' is not a role. One of: ${ROLES.join(", ")}`);
  process.exit(2);
}

/**
 * Credentials, and a straight answer when there are none.
 *
 * The first version reported "no account for that address" whenever the lookup
 * threw — which is also what a missing credential looks like from the outside,
 * and sent somebody hunting a sign-in problem they did not have. A tool that
 * guesses wrong about why it failed is worse than one that says it cannot tell.
 */
const noCredentials = () =>
  [
    `No usable Google credentials for ${projectId} on this machine.`,
    "",
    "Without installing anything: Firebase console -> Project settings ->",
    "Service accounts -> Generate new private key. Then:",
    "",
    `  pnpm --filter @myself/functions grant ${email} ${role} \\`,
    `    --project ${projectId} --key-file ~/Downloads/<the-file>.json`,
    "",
    "Delete that file afterwards: it is a credential to the whole project.",
    "",
    "Or, if you have gcloud: gcloud auth application-default login",
  ].join("\n");

let credential;
try {
  credential = keyFile ? cert(JSON.parse(readFileSync(keyFile, "utf8"))) : applicationDefault();
} catch (error) {
  console.error(
    keyFile
      ? `Could not read the service-account key at ${keyFile}: ${error.message}`
      : noCredentials(),
  );
  process.exit(1);
}

initializeApp({ credential, projectId });

let user;
try {
  user = await getAuth().getUserByEmail(email);
} catch (error) {
  // Told apart, because they send you to opposite places.
  if (error.code === "auth/user-not-found") {
    console.error(
      `No account for ${email} in ${projectId}. Sign in to the app once with that address first — an account is created by signing in, not by being named here.`,
    );
  } else if (error.code === "app/invalid-credential") {
    // applicationDefault() does not fail when it is constructed, only when it
    // is used — so this is where "there are no credentials" actually lands,
    // wearing the words of a token-fetch failure.
    console.error(noCredentials());
  } else {
    console.error(
      [
        `Could not look up ${email} in ${projectId}.`,
        `  ${error.code ?? "error"}: ${error.message}`,
        "",
        "If that mentions permissions, the account these credentials belong to",
        "needs Firebase Authentication Admin on the project.",
      ].join("\n"),
    );
  }
  process.exit(1);
}

// Merged rather than replaced: a device claim and a role are different things,
// and overwriting one with the other would quietly unenrol an iPad.
const existing = user.customClaims ?? {};
await getAuth().setCustomUserClaims(user.uid, { ...existing, role });

console.log(`${email} is now '${role}' on ${projectId}.`);
console.log("They must sign out and back in — a role arrives in a new token, not the one they are holding.");
