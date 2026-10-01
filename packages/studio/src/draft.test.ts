import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRelease, contentHash } from "@myself/release";
import { compileDraft, emptyDraft, extractDraft, parseDraft, previewRelease, serialiseDraft } from "./draft.js";

const r730 = JSON.parse(
  readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json"), "utf8"),
) as { hash: string; release: { version: string; publishedAt: string; publishedBy: string; engineVersion: string; decisionRefs?: string[] } };

describe("a release opened in the Studio", () => {
  it("publishes back to exactly the same release when nothing is changed", () => {
    // The property everything else rests on: opening the live survey and
    // publishing it untouched must reproduce it byte for byte, not a
    // normalised lookalike with a new hash.
    const draft = extractDraft(r730);
    const { composition, registries } = compileDraft(draft);
    const rebuilt = buildRelease(composition, registries, {
      version: r730.release.version,
      publishedAt: r730.release.publishedAt,
      publishedBy: r730.release.publishedBy,
      engineVersion: r730.release.engineVersion,
      ...(r730.release.decisionRefs ? { decisionRefs: r730.release.decisionRefs } : {}),
    });
    expect(rebuilt.hash).toBe(r730.hash);
  });

  it("does the same for every release from r7.2.0, including r8.0.0's age conditions and the r9.0.0 candidate's street list", () => {
    // Earlier releases carry the SWEMWBS and STAI-5 scoring r7.2.0 fixed, which the gate now refuses.
    // r9.0.0 is a candidate (releases/candidates/): the Studio must open it as cleanly once it is approved.
    for (const version of ["7.2.0", "7.3.0", "8.0.0", "candidates/9.0.0"]) {
      const file = version.startsWith("candidates/")
        ? `candidates/ybm_nd2026_standard_r${version.slice("candidates/".length)}.manifest.json`
        : `ybm_nd2026_standard_r${version}.manifest.json`;
      const raw = JSON.parse(readFileSync(resolve(__dirname, `../../../releases/${file}`), "utf8")) as typeof r730;
      const draft = parseDraft(serialiseDraft(extractDraft(raw)));
      const { composition, registries } = compileDraft(draft);
      const rebuilt = buildRelease(composition, registries, {
        version: raw.release.version,
        publishedAt: raw.release.publishedAt,
        publishedBy: raw.release.publishedBy,
        engineVersion: raw.release.engineVersion,
        ...(raw.release.decisionRefs ? { decisionRefs: raw.release.decisionRefs } : {}),
      });
      expect(rebuilt.hash, version).toBe(raw.hash);
      // What the Studio would declare for it on its own is what was declared.
      expect(previewRelease(draft).manifest?.release.engineVersion, version).toBe(raw.release.engineVersion);
    }
  });

  it("survives being stored and read back", () => {
    const draft = extractDraft(r730);
    expect(parseDraft(serialiseDraft(draft))).toEqual(draft);
  });

  it("previews without gate failures", () => {
    const preview = previewRelease(extractDraft(r730));
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
