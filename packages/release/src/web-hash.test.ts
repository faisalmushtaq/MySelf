import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson as browserCanonicalJson, manifestContentHash } from "@myself/schema";
import { canonicalJson, contentHash } from "./canonical.js";

/**
 * Two implementations of one hash, held to the same answer.
 *
 * `canonical.ts` here is what cuts a release, and the dashboard vendors it
 * unchanged. It uses Node's `crypto`, so the iPad, the researcher view and the
 * functions check a published version (D-54) with a WebCrypto copy in
 * `@myself/schema`. If the two ever disagreed, a version published from the
 * dashboard would be refused everywhere, or worse, a changed one accepted. So
 * both run over every manifest in `releases/`, and must agree byte for byte.
 */

const DIR = fileURLToPath(new URL("../../../releases/", import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith(".manifest.json"));

describe("the browser's canonical JSON and hash", () => {
  it.each(files)("agree with the release builder's on %s", async (file) => {
    const manifest = JSON.parse(readFileSync(`${DIR}${file}`, "utf8")) as Record<string, unknown>;
    const { hash: _hash, ...body } = manifest;
    expect(browserCanonicalJson(body)).toBe(canonicalJson(body));
    expect(await manifestContentHash(manifest)).toBe(contentHash(body));
  });

  it("agree on the awkward cases: undefined members, unicode, nesting, empty containers", async () => {
    const awkward = { b: [1, { z: undefined, a: "é — “quoted”" }], a: {}, c: [], d: null, e: 0.5, "é": true };
    expect(browserCanonicalJson(awkward)).toBe(canonicalJson(awkward));
    expect(await manifestContentHash(awkward)).toBe(contentHash(awkward));
  });
});
