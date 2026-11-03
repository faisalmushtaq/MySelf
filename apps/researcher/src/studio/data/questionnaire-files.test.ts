import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDraft, questionnaireDocument, questionnaireFilename } from "@myself/studio";
import { questionnaireDocx, questionnairePdf } from "./questionnaire-files.js";

/** The Word and PDF questionnaires for a version (D-76), from a real release. */
const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../../../releases/candidates/ybm_nd2026_standard_r9.0.0.manifest.json"), "utf8"));
const meta = {
  study: "ybm",
  surveyId: "ybm_nd2026_standard",
  version: "9.0.0",
  hash: raw.hash,
  publishedAt: "2026-09-29T23:02:00.000Z",
  publishedBy: "researcher@example.org",
  releaseNote: "A note 🎉 with an emoji",
  changeSummary: null,
  basedOnVersion: "8.0.0",
};
const doc = questionnaireDocument(extractDraft(raw), meta);
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe("the questionnaire as files", () => {
  it("is a Word file (a zip with a document part) that holds the questions", async () => {
    const out = await bytes(await questionnaireDocx(doc));
    expect(String.fromCharCode(out[0]!, out[1]!)).toBe("PK");
    const { unzipSync, strFromU8 } = await import("fflate");
    const xml = strFromU8(unzipSync(out)["word/document.xml"]!);
    expect(xml).toContain("Several times a day");
    expect(xml).toContain("ai_use_frequency");
    expect(xml).toContain("🎉");
  });

  it("is a PDF", async () => {
    const out = await bytes(await questionnairePdf(doc));
    expect(new TextDecoder().decode(out.slice(0, 5))).toBe("%PDF-");
    expect(out.length).toBeGreaterThan(20_000);
  });

  it("is named after the survey and version", () => {
    expect(questionnaireFilename(meta, "docx")).toBe("ybm_nd2026_standard_v9.0.0_questionnaire.docx");
  });
});
