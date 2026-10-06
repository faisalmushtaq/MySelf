import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addQuestion,
  emptyDraft,
  extractDraft,
  fragmentFromDraft,
  liveQuestions,
  MODULE_ID_PATTERN,
  outline,
  recordSavedModule,
  validatedFragment,
  type FragmentOrigin,
  type InsertOptions,
  type InsertReport,
  type LibraryCatalogueResponse,
  type LibraryModuleSummary,
  type StudioDraft,
} from "@myself/studio";
import {
  allTags,
  combineReports,
  defaultTarget,
  filterModules,
  fragmentQuestions,
  impliedPick,
  insertPieces,
  matches,
  matchingQuestions,
  moduleIdProblem,
  moduleSlug,
  moduleSourcesOf,
  needsReading,
  normalise,
  orderCatalogue,
  originWords,
  parseTags,
  pickedCount,
  pickKey,
  piecesFor,
  protectedIn,
  protectedInFragment,
  targetWords,
  togglePick,
  updatesForBlock,
} from "./model.js";

/**
 * The item library's decisions that need no screen (D-57, docs/16 §12): what
 * a search finds, what ticks make as pieces, where several pieces go when
 * they are added as one edit, and how modules are named and provenance said.
 */

const r800 = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json"), "utf8"));
const source = (): StudioDraft => extractDraft(r800);
const FROM_R8: FragmentOrigin = { kind: "release", study: "ybm", surveyId: "ybm_nd2026_standard", version: "8.0.0", hash: r800.hash };
const opts: InsertOptions = { by: "uid-researcher", byEmail: "researcher@example.org", at: "2026-10-06T12:00:00.000Z" };
const KSS = "kss@1.0/en-GB/self/standard";

/** A pilot survey with two questions of its own, in its welcome section. */
function pilot(): StudioDraft {
  let d = emptyDraft({ surveyId: "pilot_2027", study: "pilot", title: "Pilot" });
  d = addQuestion(d, { sectionKey: "welcome", typeId: "number", text: "How many pets do you have?" }).draft;
  return d;
}

const findText = (d: StudioDraft, itemKey: string) => {
  const q = liveQuestions(d).find((x) => x.itemKey === itemKey);
  return q ? `${q.item.stem.text} ${q.item.variable} ${itemKey}` : "";
};

const summary = (over: Partial<LibraryModuleSummary> & Pick<LibraryModuleSummary, "moduleId" | "title">): LibraryModuleSummary => ({
  description: "",
  tags: [],
  latestVersion: 1,
  retired: false,
  createdByEmail: "ed.editor@example.org",
  updatedAt: "2026-10-06T10:00:00Z",
  questionCount: 3,
  contentHash: `sha256:${"0".repeat(64)}`,
  ...over,
});

describe("searching the library", () => {
  it("matches every word, ignoring case, accents and spacing", () => {
    expect(normalise("  Café   USE ")).toBe("cafe use");
    expect(matches("cafe use", "How often do you use a café?")).toBe(true);
    expect(matches("pets sleep", "pets", "sleep habits")).toBe(true);
    expect(matches("pets sleep", "pets")).toBe(false);
    expect(matches("", "anything")).toBe(true);
    expect(matches("x", null, undefined)).toBe(false);
  });

  it("finds a published version's questions by wording, ID, variable or block name", () => {
    const d = source();
    const o = outline(d);
    const byWording = matchingQuestions(d, o, "five games");
    expect(byWording.has("ybm_gaming.top_games")).toBe(true);
    expect([...byWording].every((k) => /five/i.test(findText(d, k)))).toBe(true);
    expect(matchingQuestions(d, o, "ybm_gaming.top_games")).toEqual(new Set(["ybm_gaming.top_games"]));
    const gaming = o.sections.flatMap((s) => s.blocks).find((b) => b.instrument === "ybm_gaming")!;
    expect(matchingQuestions(d, o, gaming.name).size).toBe(gaming.questions.length);
    expect(matchingQuestions(d, o, "").size).toBe(0);
  });

  it("filters saved modules by words and by tag, alphabetically, and lists each tag once", () => {
    const modules = [
      summary({ moduleId: "sleep_habits", title: "Sleep habits", tags: ["Sleep", "wellbeing"] }),
      summary({ moduleId: "pets", title: "Pets at home", description: "Animals in the household", tags: ["home"] }),
      summary({ moduleId: "bedtime", title: "Bedtime routine", tags: ["sleep"] }),
    ];
    expect(filterModules(modules, "", null).map((m) => m.moduleId)).toEqual(["bedtime", "pets", "sleep_habits"]);
    expect(filterModules(modules, "animals", null).map((m) => m.moduleId)).toEqual(["pets"]);
    expect(filterModules(modules, "", "SLEEP").map((m) => m.moduleId)).toEqual(["bedtime", "sleep_habits"]);
    expect(filterModules(modules, "wellbeing", null).map((m) => m.moduleId)).toEqual(["sleep_habits"]);
    expect(allTags(modules)).toEqual(["home", "Sleep", "wellbeing"]);
  });
});

describe("the published surveys shelf", () => {
  const catalogue: LibraryCatalogueResponse = {
    studies: [
      {
        study: "ybm",
        title: "Yorkshire Brain Map",
        status: "open",
        surveys: [
          {
            surveyId: "ybm_nd2026_standard",
            title: "Neurodevelopment 2026",
            live: "8.0.0",
            versions: [
              { version: "7.3.0", hash: "sha256:73", publishedAt: "2026-09-01T00:00:00Z" },
              { version: "8.0.0", hash: "sha256:80", publishedAt: "2026-10-01T00:00:00Z" },
              { version: "10.0.0", hash: "sha256:100", publishedAt: "2026-10-03T00:00:00Z" },
            ],
          },
          { surveyId: "draft_only", title: "Never published", live: null, versions: [] },
        ],
      },
      { study: "archive", title: "An archive", status: "closed", surveys: [{ surveyId: "a1", title: "A", live: null, versions: [{ version: "1.0.0", hash: "sha256:a", publishedAt: "2026-01-01T00:00:00Z" }] }] },
      { study: "future", title: "Futures", status: "open", surveys: [{ surveyId: "f1", title: "F", live: "1.0.0", versions: [{ version: "1.0.0", hash: "sha256:f", publishedAt: "2026-10-05T00:00:00Z" }] }] },
      { study: "empty", title: "Empty", status: "open", surveys: [] },
    ],
  };

  it("puts this study space first, then the others by title, newest version first, and leaves out what has nothing published", () => {
    const ordered = orderCatalogue(catalogue, "future");
    expect(ordered.map((s) => [s.study, s.here])).toEqual([
      ["future", true],
      ["archive", false],
      ["ybm", false],
    ]);
    const ybm = ordered.find((s) => s.study === "ybm")!;
    expect(ybm.surveys.map((v) => v.surveyId)).toEqual(["ybm_nd2026_standard"]);
    expect(ybm.surveys[0]!.versions.map((v) => v.version)).toEqual(["10.0.0", "8.0.0", "7.3.0"]);
  });
});

describe("ticking what to copy", () => {
  const d = source();
  const o = outline(d);
  const gaming = o.sections.find((s) => s.blocks.some((b) => b.instrument === "ybm_gaming"))!;
  const block = gaming.blocks.find((b) => b.instrument === "ybm_gaming")!;
  const [q1, q2] = block.questions;

  it("makes one piece per block's ticked questions, a whole block, or a whole section, in survey order", () => {
    let picked = togglePick(o, new Set(), pickKey.question(q2!.itemKey));
    picked = togglePick(o, picked, pickKey.question(q1!.itemKey));
    expect(piecesFor(o, picked)).toEqual([
      { kind: "questions", sectionKey: gaming.key, componentIndex: block.componentIndex, itemKeys: [q1!.itemKey, q2!.itemKey] },
    ]);
    expect(pickedCount(o, picked)).toBe(2);

    // Ticking the block takes it whole: the ticks inside it are implied, not kept.
    picked = togglePick(o, picked, pickKey.block(gaming.key, block.componentIndex));
    expect(piecesFor(o, picked)).toEqual([{ kind: "block", sectionKey: gaming.key, componentIndex: block.componentIndex }]);
    expect(impliedPick(picked, gaming.key, block.componentIndex)).toBe(true);
    expect(pickedCount(o, picked)).toBe(block.questions.length);

    // Ticking its section takes that whole, and unticking it leaves nothing.
    picked = togglePick(o, picked, pickKey.section(gaming.key));
    expect(piecesFor(o, picked)).toEqual([{ kind: "section", sectionKey: gaming.key }]);
    expect(impliedPick(picked, gaming.key)).toBe(true);
    expect(pickedCount(o, picked)).toBe(gaming.blocks.reduce((n, b) => n + b.questions.length, 0));
    expect(piecesFor(o, togglePick(o, picked, pickKey.section(gaming.key)))).toEqual([]);
  });

  it("each piece is one that can be taken", () => {
    const picked = new Set([pickKey.question(q1!.itemKey), pickKey.section("wellbeing")]);
    const pieces = piecesFor(o, picked);
    // In survey order, whichever was ticked first.
    const at = (key: string) => o.sections.findIndex((s) => s.key === key);
    expect(pieces.map((p) => at(p.sectionKey))).toEqual([at(gaming.key), at("wellbeing")].sort((x, y) => x - y));
    for (const p of pieces) expect(() => fragmentFromDraft(d, p, FROM_R8)).not.toThrow();
  });

  it("knows when a protected module is among the ticks, so it asks why", () => {
    const welcome = o.sections[0]!;
    const consent = welcome.blocks.find((b) => b.instrument === "ybm_intro_consent")!;
    expect(protectedIn(o, piecesFor(o, new Set([pickKey.block(welcome.key, consent.componentIndex)])))).toEqual([
      { instrument: "ybm_intro_consent", name: consent.name },
    ]);
    expect(protectedIn(o, piecesFor(o, new Set([pickKey.question(q1!.itemKey)])))).toEqual([]);
    const f = fragmentFromDraft(d, { kind: "section", sectionKey: welcome.key }, FROM_R8);
    expect(protectedInFragment(f).map((m) => m.instrument)).toContain("ybm_intro_consent");
  });

  it("lists a piece's questions, block by block", () => {
    const f = validatedFragment(KSS);
    const qs = fragmentQuestions(f);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.every((q) => q.itemKey.startsWith("kss.") && q.variable && q.block)).toBe(true);
  });
});

describe("where the pieces go", () => {
  it("starts after the selected question, else at the end of the selected or last section, and says so", () => {
    const o = outline(source());
    const q = o.sections[1]!.blocks[0]!.questions[0]!;
    expect(defaultTarget(o, { kind: "question", itemKey: q.itemKey })).toEqual({ kind: "section", sectionKey: o.sections[1]!.key, afterItemKey: q.itemKey });
    expect(defaultTarget(o, { kind: "section", sectionKey: o.sections[2]!.key })).toEqual({ kind: "section", sectionKey: o.sections[2]!.key, afterItemKey: null });
    const last = o.sections[o.sections.length - 1]!;
    expect(defaultTarget(o, null)).toEqual({ kind: "section", sectionKey: last.key, afterItemKey: null });
    expect(targetWords(o, { kind: "section", sectionKey: last.key, afterItemKey: null })).toBe(`at the end of “${last.title}”`);
    expect(targetWords(o, { kind: "new", title: "  ", index: null })).toBe("as a new section, “Untitled”");
    expect(targetWords(o, { kind: "section", sectionKey: o.sections[1]!.key, afterItemKey: q.itemKey })).toMatch(/^after “.+” in “.+”$/);
  });

  it("adds several pieces as one edit, each after the one before, keeping IDs", () => {
    const d = source();
    const o = outline(d);
    const gaming = o.sections.flatMap((s) => s.blocks.map((b) => ({ s, b }))).find((x) => x.b.instrument === "ybm_gaming")!;
    const [a, b] = gaming.b.questions;
    const pieces = [
      fragmentFromDraft(d, { kind: "questions", sectionKey: gaming.s.key, componentIndex: gaming.b.componentIndex, itemKeys: [a!.itemKey] }, FROM_R8),
      validatedFragment(KSS),
      // Its condition tests the first piece's question, which is there by then, so it is kept.
      fragmentFromDraft(d, { kind: "questions", sectionKey: gaming.s.key, componentIndex: gaming.b.componentIndex, itemKeys: [b!.itemKey] }, FROM_R8),
    ];
    // After a question of another block, a copy goes after that whole block.
    const { draft, reports } = insertPieces(pilot(), pieces, { kind: "section", sectionKey: "welcome", afterItemKey: "pilot_studio.welcome" }, opts);
    const kss = reports[1]!.added;
    expect(reports.map((r) => r.added.length)).toEqual([1, kss.length, 1]);
    expect(liveQuestions(draft).map((q) => q.itemKey)).toEqual([
      "pilot_studio.welcome",
      "pilot_studio.many_pets_have",
      a!.itemKey,
      ...kss,
      b!.itemKey,
    ]);
    expect(draft.imports).toHaveLength(3);
    const outcome = combineReports(reports);
    expect(outcome.added).toHaveLength(2 + kss.length);
    expect(needsReading(outcome)).toBe(false);
  });

  it("brings a whole section in as a new section of its own, straight after the one chosen", () => {
    const d = source();
    const f = fragmentFromDraft(d, { kind: "section", sectionKey: "gaming" }, FROM_R8);
    const start = pilot();
    const { draft, reports } = insertPieces(start, [f], { kind: "section", sectionKey: "welcome", afterItemKey: null }, opts);
    expect(draft.composition.sections.map((s) => s.title)).toEqual([start.composition.sections[0]!.title, f.section!.title, ...start.composition.sections.slice(1).map((s) => s.title)]);
    expect(reports[0]!.sectionKey).toBe(draft.composition.sections[1]!.key);
    const named = insertPieces(start, [f], { kind: "new", title: "Games, copied", index: null }, opts).draft;
    expect(named.composition.sections.some((s) => s.title === "Games, copied")).toBe(true);
  });

  it("changes nothing when a piece is refused, and says what to read when something is renamed", () => {
    const start = pilot();
    expect(() => insertPieces(start, [validatedFragment(KSS)], { kind: "section", sectionKey: "nowhere", afterItemKey: null }, opts)).toThrow();
    const report: InsertReport = {
      importId: "imp_x",
      added: ["x.a_2"],
      alreadyThere: [],
      renamed: [{ from: "x.a", to: "x.a_2" }],
      variablesRenamed: [],
      scalesRenamed: [],
      conditionsRemoved: [],
      unlocked: [],
      sectionKey: "welcome",
    };
    expect(needsReading(combineReports([report]))).toBe(true);
  });
});

describe("naming a module", () => {
  it("suggests an ID from the title that the library accepts", () => {
    expect(moduleSlug("Sleep habits (2026 pilot)")).toBe("sleep_habits_2026_pilot");
    expect(moduleSlug("2026: Phones & sleep!")).toBe("phones_sleep");
    const long = moduleSlug("A very long title that goes on and on well past the forty-eight characters allowed");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(MODULE_ID_PATTERN.test(long)).toBe(true);
  });

  it("says why an ID can't be used", () => {
    expect(moduleIdProblem("", [])).toMatch(/Give/);
    expect(moduleIdProblem("ab", [])).toMatch(/at least 3/);
    expect(moduleIdProblem("Sleep", [])).toMatch(/lower-case/);
    expect(moduleIdProblem("sleep_habits", ["sleep_habits"])).toMatch(/already/);
    expect(moduleIdProblem("sleep_habits", [])).toBeNull();
  });

  it("reads tags as typed, each once", () => {
    expect(parseTags(" sleep, Wellbeing ,, sleep,  young   people ")).toEqual(["sleep", "Wellbeing", "young people"]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("provenance and module copies", () => {
  it("says where a piece came from", () => {
    const names = {
      here: "ybm",
      studyTitle: (s: string) => (s === "future" ? "Futures" : null),
      surveyTitle: () => "The future",
      moduleTitle: () => "Sleep habits",
      validatedName: () => "Karolinska Sleepiness Scale",
    };
    expect(originWords({ ...FROM_R8, study: "future", surveyId: "f1", version: "1.0.0" }, names)).toBe("“The future” (f1) r1.0.0 in study space “Futures”");
    expect(originWords(FROM_R8, names)).toBe("“The future” (ybm_nd2026_standard) r8.0.0");
    expect(originWords({ kind: "validated", instrument: "kss", refKey: KSS }, names)).toBe(`Karolinska Sleepiness Scale (validated questionnaire, ${KSS})`);
    expect(originWords({ kind: "module", moduleId: "sleep_habits", version: 3, contentHash: "" }, names)).toBe("module “Sleep habits” (sleep_habits) v3");
    expect(originWords({ kind: "module", moduleId: "sleep_habits", version: 3, contentHash: "" })).toBe("module sleep_habits v3");
  });

  it("finds the module a block's questions were saved as, and the notices that concern a block", () => {
    const d = pilot();
    const welcome = outline(d).sections[0]!.blocks[0]!;
    const f = fragmentFromDraft(d, { kind: "block", sectionKey: "welcome", componentIndex: welcome.componentIndex }, {
      kind: "module",
      moduleId: "pets",
      version: 2,
      contentHash: `sha256:${"1".repeat(64)}`,
    });
    const saved = recordSavedModule(d, f, opts).draft;
    const keys = welcome.questions.map((q) => q.itemKey);
    expect(moduleSourcesOf(saved, keys)).toEqual([{ moduleId: "pets", version: 2, itemKeys: keys }]);
    expect(moduleSourcesOf(d, keys)).toEqual([]);
    const update = { importId: "imp_1", moduleId: "pets", from: 2, to: 3, itemKeys: [keys[1]!] };
    expect(updatesForBlock([update], welcome)).toEqual([update]);
    expect(updatesForBlock([{ ...update, itemKeys: ["other.q"] }], welcome)).toEqual([]);
  });
});
