import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
  type TokenOptions,
} from "@firebase/rules-unit-testing";
import {
  collection,
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  setLogLevel,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
// Straight from source, so this suite needs nothing built. Both files import
// only types from elsewhere in the workspace, which disappear in compilation.
import { paths } from "../../../packages/firebase/src/layout.js";
import {
  DRAFT_CLIENT_FIELDS,
  MAX_DRAFT_CHARS,
  ROLE_LEVEL,
  STUDIO_ROLES,
  type StudioRole,
} from "../../../packages/studio/src/contract.js";

/**
 * MySelf Studio's rules — docs/16 §5.2 and §5.7.
 *
 * The Studio is where somebody can change what children are asked, so these
 * tests matter more than most. Every rule is exercised from three sides: the
 * person it is for, the person it is not for, and the person trying to get
 * round it. The last group is the longest on purpose.
 *
 * The paths are the application's own (`paths` in @myself/firebase) and the
 * numbers are the contract's (`ROLE_LEVEL`, `DRAFT_CLIENT_FIELDS`,
 * `MAX_DRAFT_CHARS`), so a change to either that the rules do not follow fails
 * here rather than in front of a researcher.
 */

let env: RulesTestEnvironment;
type Db = ReturnType<RulesTestContext["firestore"]>;

const STUDY = "ybm";
const SURVEY = "ybm_nd2026_standard";
const VERSION = "7.1.0";
const HASH_HEX = "308f47ba".padEnd(64, "0");
const DOMAIN = "brainpop.test";
const T0 = Timestamp.fromDate(new Date("2026-09-28T09:00:00.000Z"));

const P = {
  surveys: paths.studioSurveys(STUDY),
  survey: paths.studioSurvey(STUDY, SURVEY),
  draft: paths.studioDraft(STUDY, SURVEY),
  versions: paths.studioVersions(STUDY, SURVEY),
  version: paths.studioVersion(STUDY, SURVEY, VERSION),
  presences: paths.studioPresence(STUDY, SURVEY),
  presence: (uid: string) => paths.studioPresenceOf(STUDY, SURVEY, uid),
  published: paths.publishedPointer(STUDY, SURVEY),
  publishedAll: `studies/${STUDY}/published`,
  publicReleases: paths.publicReleases(STUDY),
  publicRelease: paths.publicRelease(STUDY, HASH_HEX),
  members: paths.studioMembers(STUDY),
  member: (email: string) => paths.studioMember(STUDY, email),
  access: paths.studioAccessConfig(STUDY),
  auditLog: paths.studioAudit(STUDY),
  auditRow: `${paths.studioAudit(STUDY)}/row_1`,
};

/**
 * One member per role. The addresses are mixed case in the token and stored
 * lower-cased, as the functions and `studio-access` store them, so every test
 * that passes also proves the rules lower-case before they look.
 */
const MEMBERS: Record<StudioRole, string> = {
  viewer: "Vera.Viewer@Example.org",
  editor: "Ed.Editor@Example.org",
  publisher: "Pat.Publisher@Example.org",
  admin: "Ada.Admin@Example.org",
};

interface Caller {
  uid: string;
  email: string | null;
  db: Db;
}

const caller = (uid: string, token: TokenOptions): Caller => ({
  uid,
  email: typeof token.email === "string" ? token.email : null,
  db: env.authenticatedContext(uid, token).firestore(),
});

/** Signed in as the Studio signs people in: Google, with an address Google has verified. */
const google = (uid: string, email: string, extra: TokenOptions = {}): Caller =>
  caller(uid, { email, email_verified: true, firebase: { sign_in_provider: "google.com" }, ...extra });

const member = (role: StudioRole): Caller => google(`u_${role}`, MEMBERS[role]);

/** Listed, but never the caller in these tests: "somebody else's entry". */
const OTHER_MEMBER = "someone.else@example.org";

const nobody = (): Db => env.unauthenticatedContext().firestore();

/** The draft as the functions create it. `revision` 3, so the next save is 4. */
const draftDoc = () => ({
  surveyId: SURVEY,
  revision: 3,
  content: "{}",
  updatedAt: T0,
  updatedBy: "u_someone",
  updatedByEmail: "someone@example.org",
  basedOn: { version: VERSION, hash: `sha256:${HASH_HEX}` },
  createdAt: T0,
});

const seed = (write: (db: Db) => Promise<void>) =>
  env.withSecurityRulesDisabled(async (ctx) => write(ctx.firestore()));

const seedDraft = () => seed((db) => setDoc(doc(db, P.draft), draftDoc()));

/**
 * A save exactly as the Studio makes one: the next revision, the server's
 * clock, the caller's own uid and the caller's list key (lower-cased address).
 */
const saveFields = (c: Caller, revision = 4) => ({
  content: JSON.stringify({ savedAt: revision }),
  revision,
  updatedAt: serverTimestamp(),
  updatedBy: c.uid,
  updatedByEmail: (c.email ?? "").toLowerCase(),
});

const save = (c: Caller, override: Record<string, unknown> = {}, path = P.draft) =>
  updateDoc(doc(c.db, path), { ...saveFields(c), ...override });

const presenceFields = (c: Caller) => ({
  uid: c.uid,
  email: (c.email ?? "").toLowerCase(),
  at: serverTimestamp(),
  focus: "kss.q1",
});

// Named, so a failure says which request it was rather than only that one of
// thirty was wrong.
async function allowed(what: string, attempt: () => Promise<unknown>) {
  try {
    await assertSucceeds(attempt());
  } catch (error) {
    throw new Error(`expected to be ALLOWED: ${what}\n  ${(error as Error).message}`);
  }
}

async function refused(what: string, attempt: () => Promise<unknown>) {
  try {
    await assertFails(attempt());
  } catch (error) {
    throw new Error(`expected to be REFUSED: ${what}\n  ${(error as Error).message}`);
  }
}

/** Everything a Studio member of any role may read. */
const memberReads = (db: Db): Array<[string, () => Promise<unknown>]> => [
  ["get survey", () => getDoc(doc(db, P.survey))],
  ["list surveys", () => getDocs(collection(db, P.surveys))],
  ["get draft", () => getDoc(doc(db, P.draft))],
  ["get version", () => getDoc(doc(db, P.version))],
  ["list versions", () => getDocs(collection(db, P.versions))],
  ["list presence", () => getDocs(collection(db, P.presences))],
  ["get audit row", () => getDoc(doc(db, P.auditRow))],
  ["list audit", () => getDocs(collection(db, P.auditLog))],
];

/** What only an admin may read: the list itself. */
const adminReads = (db: Db): Array<[string, () => Promise<unknown>]> => [
  ["list members", () => getDocs(collection(db, P.members))],
  ["get another member's entry", () => getDoc(doc(db, P.member(OTHER_MEMBER)))],
  ["get the domain rule", () => getDoc(doc(db, P.access))],
];

/**
 * Every write a browser might attempt on something only functions write. None
 * of these may succeed for anyone, whatever their role.
 */
const functionOnlyWrites = (db: Db): Array<[string, () => Promise<unknown>]> => [
  ["create survey", () => setDoc(doc(db, paths.studioSurvey(STUDY, "new_survey")), { title: "x" })],
  ["update survey", () => updateDoc(doc(db, P.survey), { title: "renamed" })],
  ["delete survey", () => deleteDoc(doc(db, P.survey))],
  ["create version", () => setDoc(doc(db, paths.studioVersion(STUDY, SURVEY, "8.0.0")), { hash: "sha256:x" })],
  ["rewrite version", () => updateDoc(doc(db, P.version), { hash: "sha256:other" })],
  ["delete version", () => deleteDoc(doc(db, P.version))],
  ["repoint published", () => updateDoc(doc(db, P.published), { hash: "sha256:evil", generation: 99 })],
  ["create published", () => setDoc(doc(db, paths.publishedPointer(STUDY, "other")), { hash: "sha256:evil" })],
  ["delete published", () => deleteDoc(doc(db, P.published))],
  ["create public release", () => setDoc(doc(db, paths.publicRelease(STUDY, "f".repeat(64))), { manifest: "{}" })],
  ["rewrite public release", () => updateDoc(doc(db, P.publicRelease), { manifest: "{\"evil\":true}" })],
  ["delete public release", () => deleteDoc(doc(db, P.publicRelease))],
  ["add a member", () => setDoc(doc(db, P.member("new.person@example.org")), { email: "new.person@example.org", role: "admin" })],
  ["change a member's role", () => updateDoc(doc(db, P.member(MEMBERS.viewer)), { role: "admin" })],
  ["remove a member", () => deleteDoc(doc(db, P.member(MEMBERS.viewer)))],
  ["set the domain rule", () => setDoc(doc(db, P.access), { domains: { "gmail.com": "admin" } })],
  ["change the domain rule", () => updateDoc(doc(db, P.access), { domains: { [DOMAIN]: "admin" } })],
  ["delete the domain rule", () => deleteDoc(doc(db, P.access))],
  ["append audit", () => setDoc(doc(db, `${P.auditLog}/forged`), { action: "version.published" })],
  ["rewrite audit", () => updateDoc(doc(db, P.auditRow), { actor: "someone else" })],
  ["delete audit", () => deleteDoc(doc(db, P.auditRow))],
];

beforeAll(async () => {
  // Several hundred refusals are the point of this file, and the SDK logs a
  // warning for each one, which buries the result. A failing assertion still
  // carries the rules' own explanation in its message.
  setLogLevel("silent");
  env = await initializeTestEnvironment({
    projectId: "demo-myself",
    firestore: {
      rules: readFileSync(fileURLToPath(new URL("../firestore.rules", import.meta.url)), "utf8"),
      host: "127.0.0.1",
      port: 8181,
    },
  });
});

afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await seed(async (db) => {
    for (const role of STUDIO_ROLES) {
      const email = MEMBERS[role].toLowerCase();
      await setDoc(doc(db, P.member(email)), {
        email,
        role,
        addedAt: T0,
        addedBy: "cli:test",
        addedByEmail: null,
        note: null,
      });
    }
    await setDoc(doc(db, P.member(OTHER_MEMBER)), { email: OTHER_MEMBER, role: "viewer" });
    await setDoc(doc(db, P.access), { domains: { [DOMAIN]: "editor" }, updatedAt: T0, updatedBy: "cli:test" });
    await setDoc(doc(db, P.survey), {
      surveyId: SURVEY,
      study: STUDY,
      title: "Yorkshire Brain Map",
      createdAt: T0,
      createdBy: "cli:test",
      active: null,
      latestVersion: VERSION,
      versionCount: 1,
      draftEditors: [],
    });
    await setDoc(doc(db, P.draft), draftDoc());
    await setDoc(doc(db, P.version), { surveyId: SURVEY, version: VERSION, hash: `sha256:${HASH_HEX}` });
    await setDoc(doc(db, P.published), {
      surveyId: SURVEY,
      study: STUDY,
      hash: `sha256:${HASH_HEX}`,
      version: VERSION,
      releaseKey: "ybm_nd2026_standard_r7_1_0",
      engineVersion: "0.1.0",
      generation: 1,
      publishedAt: T0,
    });
    await setDoc(doc(db, P.publicRelease), {
      surveyId: SURVEY,
      study: STUDY,
      hash: `sha256:${HASH_HEX}`,
      version: VERSION,
      manifest: "{}",
      bytes: 2,
      publishedAt: T0,
    });
    await setDoc(doc(db, P.auditRow), {
      at: T0,
      actor: "cli:test",
      actorEmail: null,
      action: "access.member_set",
      surveyId: null,
      subject: "ada.admin@example.org",
      detail: { role: "admin", via: "cli" },
    });
    await setDoc(doc(db, P.presence("u_admin")), {
      uid: "u_admin",
      email: "ada.admin@example.org",
      at: T0,
      focus: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorised
// ─────────────────────────────────────────────────────────────────────────────

describe("Studio roles, as the contract defines them", () => {
  it("are the numbers written into firestore.rules", () => {
    // roleLevel() in the rules spells these out; they cannot import them.
    expect(ROLE_LEVEL).toEqual({ viewer: 1, editor: 2, publisher: 3, admin: 4 });
  });

  it("give each role exactly the access its level implies", async () => {
    for (const role of STUDIO_ROLES) {
      await seedDraft();
      const c = member(role);
      const level = ROLE_LEVEL[role];

      for (const [what, attempt] of memberReads(c.db)) {
        await (level >= ROLE_LEVEL.viewer ? allowed : refused)(`${role}: ${what}`, attempt);
      }
      await (level >= ROLE_LEVEL.editor ? allowed : refused)(`${role}: save the draft`, () => save(c));
      for (const [what, attempt] of adminReads(c.db)) {
        await (level >= ROLE_LEVEL.admin ? allowed : refused)(`${role}: ${what}`, attempt);
      }
    }
  });
});

describe("editors", () => {
  it("save the draft one revision at a time, as themselves, on the server's clock", async () => {
    const ed = member("editor");
    await allowed("revision 4", () => save(ed));
    await allowed("revision 5", () => save(ed, { revision: 5 }));
    const stored = await getDoc(doc(ed.db, P.draft));
    expect(stored.get("revision")).toBe(5);
    expect(stored.get("updatedBy")).toBe("u_editor");
    expect(stored.get("updatedByEmail")).toBe("ed.editor@example.org");
    // Provenance the functions set is untouched by a save.
    expect(stored.get("basedOn")).toEqual({ version: VERSION, hash: `sha256:${HASH_HEX}` });
  });

  // Review addition: the Studio saves in a transaction (read the draft, then
  // update it), not with a bare updateDoc, and R10 is about two people. Both
  // are pinned here: the transaction's read and write both pass, and the second
  // of two editors who loaded the same revision is refused rather than
  // silently replacing the first one's save.
  it("save through a transaction, and the second of two saves from one revision loses", async () => {
    const ed = member("editor");
    const colleague = google("u_x", "x@brainpop.test");
    await allowed("first save from revision 3, in a transaction", () =>
      runTransaction(ed.db, async (tx) => {
        const ref = doc(ed.db, P.draft);
        const loaded = await tx.get(ref);
        tx.update(ref, saveFields(ed, (loaded.get("revision") as number) + 1));
      }),
    );
    // The colleague also loaded revision 3, so also asks for 4, which is taken.
    await refused("second save from revision 3", () => save(colleague, { revision: 4 }));
    const stored = await getDoc(doc(ed.db, P.draft));
    expect(stored.get("revision")).toBe(4);
    expect(stored.get("updatedBy")).toBe(ed.uid);
  });

  it("change exactly the fields the contract lists, and the Studio's save touches no others", async () => {
    expect([...DRAFT_CLIENT_FIELDS].sort()).toEqual(Object.keys(saveFields(member("editor"))).sort());
  });

  it("may save a draft right up to the size limit", async () => {
    await allowed("content of MAX_DRAFT_CHARS", () =>
      save(member("editor"), { content: "x".repeat(MAX_DRAFT_CHARS) }),
    );
  });

  it("mark their own presence, and take it down again", async () => {
    const ed = member("editor");
    await allowed("create own presence", () => setDoc(doc(ed.db, P.presence(ed.uid)), presenceFields(ed)));
    await allowed("update own presence", () =>
      setDoc(doc(ed.db, P.presence(ed.uid)), { ...presenceFields(ed), focus: null }),
    );
    await allowed("delete own presence", () => deleteDoc(doc(ed.db, P.presence(ed.uid))));
  });
});

describe("a domain rule", () => {
  it("admits a verified Google account at that domain with the role it names", async () => {
    // Mixed case in the domain as well as the name: matching is on the list key.
    const x = google("u_x", `X.Person@BrainPOP.test`);
    for (const [what, attempt] of memberReads(x.db)) await allowed(`domain editor: ${what}`, attempt);
    await allowed("domain editor saves", () => save(x));
    await allowed("domain editor marks presence", () => setDoc(doc(x.db, P.presence(x.uid)), presenceFields(x)));
    // An editor, not an admin.
    for (const [what, attempt] of adminReads(x.db)) await refused(`domain editor: ${what}`, attempt);
  });

  it("gives way to a personal entry, which decides for that person either way", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, P.member("boss@brainpop.test")), { email: "boss@brainpop.test", role: "admin" });
      await setDoc(doc(db, P.member("reader@brainpop.test")), { email: "reader@brainpop.test", role: "viewer" });
    });
    // Listed above the domain's role: the listing wins.
    const boss = google("u_boss", "boss@brainpop.test");
    for (const [what, attempt] of adminReads(boss.db)) await allowed(`listed admin at domain: ${what}`, attempt);
    // Listed below it: the listing still wins, so an admin can give one person
    // at an admitted domain less than the domain's role.
    const reader = google("u_reader", "reader@brainpop.test");
    await allowed("listed viewer at an editor domain reads the draft", () => getDoc(doc(reader.db, P.draft)));
    await refused("listed viewer at an editor domain saves", () => save(reader));
  });

  it("stops admitting anyone the moment it is removed", async () => {
    const x = google("u_x", "x@brainpop.test");
    await allowed("before", () => getDoc(doc(x.db, P.survey)));
    await seed((db) => setDoc(doc(db, P.access), { domains: {}, updatedAt: T0, updatedBy: "cli:test" }));
    await refused("after", () => getDoc(doc(x.db, P.survey)));
  });

  it("that is malformed admits nobody, and locks nobody listed out", async () => {
    await seed((db) => setDoc(doc(db, P.access), { domains: "brainpop.test", updatedAt: T0, updatedBy: "cli:test" }));
    await refused("domain account", () => getDoc(doc(google("u_x", "x@brainpop.test").db, P.survey)));
    await allowed("listed editor", () => save(member("editor")));
  });
});

describe("the existing owner", () => {
  // An owner claim is an admin in the Studio, with or without a list entry,
  // so there is somebody who can add the first member from Settings.
  const owner = () => caller("u_owner", { role: "owner", email: "Owner@Leeds.test" });

  it("reads, edits and sees the list without being on it", async () => {
    const o = owner();
    for (const [what, attempt] of memberReads(o.db)) await allowed(`owner: ${what}`, attempt);
    for (const [what, attempt] of adminReads(o.db)) await allowed(`owner: ${what}`, attempt);
    await allowed("owner saves", () => save(o));
    await allowed("owner marks presence", () => setDoc(doc(o.db, P.presence(o.uid)), presenceFields(o)));
  });

  it("still cannot write anything only functions write", async () => {
    const o = owner();
    for (const [what, attempt] of functionOnlyWrites(o.db)) await refused(`owner: ${what}`, attempt);
  });
});

describe("admins and members", () => {
  it("an admin reads the list and the domain rule", async () => {
    for (const [what, attempt] of adminReads(member("admin").db)) await allowed(`admin: ${what}`, attempt);
    await allowed("admin queries the list", () =>
      getDocs(query(collection(member("admin").db, P.members), where("role", "==", "editor"))),
    );
  });

  it("every member reads their own entry, whatever the case of their address", async () => {
    for (const role of STUDIO_ROLES) {
      const c = member(role);
      await allowed(`${role} reads own entry`, () => getDoc(doc(c.db, P.member(MEMBERS[role]))));
    }
  });
});

describe("what participants load", () => {
  it("is readable signed out, one document at a time", async () => {
    const db = nobody();
    await allowed("get the live pointer", () => getDoc(doc(db, P.published)));
    await allowed("get a release by hash", () => getDoc(doc(db, P.publicRelease)));
    // A hash nobody published reads as absent, not as an error.
    await allowed("get an unknown hash", () => getDoc(doc(db, paths.publicRelease(STUDY, "0".repeat(64)))));
  });

  it("is readable by an iPad, which is what loads it", async () => {
    const db = caller("dev_a", { device: true, study: STUDY }).db;
    await allowed("device gets the pointer", () => getDoc(doc(db, P.published)));
    await allowed("device gets the release", () => getDoc(doc(db, P.publicRelease)));
  });

  // Review addition. The participant app does not use the SDK here: it makes a
  // plain signed-out REST GET (docs/16 §5.3, apps/participant/src/lib/releases.ts)
  // and treats 404 as "nothing published" and anything else as "unreachable".
  // So the status codes are part of the contract, and are checked on the wire.
  it("answers the participant app's signed-out REST GET: 200, or 404 when absent, never a list", async () => {
    const emulator = env.emulators.firestore!;
    const base = `http://${emulator.host}:${emulator.port}/v1/projects/${env.projectId}/databases/(default)/documents`;
    const status = async (path: string, init?: RequestInit) => (await fetch(`${base}/${path}`, init)).status;

    expect(await status(P.published)).toBe(200);
    expect(await status(P.publicRelease)).toBe(200);
    expect(await status(paths.publishedPointer(STUDY, "no_such_survey"))).toBe(404);
    expect(await status(paths.publicRelease(STUDY, "0".repeat(64)))).toBe(404);
    // A REST list is a `list`, and a structured query is too.
    expect(await status(P.publishedAll)).toBe(403);
    expect(await status(P.publicReleases)).toBe(403);
    const runQuery = (collectionId: string) =>
      status(`studies/${STUDY}:runQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId }] } }),
      });
    expect(await runQuery("published")).toBe(403);
    expect(await runQuery("publicReleases")).toBe(403);
    // Nothing else in the Studio answers a signed-out GET.
    expect(await status(P.draft)).toBe(403);
    expect(await status(P.version)).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unauthorised
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asserts a caller has no Studio access at all: every read and every write is
 * refused, and only the two public documents can be fetched.
 */
async function hasNoStudioAccess(who: string, c: Caller) {
  for (const [what, attempt] of memberReads(c.db)) await refused(`${who}: ${what}`, attempt);
  for (const [what, attempt] of adminReads(c.db)) await refused(`${who}: ${what}`, attempt);
  await refused(`${who}: save the draft`, () => save(c));
  await refused(`${who}: mark presence`, () => setDoc(doc(c.db, P.presence(c.uid)), presenceFields(c)));
  for (const [what, attempt] of functionOnlyWrites(c.db)) await refused(`${who}: ${what}`, attempt);
  await allowed(`${who}: get the live pointer`, () => getDoc(doc(c.db, P.published)));
  await allowed(`${who}: get a public release`, () => getDoc(doc(c.db, P.publicRelease)));
}

describe("people not on the list", () => {
  it("signed out: nothing but the two public documents", async () => {
    const db = nobody();
    for (const [what, attempt] of memberReads(db)) await refused(`signed out: ${what}`, attempt);
    for (const [what, attempt] of adminReads(db)) await refused(`signed out: ${what}`, attempt);
    await refused("signed out: own-looking member entry", () => getDoc(doc(db, P.member(MEMBERS.admin))));
    await refused("signed out: save", () => updateDoc(doc(db, P.draft), { revision: 4 }));
    for (const [what, attempt] of functionOnlyWrites(db)) await refused(`signed out: ${what}`, attempt);
  });

  it("a verified Google account nobody listed", async () => {
    const stranger = google("u_stranger", "stranger@example.org");
    await hasNoStudioAccess("unlisted", stranger);
    // It may ask whether it is on the list, and learn only "no".
    const own = await getDoc(doc(stranger.db, P.member(stranger.email!)));
    expect(own.exists()).toBe(false);
  });

  it("a listed address Google has not verified", async () => {
    await hasNoStudioAccess("unverified", google("u_ed2", MEMBERS.editor, { email_verified: false }));
    await hasNoStudioAccess(
      "no verification claim",
      caller("u_ed3", { email: MEMBERS.editor, firebase: { sign_in_provider: "google.com" } }),
    );
  });

  it("a listed, verified address from any provider but Google", async () => {
    for (const provider of ["password", "custom", "github.com", "microsoft.com"] as const) {
      await hasNoStudioAccess(
        `provider ${provider}`,
        google(`u_${provider}`, MEMBERS.admin, { firebase: { sign_in_provider: provider } }),
      );
    }
  });

  it("an anonymous sign-in, even one claiming a listed address", async () => {
    await hasNoStudioAccess(
      "anonymous",
      google("u_anon", MEMBERS.admin, { firebase: { sign_in_provider: "anonymous" }, provider_id: "anonymous" }),
    );
  });

  it("an iPad, even one carrying a listed, verified Google address or an owner claim", async () => {
    const ipad = google("dev_a", MEMBERS.admin, { device: true, study: STUDY });
    await hasNoStudioAccess("device with admin address", ipad);
    await refused("device reads 'its' member entry", () => getDoc(doc(ipad.db, P.member(MEMBERS.admin))));
    await hasNoStudioAccess(
      "device with owner claim",
      caller("dev_b", { device: true, study: STUDY, role: "owner", email: "owner@leeds.test" }),
    );
  });

  it("researchers and analysts, whose claims give them the sittings but not the Studio", async () => {
    for (const role of ["researcher", "analyst"]) {
      await hasNoStudioAccess(`${role} claim`, caller(`u_${role}`, { role }));
      await hasNoStudioAccess(
        `${role} claim, signed in with Google`,
        google(`u_${role}_g`, `${role}@example.org`, { role }),
      );
    }
  });

  it("someone removed from the list, on their very next request", async () => {
    const ed = member("editor");
    await allowed("before removal", () => save(ed));
    await seed((db) => deleteDoc(doc(db, P.member(MEMBERS.editor))));
    // Same token, no refresh: the rules read the list every time.
    await refused("after removal: save", () => save(ed, { revision: 5 }));
    await refused("after removal: read", () => getDoc(doc(ed.db, P.draft)));
  });

  it("an entry whose role is not a Studio role", async () => {
    await seed((db) => setDoc(doc(db, P.member("odd@example.org")), { email: "odd@example.org", role: "superuser" }));
    await hasNoStudioAccess("unknown role", google("u_odd", "odd@example.org"));
  });
});

// Review addition. studioLevel() reads the list of the study in the path, so a
// place on one study's list (or its domain rule) is no place on another's.
// Nothing else tested that the lookup is scoped by the path's study rather
// than, say, a fixed one.
describe("a place on one study's list", () => {
  it("gives nothing in another study", async () => {
    const OTHER = "other_study";
    const O = {
      survey: paths.studioSurvey(OTHER, SURVEY),
      draft: paths.studioDraft(OTHER, SURVEY),
      version: paths.studioVersion(OTHER, SURVEY, VERSION),
      presence: (uid: string) => paths.studioPresenceOf(OTHER, SURVEY, uid),
      members: paths.studioMembers(OTHER),
      member: (email: string) => paths.studioMember(OTHER, email),
      access: paths.studioAccessConfig(OTHER),
      auditRow: `${paths.studioAudit(OTHER)}/row_1`,
    };
    await seed(async (db) => {
      await setDoc(doc(db, O.survey), { surveyId: SURVEY, study: OTHER, title: "Another study" });
      await setDoc(doc(db, O.draft), draftDoc());
      await setDoc(doc(db, O.version), { surveyId: SURVEY, version: VERSION });
      await setDoc(doc(db, O.member(OTHER_MEMBER)), { email: OTHER_MEMBER, role: "viewer" });
      await setDoc(doc(db, O.access), { domains: {}, updatedAt: T0, updatedBy: "cli:test" });
      await setDoc(doc(db, O.auditRow), { at: T0, actor: "cli:test", action: "survey.created" });
    });

    for (const [who, c] of [
      ["ybm admin", member("admin")],
      ["ybm editor", member("editor")],
      ["ybm domain editor", google("u_x", "x@brainpop.test")],
    ] as const) {
      await refused(`${who}: get survey`, () => getDoc(doc(c.db, O.survey)));
      await refused(`${who}: list surveys`, () => getDocs(collection(c.db, paths.studioSurveys(OTHER))));
      await refused(`${who}: get draft`, () => getDoc(doc(c.db, O.draft)));
      await refused(`${who}: get version`, () => getDoc(doc(c.db, O.version)));
      await refused(`${who}: get audit`, () => getDoc(doc(c.db, O.auditRow)));
      await refused(`${who}: save the draft`, () => save(c, {}, O.draft));
      await refused(`${who}: mark presence`, () => setDoc(doc(c.db, O.presence(c.uid)), presenceFields(c)));
      await refused(`${who}: list members`, () => getDocs(collection(c.db, O.members)));
      await refused(`${who}: another member's entry`, () => getDoc(doc(c.db, O.member(OTHER_MEMBER))));
      await refused(`${who}: the domain rule`, () => getDoc(doc(c.db, O.access)));
    }

    // The owner claim is not per study (nor is it for devices and audit above),
    // so the owner is an admin in every study. Pinned so it is a decision.
    const owner = caller("u_owner", { role: "owner", email: "owner@leeds.test" });
    await allowed("owner: get draft in another study", () => getDoc(doc(owner.db, O.draft)));
  });
});

describe("viewers", () => {
  it("read but do not write", async () => {
    const v = member("viewer");
    await refused("viewer saves", () => save(v));
    await refused("viewer marks presence", () => setDoc(doc(v.db, P.presence(v.uid)), presenceFields(v)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Malicious
// ─────────────────────────────────────────────────────────────────────────────

describe("an editor trying to get round the draft rule", () => {
  it("cannot skip, repeat or rewind a revision", async () => {
    const ed = member("editor");
    await refused("revision + 2", () => save(ed, { revision: 5 }));
    await refused("same revision", () => save(ed, { revision: 3 }));
    await refused("revision - 1", () => save(ed, { revision: 2 }));
    await refused("revision as a string", () => save(ed, { revision: "4" }));
    await refused("revision as a fraction", () => save(ed, { revision: 3.5 }));
    await refused("revision removed", () => save(ed, { revision: deleteField() }));
  });

  it("cannot change where the draft came from or what it is", async () => {
    const ed = member("editor");
    await refused("basedOn", () => save(ed, { basedOn: { version: "9.9.9", hash: "sha256:evil" } }));
    await refused("basedOn removed", () => save(ed, { basedOn: deleteField() }));
    await refused("surveyId", () => save(ed, { surveyId: "another_survey" }));
    await refused("createdAt", () => save(ed, { createdAt: serverTimestamp() }));
    await refused("a field the contract does not have", () => save(ed, { role: "admin" }));
    // A whole-document write that leaves provenance out is removing it.
    await refused("set without provenance", () => setDoc(doc(ed.db, P.draft), saveFields(ed)));
  });

  it("cannot sign a save as somebody else", async () => {
    const ed = member("editor");
    await refused("another uid", () => save(ed, { updatedBy: "u_admin" }));
    await refused("another address", () => save(ed, { updatedByEmail: "ada.admin@example.org" }));
    // The contract is the list key: lower-cased. The token's own spelling is
    // refused, so every stored address matches the list.
    await refused("address not lower-cased", () => save(ed, { updatedByEmail: MEMBERS.editor }));
    await refused("no address", () => save(ed, { updatedByEmail: deleteField() }));
  });

  it("cannot choose the time", async () => {
    const ed = member("editor");
    await refused("client Timestamp", () => save(ed, { updatedAt: Timestamp.now() }));
    await refused("client Date", () => save(ed, { updatedAt: new Date() }));
    await refused("time left as it was", () => save(ed, { updatedAt: T0 }));
  });

  it("cannot store anything but a string under the limit", async () => {
    const ed = member("editor");
    await refused("content as a map", () => save(ed, { content: { composition: {} } }));
    await refused("content as a number", () => save(ed, { content: 42 }));
    await refused("content as null", () => save(ed, { content: null }));
    await refused("content one over the limit", () => save(ed, { content: "x".repeat(MAX_DRAFT_CHARS + 1) }));
  });

  it("cannot create, delete, or write a draft other than `current`", async () => {
    const ed = member("editor");
    await refused("create a draft for a new survey", () =>
      setDoc(doc(ed.db, paths.studioDraft(STUDY, "new_survey")), { ...draftDoc(), ...saveFields(ed, 0) }),
    );
    await refused("create a second draft", () =>
      setDoc(doc(ed.db, `${P.survey}/draft/other`), { ...draftDoc(), ...saveFields(ed) }),
    );
    await seed((db) => setDoc(doc(db, `${P.survey}/draft/other`), draftDoc()));
    await refused("update a draft other than current", () => save(ed, {}, `${P.survey}/draft/other`));
    await refused("delete the draft", () => deleteDoc(doc(ed.db, P.draft)));
    // Not an admin either: a draft is removed by no client.
    await refused("admin deletes the draft", () => deleteDoc(doc(member("admin").db, P.draft)));
  });
});

describe("anyone trying to write what only functions write", () => {
  it("is refused at every role, including admin", async () => {
    for (const role of STUDIO_ROLES) {
      for (const [what, attempt] of functionOnlyWrites(member(role).db)) await refused(`${role}: ${what}`, attempt);
    }
  });

  it("cannot put themselves on the list, or raise their own role", async () => {
    const ed = member("editor");
    await refused("editor makes own entry admin", () =>
      updateDoc(doc(ed.db, P.member(MEMBERS.editor)), { role: "admin" }),
    );
    await refused("editor overwrites own entry", () =>
      setDoc(doc(ed.db, P.member(MEMBERS.editor)), { email: "ed.editor@example.org", role: "admin" }),
    );
    const stranger = google("u_stranger", "stranger@example.org");
    await refused("stranger adds themselves", () =>
      setDoc(doc(stranger.db, P.member(stranger.email!)), { email: "stranger@example.org", role: "viewer" }),
    );
    await refused("stranger adds their domain", () =>
      setDoc(doc(stranger.db, P.access), { domains: { "example.org": "admin" } }),
    );
  });
});

describe("anyone trying to enumerate the public documents", () => {
  it("cannot list them, signed out or as an admin", async () => {
    for (const [who, db] of [
      ["signed out", nobody()],
      ["admin", member("admin").db],
      ["owner", caller("u_owner", { role: "owner" }).db],
    ] as const) {
      // The project's people may list a study's live pointers (D-56: how the
      // dashboard finds its surveys); a Studio role and the public may not.
      if (who === "owner") await allowed(`${who}: list published`, () => getDocs(collection(db, P.publishedAll)));
      else await refused(`${who}: list published`, () => getDocs(collection(db, P.publishedAll)));
      await refused(`${who}: list public releases`, () => getDocs(collection(db, P.publicReleases)));
      await refused(`${who}: query public releases`, () =>
        getDocs(query(collection(db, P.publicReleases), where("surveyId", "==", SURVEY))),
      );
    }
  });
});

describe("presence", () => {
  it("cannot be written for somebody else, or with someone else's details", async () => {
    const ed = member("editor");
    const admin = member("admin");
    await refused("another uid's document", () =>
      setDoc(doc(ed.db, P.presence(admin.uid)), presenceFields(admin)),
    );
    // Their slot, the editor's own details: overwriting (or taking down) the
    // admin's marker by writing a truthful one in its place.
    await refused("another uid's document, own details inside", () =>
      setDoc(doc(ed.db, P.presence(admin.uid)), presenceFields(ed)),
    );
    await refused("own document, another uid inside", () =>
      setDoc(doc(ed.db, P.presence(ed.uid)), { ...presenceFields(ed), uid: admin.uid }),
    );
    await refused("own document, another address", () =>
      setDoc(doc(ed.db, P.presence(ed.uid)), { ...presenceFields(ed), email: "ada.admin@example.org" }),
    );
    await refused("client time", () =>
      setDoc(doc(ed.db, P.presence(ed.uid)), { ...presenceFields(ed), at: Timestamp.now() }),
    );
    await refused("an extra field", () =>
      setDoc(doc(ed.db, P.presence(ed.uid)), { ...presenceFields(ed), role: "admin" }),
    );
    await refused("focus that is not a question ID", () =>
      setDoc(doc(ed.db, P.presence(ed.uid)), { ...presenceFields(ed), focus: { evil: true } }),
    );
    await refused("delete another's marker", () => deleteDoc(doc(ed.db, P.presence(admin.uid))));
    await refused("signed out deletes a marker", () => deleteDoc(doc(nobody(), P.presence(admin.uid))));
  });

  it("can be taken down by its own account even after it is removed from the list", async () => {
    const ed = member("editor");
    await allowed("mark presence", () => setDoc(doc(ed.db, P.presence(ed.uid)), presenceFields(ed)));
    await seed((db) => deleteDoc(doc(db, P.member(MEMBERS.editor))));
    await refused("removed: update own marker", () => setDoc(doc(ed.db, P.presence(ed.uid)), presenceFields(ed)));
    // Deleting your own marker can only ever remove what you wrote.
    await allowed("removed: delete own marker", () => deleteDoc(doc(ed.db, P.presence(ed.uid))));
  });
});

describe("anyone trying to read the list without being an admin", () => {
  it("cannot read another member's entry or list them", async () => {
    for (const role of ["viewer", "editor", "publisher"] as const) {
      const c = member(role);
      const other = role === "viewer" ? MEMBERS.admin : MEMBERS.viewer;
      await refused(`${role}: another member's entry`, () => getDoc(doc(c.db, P.member(other))));
      await refused(`${role}: list members`, () => getDocs(collection(c.db, P.members)));
      await refused(`${role}: query own entry through a list`, () =>
        getDocs(query(collection(c.db, P.members), where("email", "==", MEMBERS[role].toLowerCase()))),
      );
      await refused(`${role}: domain rule`, () => getDoc(doc(c.db, P.access)));
    }
    // A stranger cannot probe addresses to find out who has access.
    const stranger = google("u_stranger", "stranger@example.org");
    await refused("stranger probes an address", () => getDoc(doc(stranger.db, P.member(MEMBERS.admin))));
  });
});

describe("anyone trying to pass for someone at the domain", () => {
  it("is matched on the exact domain, and nothing that merely contains it", async () => {
    const spoofs = [
      "evil@brainpop.test.attacker.com",
      "evil@attacker.com#@brainpop.test",
      "evil@attacker.com@brainpop.test",
      // Review addition: the one spoof that puts the real domain second of
      // three parts, so it is refused only by the rule's "exactly one @" check.
      // Without it, deleting that check left every test passing.
      "evil@brainpop.test@attacker.com",
      "evil@sub.brainpop.test",
      "evil@xbrainpop.test",
      "brainpop.test@attacker.com",
      "evil@brainpop.testx",
    ];
    for (const [i, email] of spoofs.entries()) {
      await hasNoStudioAccess(email, google(`u_spoof_${i}`, email));
    }
  });

  it("gains nothing from an unverified or non-Google account at the domain", async () => {
    await hasNoStudioAccess("unverified at domain", google("u_d1", "x@brainpop.test", { email_verified: false }));
    await hasNoStudioAccess(
      "password at domain",
      google("u_d2", "x@brainpop.test", { firebase: { sign_in_provider: "password" } }),
    );
  });
});

describe("everything else in the Studio", () => {
  it("is closed, even to an admin", async () => {
    const db = member("admin").db;
    await refused("unknown survey subcollection", () => getDoc(doc(db, `${P.survey}/secrets/x`)));
    await refused("write unknown survey subcollection", () => setDoc(doc(db, `${P.survey}/secrets/x`), { a: 1 }));
    await refused("unknown studio collection", () => getDoc(doc(db, `studies/${STUDY}/studioThings/x`)));
    // The study document is the registry now (D-56): anyone may get it, and
    // nobody writes it from a browser — that is covered under "study spaces".
    await refused("write the study document", () => setDoc(doc(db, paths.study(STUDY)), { status: "open" }));
    // Studio access is not access to the sittings.
    await refused("sittings", () => getDoc(doc(db, paths.session(STUDY, "s1"))));
    await refused("narratives", () => getDoc(doc(db, paths.narrative(STUDY, "s1"))));
  });

  // Review addition. Every Studio rule is scoped to /studies/{study}/…, and a
  // collection-group query is matched only by a `{path=**}` rule, of which
  // there is none but the closing deny. So nobody, not even the owner, can
  // enumerate drafts, the list, or the public documents across studies. A
  // `match /{path=**}/published/{id}` added later for convenience would open
  // exactly that, and fail here.
  it("cannot be enumerated across studies with a collection-group query", async () => {
    const groups = [
      "surveys",
      "draft",
      "versions",
      "presence",
      "published",
      "publicReleases",
      "studioMembers",
      "studioAccess",
      "studioAudit",
    ];
    for (const [who, db] of [
      ["admin", member("admin").db],
      ["owner", caller("u_owner", { role: "owner", email: "owner@leeds.test" }).db],
      ["signed out", nobody()],
    ] as const) {
      for (const group of groups) {
        await refused(`${who}: collection group ${group}`, () => getDocs(collectionGroup(db, group)));
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Study spaces (D-56, docs/16 §11.4–§11.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A second study space, `future`, set up as `studioCreateStudy` leaves one:
 * its registry document, its creator on its own list as admin, a survey with
 * a live version, and a sitting. Its people are not on `ybm`'s list and
 * `ybm`'s are not on its.
 */
const FUTURE = "future";
const F = {
  study: paths.study(FUTURE),
  survey: paths.studioSurvey(FUTURE, "future_main"),
  surveys: paths.studioSurveys(FUTURE),
  draft: paths.studioDraft(FUTURE, "future_main"),
  version: paths.studioVersion(FUTURE, "future_main", "1.0.0"),
  presence: (uid: string) => paths.studioPresenceOf(FUTURE, "future_main", uid),
  published: paths.publishedPointer(FUTURE, "future_main"),
  publishedAll: `studies/${FUTURE}/published`,
  publicRelease: paths.publicRelease(FUTURE, "a".repeat(64)),
  members: paths.studioMembers(FUTURE),
  member: (email: string) => paths.studioMember(FUTURE, email),
  access: paths.studioAccessConfig(FUTURE),
  auditRow: `${paths.studioAudit(FUTURE)}/row_1`,
  session: paths.session(FUTURE, "ses_f1"),
};
const FUTURE_ADMIN = "Fay.Future@Example.org";

const seedFuture = () =>
  seed(async (db) => {
    await setDoc(doc(db, F.study), {
      study: FUTURE,
      title: "Perspectives of the future",
      status: "open",
      createdAt: T0,
      createdBy: "u_owner",
      updatedAt: T0,
      updatedBy: "u_owner",
      closedAt: null,
    });
    await setDoc(doc(db, F.member(FUTURE_ADMIN.toLowerCase())), { email: FUTURE_ADMIN.toLowerCase(), role: "admin" });
    await setDoc(doc(db, F.survey), { surveyId: "future_main", study: FUTURE, title: "Future" });
    await setDoc(doc(db, F.draft), { ...draftDoc(), surveyId: "future_main" });
    await setDoc(doc(db, F.version), { surveyId: "future_main", version: "1.0.0" });
    await setDoc(doc(db, F.published), { surveyId: "future_main", study: FUTURE, hash: `sha256:${"a".repeat(64)}`, version: "1.0.0" });
    await setDoc(doc(db, F.publicRelease), { surveyId: "future_main", study: FUTURE, manifest: "{}" });
    await setDoc(doc(db, F.auditRow), { at: T0, actor: "u_owner", action: "study.created" });
    await setDoc(doc(db, F.session), { sessionId: "ses_f1", study: FUTURE, deviceId: "ipad_1", releaseHash: "sha256:x" });
  });

const futureAdmin = () => google("u_fay", FUTURE_ADMIN);

describe("the study registry", () => {
  it("is readable by anyone, one study at a time — an iPad reads it before anybody types a code", async () => {
    await seedFuture();
    for (const [who, db] of [
      ["signed out", nobody()],
      ["an iPad", caller("dev_a", { device: true, study: STUDY }).db],
      ["a stranger", google("u_s", "stranger@example.org").db],
    ] as const) {
      await allowed(`${who}: get a study`, () => getDoc(doc(db, F.study)));
      // The default study has no document, and reading that is not an error.
      await allowed(`${who}: get the default study's absent document`, () => getDoc(doc(db, paths.study(STUDY))));
    }
  });

  it("is listed only by the project's people, so a stranger cannot learn what studies exist", async () => {
    await seedFuture();
    for (const role of ["owner", "researcher", "analyst"]) {
      const db = caller(`u_${role}`, { role }).db;
      await allowed(`${role}: list studies`, () => getDocs(collection(db, paths.studies())));
    }
    for (const [who, db] of [
      ["signed out", nobody()],
      ["an iPad", caller("dev_a", { device: true, study: STUDY }).db],
      ["a Studio admin of the study", futureAdmin().db],
      ["a ybm Studio admin", member("admin").db],
      ["an iPad carrying an owner claim", caller("dev_b", { device: true, role: "owner" }).db],
    ] as const) {
      await refused(`${who}: list studies`, () => getDocs(collection(db, paths.studies())));
    }
  });

  it("is written by nobody from a browser, the owner included: studies are created by a function", async () => {
    await seedFuture();
    for (const [who, db] of [
      ["owner", caller("u_owner", { role: "owner", email: "owner@leeds.test" }).db],
      ["the study's Studio admin", futureAdmin().db],
      ["signed out", nobody()],
    ] as const) {
      await refused(`${who}: create a study`, () => setDoc(doc(db, paths.study("rogue")), { title: "x", status: "open" }));
      await refused(`${who}: reopen or rename a study`, () => updateDoc(doc(db, F.study), { status: "closed", title: "x" }));
      await refused(`${who}: delete a study`, () => deleteDoc(doc(db, F.study)));
      await refused(`${who}: register the default study`, () => setDoc(doc(db, paths.study(STUDY)), { status: "closed" }));
    }
  });

  it("answers the participant app's signed-out REST GET: 200 for a study, 404 for none, never a list", async () => {
    await seedFuture();
    const emulator = env.emulators.firestore!;
    const base = `http://${emulator.host}:${emulator.port}/v1/projects/${env.projectId}/databases/(default)/documents`;
    const status = async (path: string) => (await fetch(`${base}/${path}`)).status;
    expect(await status(F.study)).toBe(200);
    expect(await status(paths.study("no_such_study"))).toBe(404);
    expect(await status(paths.study(STUDY))).toBe(404);
    expect(await status(paths.studies())).toBe(403);
    expect(await status(F.published)).toBe(200);
    expect(await status(F.publicRelease)).toBe(200);
    expect(await status(F.publishedAll)).toBe(403);
  });
});

describe("two study spaces", () => {
  it("keep their Studios apart: a role in one is nothing in the other, both ways", async () => {
    await seedFuture();
    const fay = futureAdmin();
    // In her own study, everything an admin may do.
    await allowed("future admin: get survey", () => getDoc(doc(fay.db, F.survey)));
    await allowed("future admin: list surveys", () => getDocs(collection(fay.db, F.surveys)));
    await allowed("future admin: get version", () => getDoc(doc(fay.db, F.version)));
    await allowed("future admin: list members", () => getDocs(collection(fay.db, F.members)));
    await allowed("future admin: read the audit", () => getDoc(doc(fay.db, F.auditRow)));
    await allowed("future admin: save the draft", () => save(fay, {}, F.draft));
    await allowed("future admin: mark presence", () => setDoc(doc(fay.db, F.presence(fay.uid)), presenceFields(fay)));
    // In ybm, nothing at all.
    for (const [what, attempt] of memberReads(fay.db)) await refused(`future admin in ybm: ${what}`, attempt);
    for (const [what, attempt] of adminReads(fay.db)) await refused(`future admin in ybm: ${what}`, attempt);
    await refused("future admin in ybm: save the draft", () => save(fay));

    // And ybm's people in future, nothing.
    for (const role of STUDIO_ROLES) {
      const c = member(role);
      await refused(`ybm ${role}: get future's survey`, () => getDoc(doc(c.db, F.survey)));
      await refused(`ybm ${role}: get future's draft`, () => getDoc(doc(c.db, F.draft)));
      await refused(`ybm ${role}: list future's members`, () => getDocs(collection(c.db, F.members)));
      await refused(`ybm ${role}: save future's draft`, () => save(c, {}, F.draft));
    }
  });

  it("give no Studio member any sitting, in either study", async () => {
    await seedFuture();
    await refused("future admin: future's sitting", () => getDoc(doc(futureAdmin().db, F.session)));
    await refused("ybm admin: future's sitting", () => getDoc(doc(member("admin").db, F.session)));
    // The project's people read sittings in every study, as they read ybm's.
    await allowed("researcher: future's sitting", () => getDoc(doc(caller("u_r", { role: "researcher" }).db, F.session)));
  });

  it("let the project's people list each study's live surveys, and nobody else", async () => {
    await seedFuture();
    await allowed("analyst: list future's pointers", () => getDocs(collection(caller("u_a", { role: "analyst" }).db, F.publishedAll)));
    await refused("future admin: list future's pointers", () => getDocs(collection(futureAdmin().db, F.publishedAll)));
    await refused("an iPad: list future's pointers", () =>
      getDocs(collection(caller("dev_a", { device: true, study: FUTURE }).db, F.publishedAll)),
    );
  });

  it("keep one study's iPad out of another's sittings", async () => {
    await seedFuture();
    const ipad = caller("ipad_1", { device: true, study: STUDY }).db;
    await refused("a ybm iPad creates a sitting in future", () =>
      setDoc(doc(ipad, paths.session(FUTURE, "ses_x")), { sessionId: "ses_x", deviceId: "ipad_1", study: FUTURE }),
    );
  });
});

// Review addition. The emulator ignores firestore.indexes.json, so nothing else
// would notice these going missing; production would. The fieldOverrides are
// the task's (docs/16 §5.2: the big strings and the audit detail are never
// indexed). The composite index serves the Studio's history panel, which asks
// for one survey's audit rows newest first (`where surveyId ==`, `orderBy at
// desc`), a query Firestore refuses in production without it.
describe("firestore.indexes.json", () => {
  const spec = JSON.parse(readFileSync(fileURLToPath(new URL("../firestore.indexes.json", import.meta.url)), "utf8")) as {
    indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order?: string }> }>;
    fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: unknown[] }>;
  };

  it("keeps the large Studio fields out of every index", () => {
    for (const [group, field] of [
      ["draft", "content"],
      ["publicReleases", "manifest"],
      ["studioAudit", "detail"],
    ]) {
      const override = spec.fieldOverrides.find((o) => o.collectionGroup === group && o.fieldPath === field);
      expect(override, `${group}.${field}`).toBeDefined();
      expect(override!.indexes).toEqual([]);
    }
  });

  it("indexes one survey's audit rows newest first, and keeps the sittings index", () => {
    expect(spec.indexes).toContainEqual({
      collectionGroup: "studioAudit",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "surveyId", order: "ASCENDING" },
        { fieldPath: "at", order: "DESCENDING" },
      ],
    });
    expect(spec.indexes.some((i) => i.collectionGroup === "sessions")).toBe(true);
  });
});
