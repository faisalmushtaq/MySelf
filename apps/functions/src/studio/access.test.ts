import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { paths } from "@myself/firebase";
import { ROLE_LEVEL, STUDIO_ROLES, type StudioRole } from "@myself/studio";
import { requireStudio, studioRoleFor, type StudioToken } from "./access.js";

/**
 * The server's reading of the Studio list, held to the rules' reading.
 *
 * `studioLevel` in infra/firebase/firestore.rules decides what a browser may
 * see and save; `studioRoleFor` decides what a function will publish or grant.
 * Every caller the rules suite (infra/firebase/test/studio.rules.test.ts)
 * throws at the rules is thrown at this too — same tokens, same list, same
 * answer — so the two cannot drift apart without a test saying so.
 *
 * The list is stood in for by a map of documents, counting reads: what matters
 * is which documents decide, and that nothing is remembered between calls.
 */

const STUDY = "ybm";
const DOMAIN = "brainpop.test";

/** The rules suite's members: mixed case in the token, stored lower-cased. */
const MEMBERS: Record<StudioRole, string> = {
  viewer: "Vera.Viewer@Example.org",
  editor: "Ed.Editor@Example.org",
  publisher: "Pat.Publisher@Example.org",
  admin: "Ada.Admin@Example.org",
};
const OTHER_MEMBER = "someone.else@example.org";

let docs: Map<string, Record<string, unknown>>;
let reads: string[];

const db = {
  doc: (path: string) => ({
    get: async () => {
      reads.push(path);
      const data = docs.get(path);
      return { exists: data !== undefined, get: (field: string) => data?.[field], data: () => data };
    },
  }),
} as unknown as Firestore;

const member = (email: string) => `${paths.studioMembers(STUDY)}/${email}`;
const config = paths.studioAccessConfig(STUDY);

beforeEach(() => {
  reads = [];
  docs = new Map();
  for (const role of STUDIO_ROLES) {
    const email = MEMBERS[role].toLowerCase();
    docs.set(member(email), { email, role });
  }
  docs.set(member(OTHER_MEMBER), { email: OTHER_MEMBER, role: "viewer" });
  docs.set(config, { domains: { [DOMAIN]: "editor" } });
});

/** Signed in as the Studio signs people in: Google, with an address Google has verified. */
const google = (email: string, extra: StudioToken = {}): StudioToken => ({
  email,
  email_verified: true,
  firebase: { sign_in_provider: "google.com" },
  ...extra,
});

const roleOf = async (token: StudioToken | null) => (await studioRoleFor(db, STUDY, token)).role;

describe("the roles, as the rules number them", () => {
  it("gives each listed member exactly their role, whatever the case of their address", async () => {
    for (const role of STUDIO_ROLES) {
      const access = await studioRoleFor(db, STUDY, google(MEMBERS[role]));
      expect(access).toEqual({ role, email: MEMBERS[role].toLowerCase(), reason: null });
    }
    // The contract's numbers are the ones written into the rules.
    expect(ROLE_LEVEL).toEqual({ viewer: 1, editor: 2, publisher: 3, admin: 4 });
  });

  it("reads only the member's own entry when there is one, as the rules do", async () => {
    await studioRoleFor(db, STUDY, google(MEMBERS.editor));
    expect(reads).toEqual([member(MEMBERS.editor.toLowerCase())]);
  });
});

describe("a domain rule", () => {
  it("admits a verified Google account at that domain with the role it names", async () => {
    expect(await roleOf(google("X.Person@BrainPOP.test"))).toBe("editor");
  });

  it("gives way to a personal entry, which decides for that person either way", async () => {
    docs.set(member("boss@brainpop.test"), { email: "boss@brainpop.test", role: "admin" });
    docs.set(member("reader@brainpop.test"), { email: "reader@brainpop.test", role: "viewer" });
    expect(await roleOf(google("boss@brainpop.test"))).toBe("admin");
    expect(await roleOf(google("reader@brainpop.test"))).toBe("viewer");
  });

  it("stops admitting anyone the moment it is removed", async () => {
    expect(await roleOf(google("x@brainpop.test"))).toBe("editor");
    docs.set(config, { domains: {} });
    expect(await roleOf(google("x@brainpop.test"))).toBeNull();
  });

  it("that is malformed admits nobody, and locks nobody listed out", async () => {
    docs.set(config, { domains: "brainpop.test" });
    expect(await roleOf(google("x@brainpop.test"))).toBeNull();
    docs.set(config, { domains: ["brainpop.test"] });
    expect(await roleOf(google("x@brainpop.test"))).toBeNull();
    expect(await roleOf(google(MEMBERS.editor))).toBe("editor");
  });

  it("that names something other than a role admits nobody", async () => {
    docs.set(config, { domains: { [DOMAIN]: "superuser" } });
    expect(await roleOf(google("x@brainpop.test"))).toBeNull();
  });

  it("is absent altogether, and nobody unlisted is admitted", async () => {
    docs.delete(config);
    expect(await roleOf(google("x@brainpop.test"))).toBeNull();
  });

  it("is not fooled by a domain that is an inherited property name", async () => {
    docs.set(config, { domains: {} });
    expect(await roleOf(google("x@constructor"))).toBeNull();
    expect(await roleOf(google("x@__proto__"))).toBeNull();
  });
});

describe("the existing owner", () => {
  it("is an admin without being on the list, with or without an address", async () => {
    expect(await studioRoleFor(db, STUDY, { role: "owner", email: "Owner@Leeds.test" })).toEqual({
      role: "admin",
      email: "owner@leeds.test",
      reason: null,
    });
    expect(await roleOf({ role: "owner" })).toBe("admin");
    // Nothing is read for an owner: the claim decides.
    expect(reads).toEqual([]);
  });
});

describe("people not on the list", () => {
  it("signed out", async () => {
    expect(await studioRoleFor(db, STUDY, null)).toEqual({ role: null, email: null, reason: "not_signed_in" });
  });

  it("a verified Google account nobody listed", async () => {
    expect(await studioRoleFor(db, STUDY, google("stranger@example.org"))).toEqual({
      role: null,
      email: "stranger@example.org",
      reason: "not_listed",
    });
  });

  it("a listed address Google has not verified", async () => {
    expect(await studioRoleFor(db, STUDY, google(MEMBERS.editor, { email_verified: false }))).toMatchObject({
      role: null,
      reason: "email_not_verified",
    });
    expect(await roleOf({ email: MEMBERS.editor, firebase: { sign_in_provider: "google.com" } })).toBeNull();
    // Only the boolean true counts, as `== true` in the rules.
    expect(await roleOf(google(MEMBERS.editor, { email_verified: "true" }))).toBeNull();
  });

  it("a listed, verified address from any provider but Google", async () => {
    for (const provider of ["password", "custom", "github.com", "microsoft.com"]) {
      expect(await studioRoleFor(db, STUDY, google(MEMBERS.admin, { firebase: { sign_in_provider: provider } }))).toMatchObject({
        role: null,
        reason: "not_google",
      });
    }
    expect(await roleOf(google(MEMBERS.admin, { firebase: undefined }))).toBeNull();
  });

  it("an anonymous sign-in, even one claiming a listed address", async () => {
    expect(await roleOf(google(MEMBERS.admin, { firebase: { sign_in_provider: "anonymous" } }))).toBeNull();
  });

  it("an iPad, even one carrying a listed, verified Google address or an owner claim", async () => {
    expect(await roleOf(google(MEMBERS.admin, { device: true }))).toBeNull();
    expect(await roleOf({ device: true, role: "owner", email: "owner@leeds.test" })).toBeNull();
  });

  it("researchers and analysts, whose claims give them the sittings but not the Studio", async () => {
    for (const role of ["researcher", "analyst"]) {
      expect(await roleOf({ role })).toBeNull();
      expect(await roleOf(google(`${role}@example.org`, { role }))).toBeNull();
    }
  });

  it("someone removed from the list, on their very next call", async () => {
    const token = google(MEMBERS.editor);
    expect(await roleOf(token)).toBe("editor");
    docs.delete(member(MEMBERS.editor.toLowerCase()));
    // Same token, nothing remembered: the list is read every time.
    expect(await roleOf(token)).toBeNull();
  });

  it("an entry whose role is not a Studio role, even at an admitted domain", async () => {
    docs.set(member("odd@example.org"), { email: "odd@example.org", role: "superuser" });
    expect(await roleOf(google("odd@example.org"))).toBeNull();
    // A listed person's entry decides, even when it decides "nothing".
    docs.set(member("odd@brainpop.test"), { email: "odd@brainpop.test", role: "superuser" });
    expect(await roleOf(google("odd@brainpop.test"))).toBeNull();
  });
});

describe("anyone trying to pass for someone at the domain", () => {
  it("is matched on the exact domain, and nothing that merely contains it", async () => {
    for (const email of [
      "evil@brainpop.test.attacker.com",
      "evil@attacker.com#@brainpop.test",
      "evil@attacker.com@brainpop.test",
      "evil@sub.brainpop.test",
      "evil@xbrainpop.test",
      "brainpop.test@attacker.com",
      "evil@brainpop.testx",
    ]) {
      expect(await roleOf(google(email)), email).toBeNull();
    }
  });

  it("gains nothing from an unverified or non-Google account at the domain", async () => {
    expect(await roleOf(google("x@brainpop.test", { email_verified: false }))).toBeNull();
    expect(await roleOf(google("x@brainpop.test", { firebase: { sign_in_provider: "password" } }))).toBeNull();
  });

  it("cannot reach another document through the address", async () => {
    docs.set(`${paths.studioMembers(STUDY)}/x`, { role: "admin" });
    for (const email of ["a/../x@example.org", "evil@example.org/x", "__x@y__"]) {
      expect(await roleOf(google(email)), email).toBeNull();
    }
  });
});

describe("requireStudio", () => {
  const env = { db, study: STUDY };
  const request = (token: StudioToken, uid = "u_1") => ({ auth: { uid, token: token as never, rawToken: "" } });

  const refusal = async (promise: Promise<unknown>): Promise<HttpsError> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpsError) return error;
      throw error;
    }
    throw new Error("that was allowed, and it should not have been");
  };

  it("refuses somebody not signed in, saying what was needed", async () => {
    const error = await refusal(requireStudio({}, "viewer", env));
    expect(error.code).toBe("unauthenticated");
    expect(error.details).toEqual({ kind: "forbidden", needed: "viewer" });
  });

  it("refuses somebody below the role needed, and says both", async () => {
    const error = await refusal(requireStudio(request(google(MEMBERS.editor)), "publisher", env));
    expect(error.code).toBe("permission-denied");
    expect(error.details).toEqual({ kind: "forbidden", needed: "publisher" });
    expect(error.message).toMatch(/publisher/);
    expect(error.message).toMatch(/editor/);
  });

  it("refuses somebody not on the list, in words the unauthorised page can use", async () => {
    const error = await refusal(requireStudio(request(google("stranger@example.org")), "viewer", env));
    expect(error.code).toBe("permission-denied");
    expect(error.message).toMatch(/isn't on the MySelf Studio list/);
  });

  it("gives back the verified caller — uid from the token, address from the list key", async () => {
    await expect(requireStudio(request(google(MEMBERS.publisher), "u_pat"), "publisher", env)).resolves.toEqual({
      uid: "u_pat",
      email: "pat.publisher@example.org",
      role: "publisher",
      owner: false,
    });
    await expect(requireStudio(request({ role: "owner" }, "u_owner"), "admin", env)).resolves.toEqual({
      uid: "u_owner",
      email: null,
      role: "admin",
      owner: true,
    });
  });

  it("takes effect at once when somebody is removed", async () => {
    const req = request(google(MEMBERS.admin));
    await expect(requireStudio(req, "admin", env)).resolves.toMatchObject({ role: "admin" });
    docs.delete(member(MEMBERS.admin.toLowerCase()));
    expect((await refusal(requireStudio(req, "viewer", env))).code).toBe("permission-denied");
  });
});
