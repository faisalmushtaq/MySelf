import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDraft } from "./draft.js";
import { questionnaireHtml, type QuestionnaireMeta } from "./questionnaire.js";

const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../releases/candidates/ybm_nd2026_standard_r9.0.0.manifest.json"), "utf8"));
const meta: QuestionnaireMeta = {
  study: "ybm",
  surveyId: "ybm_nd2026_standard",
  version: "12.0.0",
  hash: raw.hash,
  publishedAt: "2026-10-10T21:00:00.000Z",
  publishedBy: "researcher@example.org",
  releaseNote: "Adds <AI> questions & more",
  changeSummary: { bump: "major", counts: { added: 1, removed: 0, archived: 0, changed: 0, moved: 0 }, entries: [{ kind: "question.added", bump: "minor", breaking: false, message: "Added “How often…”" }] },
  basedOnVersion: "11.0.0",
};

describe("the readable questionnaire (D-60)", () => {
  const html = questionnaireHtml(extractDraft(raw), meta);

  it("says which version it is, by whom, and what changed", () => {
    expect(html).toContain("12.0.0");
    expect(html).toContain(raw.hash);
    expect(html).toContain("researcher@example.org");
    expect(html).toContain("Added “How often…”");
  });

  it("escapes what it is given", () => {
    expect(html).toContain("Adds &lt;AI&gt; questions &amp; more");
    expect(html).not.toContain("<AI>");
  });

  it("lists questions with variables, option codes and conditions in words", () => {
    expect(html).toContain("ai_use_frequency");
    expect(html).toContain("Several times a day");
    expect(html).toContain("Talking about my feelings or when I&#39;m upset");
    expect(html).toMatch(/Shown only if/);
    expect(html).toContain("Moves on by itself once every statement is ticked.");
  });
});
