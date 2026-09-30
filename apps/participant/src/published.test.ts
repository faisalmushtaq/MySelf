import { describe, expect, it } from "vitest";
import { studySource } from "./lib/published.js";

/**
 * Reading the live version over Firestore's REST API. What matters is the
 * difference between "the study says there is none", which is an answer, and
 * "the study could not be asked", which is not, because the device does
 * different things for each (lib/versions.ts).
 */

const HASH = `sha256:${"a".repeat(64)}`;
const study = { host: "https://firestore.googleapis.com", project: "myself-research", study: "ybm" };

function transport(reply: { status?: number; body: unknown }) {
  const calls: { url: string; body: { documents: string[] } }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) as { documents: string[] } });
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("the study's published versions, over REST", () => {
  it("names the document in the body, so a hash with a colon in it is only a name", async () => {
    const t = transport({ body: [{ missing: "x", readTime: "2026-10-01T00:00:00Z" }] });
    await studySource(study, t.fetcher).release(HASH);
    expect(t.calls[0]!.url).toBe(
      "https://firestore.googleapis.com/v1/projects/myself-research/databases/(default)/documents:batchGet",
    );
    expect(t.calls[0]!.body.documents).toEqual([
      `projects/myself-research/databases/(default)/documents/studies/ybm/releases/${HASH}`,
    ]);
  });

  it("reads the active-version pointer, typed values and all", async () => {
    const t = transport({
      body: [
        {
          found: {
            name: "projects/myself-research/databases/(default)/documents/studies/ybm/config/activeRelease",
            fields: {
              hash: { stringValue: HASH },
              version: { stringValue: "10.0.0" },
              key: { stringValue: "ybm_nd2026_standard_r10_0_0" },
              activatedAt: { stringValue: "2026-10-01T09:00:00.000Z" },
              activatedBy: { stringValue: "owner@example.ac.uk" },
            },
          },
        },
      ],
    });
    const active = await studySource(study, t.fetcher).activeRelease();
    expect(active).toEqual({
      hash: HASH,
      version: "10.0.0",
      key: "ybm_nd2026_standard_r10_0_0",
      activatedAt: "2026-10-01T09:00:00.000Z",
      activatedBy: "owner@example.ac.uk",
    });
    expect(t.calls[0]!.body.documents[0]).toMatch(/studies\/ybm\/config\/activeRelease$/);
  });

  it("decodes every kind of value a document can hold", async () => {
    const t = transport({
      body: [
        {
          found: {
            fields: {
              s: { stringValue: "x" },
              i: { integerValue: "42" },
              d: { doubleValue: 0.5 },
              b: { booleanValue: true },
              t: { timestampValue: "2026-10-01T09:00:00Z" },
              n: { nullValue: null },
              m: { mapValue: { fields: { inner: { stringValue: "y" } } } },
              a: { arrayValue: { values: [{ integerValue: "1" }, { stringValue: "z" }] } },
              e: { arrayValue: {} },
            },
          },
        },
      ],
    });
    expect(await studySource(study, t.fetcher).release(HASH)).toEqual({
      s: "x",
      i: 42,
      d: 0.5,
      b: true,
      t: "2026-10-01T09:00:00Z",
      n: null,
      m: { inner: "y" },
      a: [1, "z"],
      e: [],
    });
  });

  it("says there is none when the study has none", async () => {
    const t = transport({ body: [{ missing: "…/activeRelease", readTime: "2026-10-01T00:00:00Z" }] });
    expect(await studySource(study, t.fetcher).activeRelease()).toBeNull();
  });

  it("throws, rather than answering, when the reply is not the study's", async () => {
    // A school guest network's sign-in page, a server error, a pointer in the
    // wrong shape: none of these is the study saying nothing is live.
    await expect(studySource(study, transport({ body: "<html>Sign in</html>" }).fetcher).activeRelease()).rejects.toThrow(
      /did not come from the study/,
    );
    await expect(studySource(study, transport({ status: 503, body: {} }).fetcher).activeRelease()).rejects.toThrow(/503/);
    await expect(
      studySource(study, transport({ body: [{ found: { fields: { hash: { stringValue: "not a hash" } } } }] }).fetcher).activeRelease(),
    ).rejects.toThrow(/expected shape/);
  });
});
