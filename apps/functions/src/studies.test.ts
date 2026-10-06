import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

/**
 * Which study a request is for (D-56, docs/16 §11.4–§11.5).
 *
 * Every function that takes a study goes through this before it reads
 * anything else, so what it refuses is what nothing downstream can be asked
 * to file, count or register. The registry is stood in for by a map: what is
 * worth proving is the three answers and the default's implicit registration,
 * not Firestore.
 */

vi.mock("firebase-functions/logger", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn(), write: vi.fn() }));
vi.mock("./apps.js", () => ({ STUDY: "ybm", REGION: "europe-west2", research: () => null, auth: () => null, identity: () => null }));

const { lookupStudy, registeredStudies, statusOf, studyForCall, studyForRequest } = await import("./studies.js");
const { RelayError } = await import("./relay-policy.js");

/** A registry: `studies/{id}` documents, and anything else a test puts there. */
function registry(docs: Record<string, Record<string, unknown>> = {}) {
  const reads: string[] = [];
  const db = {
    doc: (path: string) => ({
      get: async () => {
        reads.push(path);
        return { exists: path in docs, data: () => docs[path] };
      },
    }),
    collection: (path: string) => ({
      get: async () => ({
        docs: Object.entries(docs)
          .filter(([p]) => p.startsWith(`${path}/`) && p.split("/").length === 2)
          .map(([p, data]) => ({ id: p.split("/")[1]!, data: () => data })),
      }),
    }),
  } as unknown as Firestore;
  return { db, reads };
}

const future = { study: "future", title: "Perspectives of the future", status: "open" };

describe("looking a study up", () => {
  it("takes no study as the default, registered with no document at all", async () => {
    const { db } = registry();
    const found = await lookupStudy(db, undefined);
    expect(found).toEqual({
      kind: "registered",
      study: { study: "ybm", title: null, status: "open", implicit: true, isDefault: true },
    });
  });

  it("lets the default's document decide once an owner has given it one", async () => {
    const { db } = registry({ "studies/ybm": { study: "ybm", title: "YBM", status: "closed" } });
    expect(await lookupStudy(db, "ybm")).toMatchObject({ kind: "registered", study: { status: "closed", implicit: false, title: "YBM" } });
  });

  it("finds a registered study space by its document", async () => {
    const { db } = registry({ "studies/future": future });
    expect(await lookupStudy(db, "future")).toMatchObject({
      kind: "registered",
      study: { study: "future", title: "Perspectives of the future", status: "open", isDefault: false },
    });
  });

  it("calls a well-formed id with no document unknown: a request never creates a study", async () => {
    const { db } = registry();
    expect(await lookupStudy(db, "future")).toEqual({ kind: "unknown", study: "future" });
  });

  it.each([["Future"], ["ybm/sessions"], [".."], ["__name__"], ["a"], [42], [{}]])(
    "refuses %j before asking Firestore",
    async (raw) => {
      const { db, reads } = registry();
      expect((await lookupStudy(db, raw)).kind).toBe("malformed");
      expect(reads).toEqual([]);
    },
  );

  it("reads anything but exactly 'open' as closed, so a typo fails closed", () => {
    expect(statusOf("open")).toBe("open");
    for (const value of ["closed", "Open", "opened", undefined, null, 1]) expect(statusOf(value)).toBe("closed");
  });
});

describe("refusing for a device-facing endpoint", () => {
  it("says 404 for an unknown study, in words for whoever reads a sync panel", async () => {
    const { db } = registry();
    const error = await studyForRequest(db, "nowhere").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ status: 404 });
    expect((error as Error).message).toMatch(/safe/);
  });

  it("says 400 for something that is not an id", async () => {
    const { db } = registry();
    await expect(studyForRequest(db, "../ybm")).rejects.toMatchObject({ status: 400 });
  });

  it("returns a closed study as closed, for the endpoint to decide what that stops", async () => {
    const { db } = registry({ "studies/future": { ...future, status: "closed" } });
    expect(await studyForRequest(db, "future")).toMatchObject({ study: "future", status: "closed" });
  });
});

describe("refusing for a callable", () => {
  it("throws HttpsErrors, so the callable's caller reads a code", async () => {
    const { db } = registry();
    const unknown = await studyForCall(db, "nowhere").catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(HttpsError);
    expect((unknown as HttpsError).code).toBe("not-found");
    expect(((await studyForCall(db, 7).catch((e: unknown) => e)) as HttpsError).code).toBe("invalid-argument");
    expect((await studyForCall(db, undefined)).study).toBe("ybm");
  });
});

describe("every registered study", () => {
  it("is each document and the default, the default first", async () => {
    const { db } = registry({ "studies/zeta": { title: "Z", status: "open" }, "studies/future": future });
    expect((await registeredStudies(db)).map((s) => s.study)).toEqual(["ybm", "future", "zeta"]);
  });

  it("ignores a document whose id is no study id", async () => {
    const { db } = registry({ "studies/Bad Id": { title: "?" }, "studies/future": future });
    expect((await registeredStudies(db)).map((s) => s.study)).toEqual(["ybm", "future"]);
  });

  it("uses the default's own document when it has one", async () => {
    const { db } = registry({ "studies/ybm": { title: "Yorkshire Brain Map", status: "open" } });
    expect(await registeredStudies(db)).toEqual([
      { study: "ybm", title: "Yorkshire Brain Map", status: "open", implicit: false, isDefault: true },
    ]);
  });
});
