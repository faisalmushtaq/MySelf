import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HttpsError } from "firebase-functions/v2/https";
import consumerDomains from "./consumer-domains.json" with { type: "json" };
import { CONSUMER_DOMAINS, domainKey, emailKey, isConsumerDomain, isDomainKey, isEmailKey } from "./domains.js";
import { parseRequest } from "./errors.js";
import {
  activateVersionRequest,
  createStudyRequest,
  createSurveyRequest,
  importLiveRequest,
  publishRequest,
  restoreVersionRequest,
  setDomainRequest,
  setMemberRequest,
  setStudyRequest,
} from "./requests.js";

/**
 * What the Studio callables accept, before anything is read.
 *
 * Every value here ends up in a document path or a stored record, so the
 * tests are mostly about what is turned away: anything that could name another
 * document, and anything a browser might send that is not what it claims.
 */

const refusal = (fn: () => unknown): HttpsError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpsError) return error;
    throw error;
  }
  throw new Error("accepted, and it should not have been");
};

describe("a request that does not match", () => {
  it("is refused as invalid-argument, with one located issue per field, in words", () => {
    const error = refusal(() => parseRequest(publishRequest, { surveyId: "Bad/Id", expectedRevision: 0, version: "8", releaseNote: "" }));
    expect(error.code).toBe("invalid-argument");
    const details = error.details as { kind: string; issues: { code: string; message: string; location: { field?: string } }[]; gate: string[] };
    expect(details.kind).toBe("invalid");
    expect(details.gate).toEqual([]);
    expect(details.issues.map((i) => i.location.field).sort()).toEqual(["expectedRevision", "releaseNote", "surveyId", "version"]);
    expect(details.issues.every((i) => i.code === "request.invalid")).toBe(true);
    expect(error.message).toMatch(/version: must be a version number/);
  });

  it("is refused when there is no request at all", () => {
    expect(refusal(() => parseRequest(importLiveRequest, undefined)).code).toBe("invalid-argument");
  });
});

describe("survey IDs and versions", () => {
  it("accept what the Studio sends", () => {
    expect(parseRequest(importLiveRequest, { surveyId: "ybm_nd2026_standard" })).toEqual({ surveyId: "ybm_nd2026_standard" });
    expect(parseRequest(restoreVersionRequest, { surveyId: "s1", version: "7.1.0", expectedRevision: 3 })).toEqual({
      surveyId: "s1",
      version: "7.1.0",
      expectedRevision: 3,
    });
  });

  it("refuse anything that could name another document", () => {
    for (const surveyId of ["", "A", "1abc", "a/b", "a.b", "..", "a b", "a".repeat(65), "__x__"]) {
      expect(() => parseRequest(importLiveRequest, { surveyId }), surveyId).toThrow(HttpsError);
    }
    for (const version of ["", "8", "8.0", "r8.0.0", "8.0.0/x", "08.0.0", "8.0.0-beta", "..", "1.2.3.4", "9999999.0.0"]) {
      expect(() => parseRequest(restoreVersionRequest, { surveyId: "s1", version, expectedRevision: 1 }), version).toThrow(HttpsError);
    }
  });

  it("refuse a revision that is not a whole number above zero", () => {
    for (const expectedRevision of [0, -1, 1.5, "3", null, Number.NaN]) {
      expect(() => parseRequest(publishRequest, { surveyId: "s1", version: "8.0.0", releaseNote: "x", expectedRevision })).toThrow(HttpsError);
    }
  });

  it("hold a new survey ID to what the New survey dialog allows", () => {
    expect(parseRequest(createSurveyRequest, { surveyId: "abc", title: "  A title  " })).toEqual({ surveyId: "abc", title: "A title" });
    for (const surveyId of ["ab", "a".repeat(49), "Abc", "a-b"]) {
      expect(() => parseRequest(createSurveyRequest, { surveyId, title: "T" }), surveyId).toThrow(HttpsError);
    }
    expect(() => parseRequest(createSurveyRequest, { surveyId: "abc", title: "   " })).toThrow(HttpsError);
    expect(parseRequest(createSurveyRequest, { surveyId: "abc", title: "T", from: { surveyId: "ybm_nd2026_standard", version: "7.1.0" } }).from).toEqual({
      surveyId: "ybm_nd2026_standard",
      version: "7.1.0",
    });
  });

  it("need a reason of at least ten characters to roll back", () => {
    expect(() => parseRequest(activateVersionRequest, { surveyId: "s1", version: "7.0.1", reason: "  oops     " })).toThrow(HttpsError);
    expect(parseRequest(activateVersionRequest, { surveyId: "s1", version: "7.0.1", reason: " r8 shows a blank screen " }).reason).toBe(
      "r8 shows a blank screen",
    );
  });

  it("take nothing about the caller from the request", () => {
    const parsed = parseRequest(publishRequest, {
      surveyId: "s1",
      expectedRevision: 2,
      version: "8.0.0",
      releaseNote: "note",
      uid: "u_admin",
      email: "ada@example.org",
      role: "admin",
      publishedAt: "2020-01-01",
    });
    expect(Object.keys(parsed).sort()).toEqual(["expectedRevision", "releaseNote", "surveyId", "version"]);
  });
});

describe("addresses and domains", () => {
  it("are keyed as the rules look them up: trimmed and lower-cased", () => {
    expect(parseRequest(setMemberRequest, { email: "  Ada.Admin@Example.ORG ", role: "admin" }).email).toBe("ada.admin@example.org");
    expect(emailKey(" X@Y.Z ")).toBe("x@y.z");
    expect(parseRequest(setDomainRequest, { domain: " @BrainPOP.com ", role: "editor" }).domain).toBe("brainpop.com");
    expect(domainKey("@Example.ORG")).toBe("example.org");
  });

  it("refuse anything that is not an address or a domain, or could shape a path", () => {
    for (const email of ["", "nobody", "a@b", "a@@b.com", "a b@c.com", "a/b@c.com", "a@b.com/x", "__a@b.c__"]) {
      expect(isEmailKey(emailKey(email)), email).toBe(false);
    }
    for (const domain of ["", "com", "brainpop", "a@b.com", "brain pop.com", "-x.com", "x-.com", "a/b.com", "b.c1"]) {
      expect(isDomainKey(domainKey(domain)), domain).toBe(false);
    }
    expect(() => parseRequest(setMemberRequest, { email: "someone", role: "viewer" })).toThrow(HttpsError);
    expect(() => parseRequest(setMemberRequest, { email: "a@b.com", role: "owner" })).toThrow(HttpsError);
    expect(parseRequest(setMemberRequest, { email: "a@b.com", role: null })).toEqual({ email: "a@b.com", role: null });
  });

  it("know the public mail providers, which may not be domain rules", () => {
    for (const d of ["gmail.com", "GMail.com", "@outlook.com", "hotmail.co.uk", "icloud.com"]) expect(isConsumerDomain(d), d).toBe(true);
    for (const d of ["leeds.ac.uk", "brainpop.com"]) expect(isConsumerDomain(d), d).toBe(false);
  });
});

describe("the public mail providers", () => {
  it("are one list, shared with the studio-access command line", () => {
    const cli = readFileSync(new URL("../../studio-access.mjs", import.meta.url), "utf8");
    expect(cli).toMatch(/import consumerDomains from "\.\/src\/studio\/consumer-domains\.json" with \{ type: "json" \}/);
    expect(cli).toMatch(/const CONSUMER_DOMAINS = new Set\(consumerDomains\)/);
    // No second, inline list to drift from this one.
    expect(cli).not.toMatch(/"gmail\.com"/);
    expect([...CONSUMER_DOMAINS].sort()).toEqual([...consumerDomains].sort());
    expect(consumerDomains.every((d) => isDomainKey(d))).toBe(true);
  });

  it("include every one the Studio's Settings page refuses before asking", () => {
    // The page checks first only to save a round trip; the server is the
    // control, so it must refuse at least everything the page does.
    const page = readFileSync(new URL("../../../researcher/src/studio/screens/Access.tsx", import.meta.url), "utf8");
    const block = /const CONSUMER = new Set\(\[([\s\S]*?)\]\)/.exec(page)?.[1] ?? "";
    const listed = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThan(5);
    for (const d of listed) expect(CONSUMER_DOMAINS.has(d), d).toBe(true);
  });
});

describe("a study space's id and settings (D-56)", () => {
  it("takes the participant link's pattern and nothing else", () => {
    expect(parseRequest(createStudyRequest, { study: "future", title: "  Perspectives of the future " })).toEqual({
      study: "future",
      title: "Perspectives of the future",
    });
    for (const study of ["Future", "f", "future/x", "..", "__name__", `a${"b".repeat(40)}`]) {
      expect(refusal(() => parseRequest(createStudyRequest, { study, title: "T" })).code).toBe("invalid-argument");
    }
    expect(refusal(() => parseRequest(createStudyRequest, { study: "future", title: " " })).code).toBe("invalid-argument");
  });

  it("changes a title, a status or both, and refuses a request that changes neither", () => {
    expect(parseRequest(setStudyRequest, { study: "future", status: "closed" })).toEqual({ study: "future", status: "closed" });
    expect(refusal(() => parseRequest(setStudyRequest, { study: "future" })).code).toBe("invalid-argument");
    expect(refusal(() => parseRequest(setStudyRequest, { study: "future", status: "deleted" })).code).toBe("invalid-argument");
  });
});
