import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRelease, contentHash } from "@myself/release";
import { compileDraft, emptyDraft, extractDraft, parseDraft, previewRelease, serialiseDraft } from "./draft.js";

const r710 = JSON.parse(
  readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json"), "utf8"),
) as { hash: string; release: { version: string; publishedAt: string; publishedBy: string; engineVersion: string; decisionRefs?: string[] } };

describe("a release opened in the Studio", () => {
  it("publishes back to exactly the same release when nothing is changed", () => {
    // The property everything else rests on: opening the live survey and
    // publishing it untouched must reproduce it byte for byte, not a
    // normalised lookalike with a new hash.
    const draft = extractDraft(r710);
    const { composition, registries } = compileDraft(draft);
    const rebuilt = buildRelease(composition, registries, {
      version: r710.release.version,
      publishedAt: r710.release.publishedAt,
      publishedBy: r710.release.publishedBy,
      engineVersion: r710.release.engineVersion,
      ...(r710.release.decisionRefs ? { decisionRefs: r710.release.decisionRefs } : {}),
    });
    expect(rebuilt.hash).toBe(r710.hash);
  });

  it("survives being stored and read back", () => {
    const draft = extractDraft(r710);
    expect(parseDraft(serialiseDraft(draft))).toEqual(draft);
  });

  it("previews without gate failures", () => {
    const preview = previewRelease(extractDraft(r710));
    expect(preview.error).toBeNull();
    expect(preview.failures).toEqual([]);
    expect(preview.manifest?.composition.sections).toHaveLength(9);
  });
});

describe("a blank survey", () => {
  it("freezes cleanly, placing its first question by subset", () => {
    const draft = emptyDraft({ surveyId: "pilot_2027", study: "ybm", title: "Pilot" });
    const preview = previewRelease(draft);
    expect(preview.error).toBeNull();
    expect(preview.failures).toEqual([]);
    expect(preview.manifest?.release.engineVersion).toBe("0.2.0");
    expect(contentHash(preview.manifest)).toMatch(/^sha256:/);
  });
});

describe("parseDraft", () => {
  it("refuses a document that is not a Studio draft", () => {
    expect(() => parseDraft("{}")).toThrow(/not a MySelf Studio draft/);
    expect(() => parseDraft("nope")).toThrow(/not valid JSON/);
  });
});
