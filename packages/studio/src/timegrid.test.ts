import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ItemDefinition } from "@myself/schema";
import { questionType } from "./catalogue.js";
import type { Issue, StudioDraft } from "./contract.js";
import { extractDraft, previewRelease } from "./draft.js";
import { diffDrafts } from "./diff.js";
import { findQuestion } from "./model.js";
import * as ops from "./ops.js";
import { validateDraft } from "./validate.js";

/**
 * Time grids in the Studio: creatable, pointed at an earlier sorting or
 * multiple-choice question by default, and refused when the rows cannot be
 * worked out.
 */

const r730 = JSON.parse(readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json"), "utf8"));
const live = (): StudioDraft => extractDraft(r730);

/** A grid straight after the apps question, as a researcher would add one. */
function withGrid(): { draft: StudioDraft; itemKey: string } {
  return ops.addQuestion(live(), {
    sectionKey: "social_media",
    typeId: "time_grid",
    afterItemKey: "ybm_social_media.apps_owned",
    text: "On a typical day, how much time do you usually spend on each of the following apps?",
  });
}

function setRows(draft: StudioDraft, itemKey: string, rowsFrom: unknown): StudioDraft {
  return ops.updateQuestion(draft, itemKey, { rowsFrom } as ops.QuestionPatch).draft;
}

const codes = (issues: Issue[], itemKey: string) =>
  issues.filter((i) => i.severity === "error" && i.location.itemKey === itemKey).map((i) => i.code);

describe("time grids in the Studio", () => {
  it("is offered under numbers", () => {
    expect(questionType("time_grid")).toMatchObject({ canCreate: true, group: "number", responseType: "time_grid" });
  });

  it("takes its rows from the nearest sorting or multiple-choice question before it, and freezes cleanly", () => {
    const { draft, itemKey } = withGrid();
    const item = findQuestion(draft, itemKey)!.item as Extract<ItemDefinition, { responseType: "time_grid" }>;
    expect(item.rowsFrom).toEqual({ instrument: "ybm_social_media", item: "apps_owned", revision: 1, group: "have" });
    expect(ops.gridSources(draft, itemKey)[0]?.itemKey).toBe("ybm_social_media.apps_owned");
    expect(codes(validateDraft(draft), itemKey)).toEqual([]);
    const preview = previewRelease(draft);
    expect(preview.failures).toEqual([]);
    expect(preview.manifest!.release.engineVersion).toBe("0.5.0");
  });

  it("offers only questions asked before it", () => {
    const { draft, itemKey } = withGrid();
    const offered = ops.gridSources(draft, itemKey).map((s) => s.itemKey);
    expect(offered).toContain("ybm_social_media.apps_owned");
    expect(offered).not.toContain("ybm_social_media.functions"); // multiple choice, but asked after
    for (const s of ops.gridSources(draft, itemKey)) expect(["rank_group", "multi_choice"]).toContain(s.item.responseType);
  });

  it("asks for a source when there is none, or it is the grid itself", () => {
    const { draft, itemKey } = withGrid();
    const self = setRows(draft, itemKey, { instrument: "ybm_studio", item: itemKey.split(".")[1], revision: 1 });
    expect(codes(validateDraft(self), itemKey)).toContain("grid.source_missing");
    const gone = setRows(draft, itemKey, { instrument: "ybm_social_media", item: "no_such_question", revision: 1 });
    expect(codes(validateDraft(gone), itemKey)).toContain("grid.source_missing");
  });

  it("refuses a source asked later, of the wrong type, or a group it lacks", () => {
    const { draft, itemKey } = withGrid();
    const later = setRows(draft, itemKey, { instrument: "ybm_social_media", item: "functions", revision: 1 });
    expect(codes(validateDraft(later), itemKey)).toContain("grid.source_later");
    const single = setRows(draft, itemKey, { instrument: "ybm_social_media", item: "overuse", revision: 1 });
    expect(codes(validateDraft(single), itemKey)).toContain("grid.source_type");
    const group = setRows(draft, itemKey, { instrument: "ybm_social_media", item: "apps_owned", revision: 1, group: "maybe" });
    expect(codes(validateDraft(group), itemKey)).toContain("grid.group_missing");
    // The publish gate says the same, so the server refuses what the editor flags.
    expect(previewRelease(group).failures.join("\n")).toMatch(/rows come from group 'maybe'/);
  });

  it("counts a change of source as a change to what is asked", () => {
    const { draft, itemKey } = withGrid();
    const moved = setRows(draft, itemKey, { instrument: "ybm_social_media", item: "apps_owned", revision: 1, group: "dont_have" });
    const summary = diffDrafts(draft, moved);
    expect(JSON.stringify(summary)).toContain("answer options");
  });
});
