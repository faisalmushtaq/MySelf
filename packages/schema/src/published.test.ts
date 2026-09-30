import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  engineCanRun,
  manifestContentHash,
  openPublishedManifest,
  openPublishedRelease,
  publishedPaths,
} from "./published.js";

/**
 * A version published from the dashboard is used only when it is exactly what
 * it says it is. These are the checks every reader of the database relies on.
 */

const json = readFileSync(
  fileURLToPath(new URL("../../../releases/ybm_nd2026_standard_r9.0.0.manifest.json", import.meta.url)),
  "utf8",
);
const r9 = JSON.parse(json) as { hash: string; release: { version: string; engineVersion: string } };

const doc = (over: Record<string, unknown> = {}) => ({
  hash: r9.hash,
  version: "9.0.0",
  key: "ybm_nd2026_standard_r9_0_0",
  study: "ybm",
  publishedAt: "2026-09-29T23:02:00.000Z",
  publishedBy: "someone@leeds.ac.uk",
  engineVersion: "0.3.0",
  manifestJson: json,
  source: "editor",
  ...over,
});

describe("the content hash, computed in the browser's way", () => {
  it("agrees with the hash a committed release carries", async () => {
    expect(await manifestContentHash(r9)).toBe(r9.hash);
  });

  it("ignores how the JSON is laid out, and nothing else", async () => {
    // Key order and whitespace are not content; one changed character is.
    const reverse = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverse)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)]))
          : value;
    const reordered = JSON.parse(JSON.stringify(reverse(r9), null, 4)) as unknown;
    expect(Object.keys(reordered as object)[0]).toBe("hash");
    expect(await manifestContentHash(reordered)).toBe(r9.hash);
    const edited = { ...r9, release: { ...r9.release, version: "9.0.1" } };
    expect(await manifestContentHash(edited)).not.toBe(r9.hash);
  });
});

describe("opening a published version", () => {
  it("accepts a manifest that is what it says it is", async () => {
    const opened = await openPublishedRelease(doc(), { engineVersion: "0.3.0" });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.manifest.release.version).toBe("9.0.0");
  });

  it("refuses one whose content was changed after it was hashed", async () => {
    const tampered = json.replace("brainpop@leeds.ac.uk", "someone.else@example.com");
    expect(tampered).not.toBe(json);
    const opened = await openPublishedRelease(doc({ manifestJson: tampered }));
    expect(opened).toMatchObject({ ok: false, problem: expect.stringMatching(/hashes to/) });
  });

  it("refuses one asked for under a different hash", async () => {
    const other = `sha256:${"0".repeat(64)}`;
    expect(await openPublishedRelease(doc(), { expectedHash: other })).toMatchObject({ ok: false });
    expect(await openPublishedManifest(json, other)).toMatchObject({ ok: false });
  });

  it("refuses one this engine cannot run", async () => {
    const opened = await openPublishedRelease(doc(), { engineVersion: "0.2.9" });
    expect(opened).toMatchObject({ ok: false, problem: expect.stringMatching(/needs engine 0\.3\.0/) });
  });

  it("refuses what is not JSON, or not a published-version document", async () => {
    expect(await openPublishedRelease(doc({ manifestJson: "{not json" }))).toMatchObject({ ok: false });
    expect(await openPublishedRelease({ hash: r9.hash })).toMatchObject({ ok: false });
    expect(await openPublishedRelease(null)).toMatchObject({ ok: false });
  });

  it("reads provenance loosely, so a timestamp where a string was expected changes nothing", async () => {
    const opened = await openPublishedRelease(doc({ publishedAt: { seconds: 1, nanoseconds: 0 }, notes: undefined }));
    expect(opened.ok).toBe(true);
  });
});

describe("which engine can run which release", () => {
  it("runs the same MAJOR with a MINOR no newer than its own, whatever the PATCH", () => {
    expect(engineCanRun("0.3.0", "0.3.0")).toBe(true);
    expect(engineCanRun("0.3.0", "0.2.0")).toBe(true);
    expect(engineCanRun("0.3.0", "0.3.7")).toBe(true);
    expect(engineCanRun("0.3.2", "0.1.0")).toBe(true);
  });

  it("refuses a newer MINOR, another MAJOR, or a version it cannot read", () => {
    expect(engineCanRun("0.3.0", "0.4.0")).toBe(false);
    expect(engineCanRun("0.3.0", "1.0.0")).toBe(false);
    expect(engineCanRun("1.3.0", "0.3.0")).toBe(false);
    expect(engineCanRun("0.3.0", "latest")).toBe(false);
  });
});

describe("where published versions live", () => {
  it("is the layout the dashboard writes (D-54)", () => {
    expect(publishedPaths.releases("ybm")).toBe("studies/ybm/releases");
    expect(publishedPaths.release("ybm", r9.hash)).toBe(`studies/ybm/releases/${r9.hash}`);
    expect(publishedPaths.activeRelease("ybm")).toBe("studies/ybm/config/activeRelease");
  });
});
