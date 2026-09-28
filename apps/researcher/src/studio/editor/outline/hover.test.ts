import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDraft, outline, validateDraft } from "@myself/studio";
import { dragItemOf, resolveHover } from "./hover.js";
import { blockExpandKey, buildTree, indexIssues } from "./model.js";

const r710 = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json"), "utf8"));
const draft = extractDraft(r710);
const o = outline(draft);
const sdq = o.sections.find((s) => s.key === "wellbeing")!.blocks[1]!;
const open = new Map([[blockExpandKey("wellbeing", sdq.refKey), true]]);
const tree = buildTree(o, indexIssues(validateDraft(draft)), { query: "", withProblems: false, withConditions: false, expanded: open, canEdit: true });
const node = (id: string) => tree.byId.get(id)!;
const gamingFirst = o.sections.find((s) => s.key === "gaming")!.blocks[0]!.questions[0]!.itemKey;

describe("where a drop lands, and where its line is drawn", () => {
  it("draws a question dropped at the top of someone else's licensed block above the block's header", () => {
    const hover = resolveHover(o, node("sdq25_s.q1"), true, { kind: "question", itemKey: gamingFirst }, "ybm_gaming");
    expect(hover).toEqual({
      over: { kind: "block", sectionKey: "wellbeing", componentIndex: 1, edge: "before" },
      indicator: { id: "block:wellbeing:1", edge: "before" },
    });
  });

  it("drops a question between two questions as it is drawn", () => {
    const hover = resolveHover(o, node("sdq25_s.q4"), false, { kind: "question", itemKey: gamingFirst }, "ybm_gaming");
    expect(hover).toEqual({ over: { kind: "question", itemKey: "sdq25_s.q4", edge: "after" }, indicator: { id: "sdq25_s.q4", edge: "after" } });
  });

  it("treats the lower half of an open block's header as before the block", () => {
    const hover = resolveHover(o, node("block:wellbeing:1"), false, { kind: "question", itemKey: gamingFirst }, "ybm_gaming");
    expect(hover?.over).toEqual({ kind: "block", sectionKey: "wellbeing", componentIndex: 1, edge: "before" });
  });

  it("offers a block only the edges of other blocks", () => {
    const drag = dragItemOf(node("block:sleep:0"))!;
    expect(resolveHover(o, node("sdq25_s.q4"), true, drag, "kss")).toBeNull();
    expect(resolveHover(o, node("sdq25_s.q25"), false, drag, "kss")?.over).toEqual({ kind: "block", sectionKey: "wellbeing", componentIndex: 1, edge: "after" });
    const gaming = o.sections.find((s) => s.key === "gaming")!.blocks[0]!.questions;
    expect(resolveHover(o, node(gaming[0]!.itemKey), true, drag, "kss")?.over).toEqual({ kind: "block", sectionKey: "gaming", componentIndex: 0, edge: "before" });
    expect(resolveHover(o, node(gaming[3]!.itemKey), true, drag, "kss")).toBeNull();
  });

  it("moves sections only between section headers and at the ends", () => {
    const drag = dragItemOf(node("section:sleep"))!;
    expect(resolveHover(o, node("section:gaming"), false, drag, null)?.over).toEqual({ kind: "section", sectionKey: "gaming", edge: "before" });
    expect(resolveHover(o, node("kss.q1"), true, drag, null)).toBeNull();
    expect(resolveHover(o, node("completion"), true, drag, null)?.over).toEqual({ kind: "end" });
    expect(resolveHover(o, node("welcome"), false, drag, null)?.over).toEqual({ kind: "start" });
  });

  it("drops onto a section header into that section, at the end", () => {
    expect(resolveHover(o, node("section:sleep"), true, { kind: "question", itemKey: gamingFirst }, "ybm_gaming")).toEqual({
      over: { kind: "section", sectionKey: "sleep", edge: "inside" },
      indicator: { id: "section:sleep", edge: "inside" },
    });
  });
});
