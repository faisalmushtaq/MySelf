import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import consumerDomains from "./src/studio/consumer-domains.json" with { type: "json" };

/**
 * Who may use MySelf Studio — administered from a machine with admin
 * credentials (docs/16 §5.7).
 *
 * The Studio's allowlist is `studies/{study}/studioMembers/{email}`, and in the
 * normal course it is managed from the Studio's own Settings page by an admin.
 * This is for the moment before there is one: the first admin has to be added
 * by somebody who can already write to the project, and that cannot go through
 * a permission check nobody can yet pass. It runs on a laptop, with credentials
 * that person already holds, and can do nothing they could not already do in
 * the console. No credential is, or should ever be, in the repository.
 *
 * Every change is written to the Studio audit log like one made in the app.
 *
 *   pnpm --filter @myself/functions studio-access add brainpopresearch@gmail.com admin --project myself-research
 *   pnpm --filter @myself/functions studio-access remove someone@example.org --project myself-research
 *   pnpm --filter @myself/functions studio-access list --project myself-research
 *   pnpm --filter @myself/functions studio-access domain brainpop.com editor --project myself-research
 *   pnpm --filter @myself/functions studio-access domain brainpop.com none --project myself-research
 *
 * Add `--key-file <service-account.json>` to use a downloaded key instead of
 * `gcloud auth application-default login`, and `--study <id>` for a study other
 * than "ybm". Unlike a role claim, a change here takes effect on the person's
 * next request: the rules read the list every time.
 */

const ROLES = ["viewer", "editor", "publisher", "admin"];

/**
 * Consumer mail domains: admitting one would admit everybody with an address
 * there. The same file the `studioSetDomain` function refuses them from
 * (src/studio/domains.ts), so the command line and the Settings page agree.
 */
const CONSUMER_DOMAINS = new Set(consumerDomains);

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const [command, subject, role] = positional;

const projectId = flag("project") ?? process.env.GCLOUD_PROJECT;
const keyFile = flag("key-file") ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
const study = flag("study") ?? "ybm";

const usage = () => {
  console.error(
    [
      "Manage who may use MySelf Studio.",
      "",
      "  studio-access add <email> <viewer|editor|publisher|admin> --project <id>",
      "  studio-access remove <email> --project <id>",
      "  studio-access list --project <id>",
      "  studio-access domain <domain> <viewer|editor|publisher|admin|none> --project <id>",
      "",
      "Options: --key-file <service-account.json>  --study <study id, default ybm>",
    ].join("\n"),
  );
  process.exit(2);
};

if (!command || !projectId) usage();

const normaliseEmail = (value) => String(value ?? "").trim().toLowerCase();
const isEmail = (value) => /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(value);
const isDomain = (value) => /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);

let credential;
try {
  credential = keyFile ? cert(JSON.parse(readFileSync(keyFile, "utf8"))) : applicationDefault();
} catch (error) {
  console.error(
    keyFile
      ? `Could not read the service-account key at ${keyFile}: ${error.message}`
      : "No usable Google credentials on this machine. Run `gcloud auth application-default login`, or pass --key-file with a key from Firebase console -> Project settings -> Service accounts.",
  );
  process.exit(1);
}

initializeApp({ credential, projectId });
const db = getFirestore();
const actor = `cli:${userInfo().username}`;

const audit = (action, auditSubject, detail) =>
  db.collection(`studies/${study}/studioAudit`).add({
    at: FieldValue.serverTimestamp(),
    actor,
    actorEmail: null,
    action,
    surveyId: null,
    subject: auditSubject,
    detail,
  });

try {
  if (command === "add") {
    const email = normaliseEmail(subject);
    if (!isEmail(email)) usage();
    if (!ROLES.includes(role)) {
      console.error(`'${role}' is not a Studio role. One of: ${ROLES.join(", ")}`);
      process.exit(2);
    }
    await db.doc(`studies/${study}/studioMembers/${email}`).set({
      email,
      role,
      addedAt: FieldValue.serverTimestamp(),
      addedBy: actor,
      addedByEmail: null,
      note: "Added from the command line",
    });
    await audit("access.member_set", email, { role, via: "cli" });
    console.log(`${email} is now a Studio ${role} on ${projectId} (study ${study}).`);
    console.log("They sign in at /MySelf/researcher/#/surveys with that Google account. No token refresh is needed.");
  } else if (command === "remove") {
    const email = normaliseEmail(subject);
    if (!isEmail(email)) usage();
    await db.doc(`studies/${study}/studioMembers/${email}`).delete();
    await audit("access.member_removed", email, { via: "cli" });
    console.log(`${email} no longer has Studio access. It stops working on their next request.`);
  } else if (command === "list") {
    const members = await db.collection(`studies/${study}/studioMembers`).get();
    const config = await db.doc(`studies/${study}/studioAccess/config`).get();
    if (members.empty) console.log("No one is on the Studio list yet.");
    for (const doc of members.docs) console.log(`${doc.id}\t${doc.get("role")}`);
    const domains = config.exists ? config.get("domains") ?? {} : {};
    for (const [domain, domainRole] of Object.entries(domains)) console.log(`*@${domain}\t${domainRole}\t(domain rule)`);
  } else if (command === "domain") {
    const domain = String(subject ?? "").trim().toLowerCase();
    if (!isDomain(domain)) usage();
    if (CONSUMER_DOMAINS.has(domain)) {
      console.error(`${domain} is a public mail provider; a rule for it would admit everyone with an address there. Add people individually instead.`);
      process.exit(2);
    }
    const ref = db.doc(`studies/${study}/studioAccess/config`);
    if (role === "none") {
      await ref.set({ domains: { [domain]: FieldValue.delete() }, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor }, { merge: true });
    } else if (ROLES.includes(role)) {
      await ref.set({ domains: { [domain]: role }, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor }, { merge: true });
    } else {
      usage();
    }
    await audit("access.domain_set", domain, { role: role === "none" ? null : role, via: "cli" });
    console.log(role === "none" ? `Removed the rule for ${domain}.` : `Verified Google accounts at ${domain} are now Studio ${role}s.`);
  } else {
    usage();
  }
} catch (error) {
  console.error(`Could not change Studio access on ${projectId}: ${error.code ?? ""} ${error.message}`);
  console.error("If that mentions permissions, these credentials need Cloud Datastore User (or Owner) on the project.");
  process.exit(1);
}
