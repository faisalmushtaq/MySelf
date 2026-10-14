import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDraft, outline, validateDraft, type Issue } from "@myself/studio";
import {
  ancestorsOf,
  blockExpandKey,
  buildTree,
  findMatches,
  indexIssues,
  questionName,
  tabStopFor,
  typeahead,
  UNTITLED_QUESTION,
  type TreeOptions,
} from "./model.js";

const r730 = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json"), "utf8"));
const draft = extractDraft(r730);
const o = outline(draft);
const issues = validateDraft(draft);
const index = indexIssues(issues);

const base: TreeOptions = { query: "", withProblems: false, withConditions: false, expanded: new Map(), canEdit: true };
const tree = (opts: Partial<TreeOptions> = {}) => buildTree(o, index, { ...base, ...opts });
const questionIds = (t: ReturnType<typeof tree>) => t.visible.filter((n) => n.kind === "question").map((n) => n.id);

describe("the outline of the live survey", () => {
  it("lists the start screen, every section, add rows, MyStory, the completion screen and settings, in order", () => {
    const t = tree();
    expect(t.roots.map((n) => n.id)).toEqual([
      "welcome",
      ...o.sections.map((s) => `section:${s.key}`),
      "add-section",
      "mystory",
      "completion",
      "settings",
    ]);
    expect(t.filtering).toBe(false);
    // Off, it is listed as the place to switch it on.
    expect(t.byId.get("mystory")!.label).toBe("MyStory (off)");
  });

  it("shows licensed and protected blocks as labelled, folded groups, and study modules as plain questions", () => {
    const t = tree();
    const wellbeing = t.byId.get("section:wellbeing")!;
    expect(wellbeing.children.map((c) => c.kind)).toEqual(["block", "block", "block", "add-question"]);
    const sdq = wellbeing.children[1]!;
    expect(sdq.label).toBe("Strengths and Difficulties Questionnaire (self-report) (licensed — locked)");
    expect(sdq.expanded).toBe(false);
    expect(sdq.block?.questionCount).toBe(25);
    // Editable modules sit straight under their section.
    const gaming = t.byId.get("section:gaming")!;
    expect(gaming.children.filter((c) => c.kind === "question")).toHaveLength(8);
    expect(gaming.children[0]!.level).toBe(2);
    // The identity module is protected, so it has a header that says so.
    expect(t.byId.get("block:about_you:0")!.label).toMatch(/protected — unlock to edit/);
  });

  it("counts every question once and numbers them in the order participants meet them", () => {
    const all = tree({ expanded: new Map(o.sections.flatMap((s) => s.blocks.map((b) => [blockExpandKey(s.key, b.refKey), true] as const))) });
    const numbers = all.visible.filter((n) => n.kind === "question").map((n) => n.question!.number);
    expect(numbers).toHaveLength(147);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it("remembers a block as open by the block, not by its position, so moving another block keeps it open", () => {
    const sdq = o.sections.find((s) => s.key === "wellbeing")!.blocks[1]!;
    const expanded = new Map([[blockExpandKey("wellbeing", sdq.refKey), true]]);
    const moved = structuredClone(draft);
    const wellbeing = moved.composition.sections.find((s) => s.key === "wellbeing")!;
    wellbeing.components.push(wellbeing.components.shift()!);
    const after = buildTree(outline(moved), index, { ...base, expanded });
    expect(after.byId.get("block:wellbeing:0")!.block!.instrument).toBe("sdq25_s");
    expect(after.byId.get("block:wellbeing:0")!.expanded).toBe(true);
    expect(after.byId.get("block:wellbeing:2")!.expanded).toBe(false);
  });

  it("hides add and move affordances from someone who can't edit", () => {
    const t = tree({ canEdit: false });
    expect(t.visible.some((n) => n.kind === "add-question" || n.kind === "add-section")).toBe(false);
  });

  it("marks a section with a condition and says in words when it is shown", () => {
    const t = tree({ describeCondition: (key) => (key === "social_media" ? "Shown only if “Do you use social media?” is “Yes”" : null) });
    const node = t.byId.get("section:social_media")!;
    expect(node.section?.hasCondition).toBe(true);
    expect(node.section?.condition).toMatch(/^Shown only if/);
  });

  it("gives equal signatures to equal rows, and a new one only to the row that changed", () => {
    const before = tree();
    const edited = structuredClone(draft);
    const def = Object.values(edited.instruments).find((d) => d.instrument === "ybm_gaming")!;
    const first = def.forms[0]!.items[0] as { key: string; stem: { text: string } };
    first.stem.text = "Changed wording";
    const after = buildTree(outline(edited), index, base);
    const changed = after.visible.filter((n) => before.byId.get(n.id)?.sig !== n.sig).map((n) => n.id);
    expect(changed).toEqual([`ybm_gaming.${first.key}`]);
    expect(before.byId.get("section:gaming")!.treeSig).not.toBe(after.byId.get("section:gaming")!.treeSig);
    expect(before.byId.get("section:sleep")!.treeSig).toBe(after.byId.get("section:sleep")!.treeSig);
  });
});

describe("searching the outline", () => {
  it("finds questions by their words, ignoring case and accents, and highlights where", () => {
    expect(findMatches("Café au lait", "cafe")).toEqual([[0, 4]]);
    expect(findMatches("Sleep, sleep and SLEEP", "sleep")).toEqual([
      [0, 5],
      [7, 12],
      [17, 22],
    ]);
    expect(findMatches("anything", "  ")).toEqual([]);
    const t = tree({ query: "smartphone" });
    expect(t.filtering).toBe(true);
    const ids = questionIds(t);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const n = t.byId.get(id)!;
      expect(n.textMatch.length + n.idMatch.length).toBeGreaterThan(0);
    }
    expect(ids).toContain("ybm_smartphone.own");
  });

  it("finds a question by its ID and opens the folded block it is in", () => {
    const t = tree({ query: "sdq25_s.q7" });
    expect(questionIds(t)).toEqual(["sdq25_s.q7"]);
    const q = t.byId.get("sdq25_s.q7")!;
    expect(q.idMatch).toEqual([[0, 10]]);
    // Ancestors are shown and expanded while searching, whatever was folded.
    expect(t.visible.map((n) => n.id)).toEqual(["section:wellbeing", "block:wellbeing:1", "sdq25_s.q7"]);
    expect(t.matches).toBe(1);
  });

  it("shows every question of a section whose title matches", () => {
    const t = tree({ query: "gaming" });
    const gaming = t.byId.get("section:gaming")!;
    expect(gaming.textMatch).toEqual([[0, 6]]);
    expect(gaming.children.filter((c) => c.kind === "question")).toHaveLength(8);
  });

  it("hides add rows, and shows nothing when nothing matches", () => {
    const t = tree({ query: "zzzz no such words" });
    expect(t.visible).toEqual([]);
    expect(t.matches).toBe(0);
  });
});

describe("filtering the outline", () => {
  it("shows only questions with problems, under their sections", () => {
    const t = tree({ withProblems: true });
    const withIssues = new Set(issues.map((i: Issue) => i.location.itemKey).filter(Boolean));
    expect(new Set(questionIds(t))).toEqual(withIssues);
    expect(t.roots.every((r) => r.kind === "section" || r.issues.errors + r.issues.warnings > 0)).toBe(true);
    const gaming = t.byId.get("section:gaming")!;
    expect(gaming.issues.warnings).toBeGreaterThanOrEqual(2);
  });

  it("shows only questions shown to some participants, including every question of a conditional section", () => {
    const t = tree({ withConditions: true });
    const ids = questionIds(t);
    const social = o.sections.find((s) => s.key === "social_media")!;
    for (const b of social.blocks) for (const q of b.questions) expect(ids).toContain(q.itemKey);
    expect(ids).not.toContain("kss.q1");
    for (const id of ids) {
      const n = t.byId.get(id)!;
      const conditional = n.question!.hasCondition || n.question!.sectionKey === "social_media";
      expect(conditional).toBe(true);
    }
  });

  it("combines search and filters", () => {
    const t = tree({ withConditions: true, query: "game" });
    for (const id of questionIds(t)) expect(id.startsWith("ybm_gaming.") || t.byId.get(id)!.textMatch.length > 0).toBe(true);
  });
});

describe("finding rows", () => {
  it("names the rows a selection sits under, so a jump can open them", () => {
    expect(ancestorsOf(o, { kind: "question", itemKey: "sdq25_s.q7" })).toEqual(["section:wellbeing", "block:wellbeing:1"]);
    expect(ancestorsOf(o, { kind: "question", itemKey: "ybm_gaming.social_pct" })).toEqual(["section:gaming"]);
    expect(ancestorsOf(o, { kind: "block", sectionKey: "sleep", componentIndex: 0 })).toEqual(["section:sleep"]);
    expect(ancestorsOf(o, { kind: "welcome" })).toEqual([]);
  });

  // REVIEW FIX: `byId` also holds rows inside collapsed sections and blocks.
  // The tab stop (and "scroll to the selection") used it as "is on screen",
  // so after Collapse all no drawn row had tabindex=0 and Tab skipped the tree.
  it("knows which rows are drawn, and keeps the tab stop on a drawn row", () => {
    const open = tree();
    // A folded licensed questionnaire's questions are built but not drawn.
    expect(open.byId.has("sdq25_s.q7")).toBe(true);
    expect(open.shown.has("sdq25_s.q7")).toBe(false);
    expect(open.shown.has("block:wellbeing:1")).toBe(true);
    expect([...open.shown]).toEqual(open.visible.map((n) => n.id));
    // A drawn stop stays where it is.
    expect(tabStopFor(open, "ybm_gaming.social_pct", null)).toBe("ybm_gaming.social_pct");
    // Hidden inside a folded block: the block holds the stop, as focus moves to a collapsed parent.
    expect(tabStopFor(open, "sdq25_s.q7", null)).toBe("block:wellbeing:1");

    // Collapse every section: the stop moves up to the question's section.
    const closed = tree({ expanded: new Map(o.sections.map((s) => [`section:${s.key}`, false] as const)) });
    expect(closed.byId.has("ybm_gaming.social_pct")).toBe(true);
    expect(closed.shown.has("ybm_gaming.social_pct")).toBe(false);
    expect(tabStopFor(closed, "ybm_gaming.social_pct", "ybm_gaming.social_pct")).toBe("section:gaming");
    expect(tabStopFor(closed, "sdq25_s.q7", null)).toBe("section:wellbeing");
    // A row that has gone: the selection if drawn, else the first row.
    expect(tabStopFor(closed, "no.such_row", "section:sleep")).toBe("section:sleep");
    expect(tabStopFor(closed, null, "ybm_gaming.social_pct")).toBe("welcome");
  });

  it("jumps to the next row starting with what is typed, wrapping round", () => {
    const t = tree();
    const sleep = t.visible.findIndex((n) => n.id === "section:sleep");
    expect(t.visible[typeahead(t.visible, 0, "sle")]!.id).toBe("section:sleep");
    expect(typeahead(t.visible, sleep, "zzz")).toBe(-1);
    expect(t.visible[typeahead(t.visible, t.visible.length - 1, "start")]!.id).toBe("welcome");
  });
});

describe("issue counts", () => {
  it("files option issues under their question and survey-wide ones under settings", () => {
    const kssRef = o.sections.find((s) => s.key === "sleep")!.blocks[0]!.refKey;
    const made: Issue[] = [
      { severity: "error", code: "x", message: "m", location: { kind: "option", itemKey: "kss.q1", optionCode: 3 } },
      { severity: "warning", code: "y", message: "m", location: { kind: "question", itemKey: "kss.q1", sectionKey: "sleep" } },
      { severity: "error", code: "z", message: "m", location: { kind: "survey" } },
      { severity: "warning", code: "w", message: "m", location: { kind: "block", sectionKey: "sleep", refKey: kssRef } },
    ];
    const idx = indexIssues(made);
    expect(idx.question.get("kss.q1")).toEqual({ errors: 1, warnings: 1 });
    expect(idx.survey).toEqual({ errors: 1, warnings: 0 });
    const t = buildTree(o, idx, base);
    expect(t.byId.get("section:sleep")!.issues).toEqual({ errors: 1, warnings: 2 });
    expect(t.byId.get("settings")!.issues).toEqual({ errors: 1, warnings: 0 });
  });
});

describe("questionName", () => {
  it("cuts a question's text to fit", () => {
    expect(questionName("How many hours do you usually sleep on a school night?", 30)).toBe("How many hours do you usually…");
  });

  it("calls a question with no text yet by the one name used everywhere", () => {
    expect(questionName("")).toBe(UNTITLED_QUESTION);
    expect(questionName("   \n ")).toBe(UNTITLED_QUESTION);
  });
});
