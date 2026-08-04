import { initializeApp, applicationDefault } from "firebase-admin/app";
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
 * surface: it runs on a laptop, against Google's application-default
 * credentials, and can only do what that person could already do in the
 * console. After the first owner exists, every other account is administered
 * through the researcher view.
 *
 *   node grant-role.mjs you@leeds.ac.uk owner --project myself-research
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const [email, role = "owner"] = positional;
const projectId = flag("project") ?? process.env.GCLOUD_PROJECT;

const ROLES = ["owner", "researcher", "analyst"];

if (!email || !projectId) {
  console.error(
    [
      "Give somebody a role on the study.",
      "",
      "  node grant-role.mjs <email> [owner|researcher|analyst] --project <project-id>",
      "",
      "Needs Google application-default credentials:",
      "  gcloud auth application-default login",
    ].join("\n"),
  );
  process.exit(2);
}
if (!ROLES.includes(role)) {
  console.error(`'${role}' is not a role. One of: ${ROLES.join(", ")}`);
  process.exit(2);
}

initializeApp({ credential: applicationDefault(), projectId });

let user;
try {
  user = await getAuth().getUserByEmail(email);
} catch {
  console.error(
    `No account for ${email} in ${projectId}. Sign in to the app once with that address first — the account is created by signing in, not by being named here.`,
  );
  process.exit(1);
}

// Merged rather than replaced: a device claim and a role are different things,
// and overwriting one with the other would quietly unenrol an iPad.
const existing = user.customClaims ?? {};
await getAuth().setCustomUserClaims(user.uid, { ...existing, role });

console.log(`${email} is now '${role}' on ${projectId}.`);
console.log("They must sign out and back in — a role arrives in a new token, not the one they are holding.");
