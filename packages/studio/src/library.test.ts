import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allInstruments, allModules, allScales } from "@myself/library";
import { freezeRelease } from "@myself/release/gate";
import { allScoring } from "@myself/scoring";
import { canonicalJson, type ItemDefinition } from "@myself/schema";
import type { FragmentOrigin, ImportRecord, StudioDraft, StudioFragment } from "./contract.js";
import { MAX_IMPORTED_RELEASES, MAX_MODULE_CHARS } from "./contract.js";
import { diffDrafts, suggestBump } from "./diff.js";
import { emptyDraft, extractDraft, parseDraft, previewRelease, serialiseDraft } from "./draft.js";
import {
  describeInsert,
  dismissModuleUpdate,
  fragmentFromDraft,
  importedReleases,
  importsForVersion,
  insertFragment,
  lockVouchers,
  moduleContent,
  moduleContentHash,
  moduleProblems,
  pendingModuleUpdates,
  pickable,
  planModuleUpdate,
  provenanceOf,
  questionCount,
  recordSavedModule,
  repositoryModuleFragment,
  updateFromModule,
  validatedCatalogue,
  validatedFragment,
  withoutOutsideConditions,
  type InsertOptions,
} from "./library.js";
import { lockBaseline } from "./locked.js";
import { findQuestion, StudioOpError } from "./model.js";
import { BUILT_IN_PROTOCOLS } from "./mystory.js";
import * as ops from "./ops.js";
import { validateDraft } from "./validate.js";
import { liveQuestions } from "./walk.js";

// Test-only: drafts and pieces are edited here as plain JSON.
type Loose = Record<string, any>;

const manifest = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../releases/${name}`), "utf8"));
const r800 = manifest("ybm_nd2026_standard_r8.0.0.manifest.json");
const r730 = manifest("ybm_nd2026_standard_r7.3.0.manifest.json");

const FROM_R8: FragmentOrigin = { kind: "release", study: "ybm", surveyId: "ybm_nd2026_standard", version: "8.0.0", hash: r800.hash };
const FROM_R73: FragmentOrigin = { kind: "release", study: "ybm", surveyId: "ybm_nd2026_standard", version: "7.3.0", hash: r730.hash };
const opts: InsertOptions = { by: "uid-researcher", byEmail: "researcher@example.org", at: "2026-10-06T12:00:00.000Z", importId: "imp_test" };
const REASON = "Amendment 4 approves this consent wording for the pilot study.";

const SDQ2 = "sdq25_s@2.0/en-GB/self/standard";
const SDQ1 = "sdq25_s@1.0/en-GB/self/standard";
const GAMING = "ybm_gaming@1.0/en-GB/self/standard";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The live survey, deep-frozen, so an operation that wrote to its input would throw. */
const source = (): StudioDraft => deepFreeze(extractDraft(r800));
const blank = (): StudioDraft => deepFreeze(emptyDraft({ surveyId: "pilot_2027", study: "pilot", title: "Pilot" }));
/** Another survey of the pilot study, with questions of its own. */
function otherSurvey(): StudioDraft {
  let d: StudioDraft = emptyDraft({ surveyId: "pilot_followup", study: "pilot", title: "Pilot follow-up" });
  d = ops.addQuestion(d, { sectionKey: "welcome", typeId: "number", text: "How many pets do you have?" }).draft;
  d = ops.addQuestion(d, { sectionKey: "welcome", typeId: "single_choice", text: "Which pet is your favourite?" }).draft;
  return deepFreeze(d);
}

const block = (d: StudioDraft, sectionKey: string, componentIndex: number, origin: FragmentOrigin = FROM_R8) =>
  fragmentFromDraft(d, { kind: "block", sectionKey, componentIndex }, origin);
const questions = (d: StudioDraft, sectionKey: string, componentIndex: number, itemKeys: string[], origin: FragmentOrigin = FROM_R8) =>
  fragmentFromDraft(d, { kind: "questions", sectionKey, componentIndex, itemKeys }, origin);

function refusal(fn: () => unknown): StudioOpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StudioOpError) return error;
    throw error;
  }
  throw new Error("expected the operation to be refused");
}

const errors = (d: StudioDraft, ctx: Parameters<typeof validateDraft>[1]) => validateDraft(d, ctx).filter((i) => i.severity === "error");
const item = (d: StudioDraft, id: string) => findQuestion(d, id)?.item as (ItemDefinition & Loose) | undefined;
const asked = (d: StudioDraft) => liveQuestions(d).map((q) => q.itemKey);

/** Freezes exactly as the server would. */
function publishable(d: StudioDraft) {
  const preview = previewRelease(d);
  expect(preview.error).toBeNull();
  expect(preview.failures).toEqual([]);
  return preview.manifest!;
}

// ---------------------------------------------------------------------------

describe("picking a piece", () => {
  it("takes a whole block, self-contained, with its options and origin", () => {
    const f = block(source(), "gaming", 0);
    expect(f.blocks).toHaveLength(1);
    expect(f.blocks[0]!.refKey).toBe(GAMING);
    expect(f.title).toBe(source().instruments[GAMING]!.name);
    expect(f.section).toBeUndefined();
    expect(questionCount(f)).toBe(8);
    expect(Object.keys(f.scales).sort()).toEqual(["scale.game_hours_5pt", "scale.gaming_hours_6pt"]);
    expect(f.origin).toEqual(FROM_R8);
  });

  it("takes some questions of one block in the order given, by ID or key, trimmed", () => {
    const f = questions(source(), "gaming", 0, ["ybm_gaming.top_games", "hours_week"]);
    const items = f.blocks[0]!.definition.forms[0]!.items as Loose[];
    expect(items.map((i) => i.key)).toEqual(["top_games", "hours_week"]);
    expect(Object.keys(f.scales)).toEqual(["scale.gaming_hours_6pt"]);
    expect(refusal(() => questions(source(), "gaming", 0, ["ybm_smartphone.own"])).message).toMatch(/only from one block/);
    expect(refusal(() => questions(source(), "gaming", 0, ["nope"])).code).toBe("not_found");
    expect(refusal(() => questions(source(), "gaming", 0, [])).message).toMatch(/at least one/);
  });

  it("refuses single questions of a validated questionnaire or a protected module", () => {
    expect(refusal(() => questions(source(), "wellbeing", 1, ["q1"])).message).toMatch(/licensed, validated questionnaire.*whole/);
    expect(refusal(() => questions(source(), "welcome", 0, ["consent"])).message).toMatch(/consent.*whole, with the reason recorded/);
    expect(pickable(source(), "sdq25_s.q1")).toMatchObject({ ok: false });
    expect(pickable(source(), "ybm_intro_consent.consent")).toMatchObject({ ok: false });
    expect(pickable(source(), "ybm_identity.dob")).toMatchObject({ ok: false });
    expect(pickable(source(), "ybm_gaming.top_games")).toEqual({ ok: true });
    expect(pickable(source(), "ybm_gaming.nothing")).toMatchObject({ ok: false });
  });

  it("takes a validated questionnaire whole, as frozen, with its scoring", () => {
    const f = block(source(), "wellbeing", 1);
    expect(f.blocks[0]!.refKey).toBe(SDQ2);
    expect(f.blocks[0]!.definition).toEqual(source().instruments[SDQ2]);
    expect(Object.keys(f.scoring)).toEqual(["score.sdq25_s"]);
    expect(f.blocks[0]!.displayIf).toBeDefined();
  });

  it("takes a section as its blocks in order, under its title", () => {
    const f = fragmentFromDraft(source(), { kind: "section", sectionKey: "wellbeing" }, FROM_R8);
    expect(f.section).toEqual({ title: "How you've been feeling" });
    expect(f.blocks.map((b) => b.definition.instrument)).toEqual(["swemwbs", "sdq25_s", "sdq25_s18", "rcads25"]);
  });

  it("carries the files a question needs", () => {
    const f = block(source(), "about_you", 0);
    expect(Object.keys(f.assets ?? {})).toEqual(["postcodes_west_yorkshire"]);
  });

  it("will not copy MyStory, which is switched on per survey", () => {
    const d = ops.setMyStory(blank(), BUILT_IN_PROTOCOLS[0]!).draft;
    const story = d.composition.sections[d.composition.sections.length - 1]!.key;
    expect(refusal(() => fragmentFromDraft(d, { kind: "section", sectionKey: story }, FROM_R8)).message).toMatch(/MyStory can't be copied/);
  });
});

// ---------------------------------------------------------------------------

describe("adding a piece: a round trip from a repository release", () => {
  it("keeps every ID, variable and revision, brings the instrument, and publishes", () => {
    const f = block(source(), "gaming", 0);
    const { draft, report } = insertFragment(blank(), f, { sectionKey: "welcome" }, opts);
    const ids = itemsOf(source(), GAMING).map((i) => `ybm_gaming.${i.key}`);
    expect(report.added).toEqual(ids);
    expect(report.renamed).toEqual([]);
    expect(report.variablesRenamed).toEqual([]);
    for (const original of itemsOf(source(), GAMING)) {
      const copy = item(draft, `ybm_gaming.${original.key}`)!;
      expect(copy.variable).toBe(original.variable);
      expect(copy.revision).toBe(original.revision);
      expect(copy.legacyVariable).toBe(original.legacyVariable);
    }
    expect(Object.keys(draft.instruments)).toContain(GAMING);
    expect(asked(draft)).toEqual(["pilot_studio.welcome", ...ids]);
    expect(draft.imports).toEqual([
      {
        id: "imp_test",
        at: opts.at,
        by: opts.by,
        byEmail: opts.byEmail,
        origin: FROM_R8,
        items: Object.fromEntries(ids.map((id) => [id, id])),
      },
    ]);
    publishable(draft);
    expect(errors(draft, { baseline: lockBaseline(null, draft) })).toEqual([]);
    // The frozen release administers the copy exactly as the source froze it.
    expect(previewRelease(draft).manifest!.instruments[GAMING]).toEqual(r800.instruments[GAMING]);
  });

  it("adds to a draft of another survey, and says when everything is already there", () => {
    const f = block(source(), "gaming", 0);
    const first = insertFragment(otherSurvey(), f, { sectionKey: "welcome" }, opts);
    expect(first.report.added).toHaveLength(8);
    expect(asked(first.draft).slice(0, 3)).toEqual(["pilot_studio.welcome", "pilot_studio.many_pets_have", "pilot_studio.pet_favourite"]);
    const again = insertFragment(first.draft, f, { sectionKey: "welcome" }, { ...opts, importId: "imp_again" });
    expect(again.report.added).toEqual([]);
    expect(again.report.alreadyThere).toHaveLength(8);
    expect(again.draft.imports).toHaveLength(1);
    expect(describeInsert(again.report)).toMatch(/Nothing was added.*already has every one/);
    // The published survey it came from already has it too.
    expect(insertFragment(source(), f, { sectionKey: "gaming" }, opts).report.alreadyThere).toHaveLength(8);
  });

  it("copies a question between two surveys of one study into the same block, after the question named", () => {
    const f = questions(otherSurvey(), "welcome", 0, ["pilot_studio.many_pets_have"], { kind: "release", study: "pilot", surveyId: "pilot_followup", version: "1.0.0", hash: "sha256:" + "a".repeat(64) });
    let d = ops.addQuestion(blank(), { sectionKey: "welcome", typeId: "short_text", text: "What is your name for today?" }).draft;
    const { draft, report } = insertFragment(d, f, { sectionKey: "welcome", afterItemKey: "pilot_studio.welcome" }, opts);
    expect(report.added).toEqual(["pilot_studio.many_pets_have"]);
    expect(asked(draft)).toEqual(["pilot_studio.welcome", "pilot_studio.many_pets_have", "pilot_studio.name_today"]);
    // One block: the question joined the survey's own module, as a hand-written one would.
    expect(draft.composition.sections[0]!.components).toHaveLength(1);
    d = draft;
    publishable(d);
  });
});

function itemsOf(d: StudioDraft, refKey: string): Loose[] {
  return d.instruments[refKey]!.forms[0]!.items as Loose[];
}

// ---------------------------------------------------------------------------

describe("renaming only on a clash", () => {
  /** The live survey with two gaming questions reworded, so the originals clash with them. */
  function reworded(): StudioDraft {
    let d = extractDraft(r800);
    d = ops.updateQuestion(d, "ybm_gaming.hours_week", { stem: { text: "How many hours a week do you play games, roughly?" } }).draft;
    d = ops.updateQuestion(d, "ybm_gaming.top_games", { stem: { text: "Which games do you play the most these days?" } }).draft;
    return deepFreeze(d);
  }

  it("gives a copy a new ID, revision 1, a new variable and no legacy variable when the ID is a different question here, and follows it in conditions", () => {
    const f = block(source(), "gaming", 0);
    const { draft, report } = insertFragment(reworded(), f, { sectionKey: "gaming" }, opts);
    expect(report.renamed).toEqual([
      { from: "ybm_gaming.hours_week", to: "ybm_gaming.hours_week_2" },
      { from: "ybm_gaming.top_games", to: "ybm_gaming.top_games_2" },
    ]);
    expect(report.alreadyThere).toHaveLength(6);
    const copy = item(draft, "ybm_gaming.top_games_2")!;
    expect(copy.revision).toBe(1);
    expect(copy.legacyVariable).toBeUndefined();
    expect(copy.variable).not.toBe("gaming_top_games");
    expect(report.variablesRenamed.map((v) => v.from)).toEqual(["gaming_hours_week", "gaming_top_games"]);
    // top_games' condition tested hours_week: it now tests the copy.
    expect(copy.displayIf).toEqual({ op: "not_selected", target: { item: { instrument: "ybm_gaming", item: "hours_week_2", revision: 1 } }, code: 1 });
    expect(draft.imports![0]!.renamed).toEqual({ "ybm_gaming.hours_week": "ybm_gaming.hours_week_2", "ybm_gaming.top_games": "ybm_gaming.top_games_2" });
    expect(draft.imports![0]!.variablesRenamed).toEqual(Object.fromEntries(report.variablesRenamed.map((v) => [v.from, v.to])));
    expect(describeInsert(report)).toMatch(/hours_week → ybm_gaming.hours_week_2.*will not line up/);
    publishable(draft);
  });

  it("treats a question in the archive as taken, unless it is the same question, which comes back", () => {
    const f = questions(source(), "gaming", 0, ["hours_week"]);
    const archivedSame = ops.archiveQuestion(extractDraft(r800), "ybm_gaming.hours_week", opts).draft;
    const back = insertFragment(archivedSame, f, { sectionKey: "gaming" }, opts);
    expect(back.report.added).toEqual(["ybm_gaming.hours_week"]);
    expect(back.report.renamed).toEqual([]);
    expect(back.draft.archived.map((a) => a.itemKey)).not.toContain("ybm_gaming.hours_week");

    const archivedOther = ops.archiveQuestion(reworded(), "ybm_gaming.hours_week", opts).draft;
    const renamed = insertFragment(archivedOther, f, { sectionKey: "gaming" }, opts);
    expect(renamed.report.renamed).toEqual([{ from: "ybm_gaming.hours_week", to: "ybm_gaming.hours_week_2" }]);
  });

  it("treats a published ID as the same question only when it was published with this variable", () => {
    const f = questions(source(), "gaming", 0, ["hours_week"]);
    const id = "ybm_gaming.hours_week";
    const same = { itemKeys: new Set([id]), variables: new Set(["gaming_hours_week"]), variablesByItem: new Map([[id, new Set(["gaming_hours_week"])]]) };
    const r1 = insertFragment(blank(), f, { sectionKey: "welcome" }, { ...opts, reserved: same });
    expect(r1.report.added).toEqual([id]);
    expect(r1.report.renamed).toEqual([]);
    expect(r1.report.variablesRenamed).toEqual([]);

    const other = { itemKeys: new Set([id]), variables: new Set(["weekly_gaming"]), variablesByItem: new Map([[id, new Set(["weekly_gaming"])]]) };
    expect(insertFragment(blank(), f, { sectionKey: "welcome" }, { ...opts, reserved: other }).report.renamed).toEqual([{ from: id, to: `${id}_2` }]);

    // Versions that could not say which variable went with which ID: fail safe.
    const unpaired = { itemKeys: new Set([id]), variables: new Set(["gaming_hours_week"]) };
    const r3 = insertFragment(blank(), f, { sectionKey: "welcome" }, { ...opts, reserved: unpaired });
    expect(r3.report.renamed).toHaveLength(1);
    expect(r3.report.variablesRenamed).toEqual([{ itemKey: `${id}_2`, from: "gaming_hours_week", to: "gaming_hours_week_2" }]);
  });

  it("renames only the variable when only the variable is taken, and drops the legacy variable", () => {
    let d = ops.addQuestion(blank(), { sectionKey: "welcome", typeId: "number", text: "Hours of sleep" }).draft;
    d = ops.updateQuestion(d, "pilot_studio.hours_sleep", { variable: "gaming_hours_week" }).draft;
    const { draft, report } = insertFragment(d, questions(source(), "gaming", 0, ["hours_week"]), { sectionKey: "welcome" }, opts);
    expect(report.renamed).toEqual([]);
    expect(report.variablesRenamed).toEqual([{ itemKey: "ybm_gaming.hours_week", from: "gaming_hours_week", to: "gaming_hours_week_2" }]);
    const copy = item(draft, "ybm_gaming.hours_week")!;
    expect(copy.revision).toBe(1);
    expect(copy.legacyVariable).toBeUndefined();
    publishable(draft);
  });

  it("refuses to rename an identity question, which ingest reads by name", () => {
    let d = extractDraft(r800);
    d = ops.unlockModule(d, "ybm_identity", { ...opts, reason: REASON }).draft;
    d = ops.updateQuestion(d, "ybm_identity.first_name", { stem: { text: "Your first name, please" } }).draft;
    const f = block(source(), "about_you", 0);
    expect(refusal(() => insertFragment(d, f, { sectionKey: "about_you" }, { ...opts, protectedReason: REASON })).code).toBe("linkage");
  });
});

// ---------------------------------------------------------------------------

describe("answer options, scoring and files", () => {
  it("adds an option list the draft lacks, shares an identical one, and files a different one under a new key", () => {
    const f = questions(source(), "gaming", 0, ["hours_week"]);
    const added = insertFragment(blank(), f, { sectionKey: "welcome" }, opts);
    expect(added.draft.scales["scale.gaming_hours_6pt"]).toEqual(source().scales["scale.gaming_hours_6pt"]);
    expect(added.report.scalesRenamed).toEqual([]);

    const shared = insertFragment(added.draft, questions(source(), "gaming", 0, ["social_pct"]), { sectionKey: "welcome" }, opts);
    expect(Object.keys(shared.draft.scales)).toEqual(Object.keys(added.draft.scales));

    const different = structuredClone(blank()) as StudioDraft;
    different.scales["scale.gaming_hours_6pt"] = { ...structuredClone(source().scales["scale.gaming_hours_6pt"]!) };
    (different.scales["scale.gaming_hours_6pt"]!.options[0] as Loose).label = "Never, ever";
    const renamed = insertFragment(different, f, { sectionKey: "welcome" }, opts);
    expect(renamed.report.scalesRenamed).toEqual([{ from: "scale.gaming_hours_6pt", to: "scale.ybm_gaming_hours_week" }]);
    expect(item(renamed.draft, "ybm_gaming.hours_week")!.scale).toBe("scale.ybm_gaming_hours_week");
    expect((renamed.draft.scales["scale.gaming_hours_6pt"]!.options[0] as Loose).label).toBe("Never, ever");
    expect(describeInsert(renamed.report)).toMatch(/added as their own list/);
  });

  it("refuses a validated questionnaire whose licensed options or scoring differ here", () => {
    const sdq = validatedFragment(SDQ2);
    const options = structuredClone(blank()) as StudioDraft;
    options.scales["scale.sdq_3pt"] = { ...structuredClone(sdq.scales["scale.sdq_3pt"]!) };
    (options.scales["scale.sdq_3pt"]!.options[0] as Loose).label = "Not really";
    expect(refusal(() => insertFragment(options, sdq, { sectionKey: "welcome" }, opts)).message).toMatch(/licensed options exactly/);

    const scoring = structuredClone(blank()) as StudioDraft;
    scoring.scoring["score.sdq25_s"] = { ...structuredClone(sdq.scoring["score.sdq25_s"]!), version: "9.9.9" };
    expect(refusal(() => insertFragment(scoring, sdq, { sectionKey: "welcome" }, opts)).message).toMatch(/different scoring under the same name/);
  });

  it("carries the postcode list an address question needs, and refuses a different pin under the same name", () => {
    const f = block(source(), "about_you", 0);
    const { draft } = insertFragment(blank(), f, { sectionKey: "welcome" }, { ...opts, protectedReason: REASON });
    expect(draft.assets).toEqual(r800.assets);
    publishable(draft);

    const pinned = structuredClone(blank()) as StudioDraft;
    pinned.assets = { postcodes_west_yorkshire: { ...r800.assets.postcodes_west_yorkshire, sha256: "sha256:" + "0".repeat(64) } };
    expect(refusal(() => insertFragment(pinned, f, { sectionKey: "welcome" }, { ...opts, protectedReason: REASON })).message).toMatch(/different version of it/);
  });
});

// ---------------------------------------------------------------------------

describe("validated questionnaires", () => {
  it("lists every validated questionnaire in the library, each a piece frozen as a release freezes it", () => {
    const shelf = validatedCatalogue();
    expect(shelf.map((e) => e.instrument).sort()).toEqual(allInstruments.map((i) => i.instrument).sort());
    expect(shelf.find((e) => e.instrument === "sdq25_s")).toMatchObject({ refKey: SDQ2, questionCount: 25, audience: "11–17", abbreviation: "SDQ" });
    expect(shelf.find((e) => e.instrument === "sdq25_s18")).toMatchObject({ audience: "18+", questionCount: 25 });
    expect(shelf.find((e) => e.instrument === "bisbas12_ybm")!.licence).toMatch(/needs the licence holder's permission/);
    for (const entry of shelf) expect(questionCount(validatedFragment(entry.refKey))).toBe(entry.questionCount);
    expect(validatedCatalogue("fr-FR")).toEqual([]);
    expect(refusal(() => validatedFragment("sdq25_s@9.0/en-GB/self/standard")).code).toBe("not_found");
  });

  it("is exactly what freezeRelease freezes for that reference", () => {
    const f = validatedFragment(SDQ2);
    const composition = {
      ...structuredClone(blank().composition),
      sections: [{ key: "s", title: "S", components: [{ kind: "instrument" as const, ref: { instrument: "sdq25_s", version: "2.0", language: "en-GB" } }] }],
    };
    const { body } = freezeRelease(
      composition,
      { instruments: allInstruments, modules: allModules, scales: allScales, scoring: allScoring },
      { version: "1.0.0", publishedAt: "2026-10-06T00:00:00.000Z", publishedBy: "test", engineVersion: "0.4.0" },
    );
    expect(canonicalJson(f.blocks[0]!.definition)).toBe(canonicalJson(body.instruments[SDQ2]));
    expect(canonicalJson(f.scales)).toBe(canonicalJson(body.scales));
    expect(canonicalJson(f.scoring)).toBe(canonicalJson(body.scoring));
    expect(f.origin).toEqual({ kind: "validated", instrument: "sdq25_s", refKey: SDQ2 });
    // …and it is what the live release froze, too.
    expect(canonicalJson(f.blocks[0]!.definition)).toBe(canonicalJson(r800.instruments[SDQ2]));
  });

  it("validates clean with the library's vouchers, and is reported without them", () => {
    const { draft, report } = insertFragment(blank(), validatedFragment(SDQ2), { sectionKey: "welcome" }, opts);
    expect(report.added).toHaveLength(25);
    expect(draft.scoring["score.sdq25_s"]).toBeDefined();
    publishable(draft);
    const baseline = lockBaseline(null, draft);
    expect(errors(draft, { baseline, ...lockVouchers({ releases: [], library: true }) })).toEqual([]);
    expect(errors(draft, { baseline }).map((i) => i.code)).toEqual(["locked.introduced"]);
  });

  it("refuses a tampered copy even with every voucher", () => {
    const { draft } = insertFragment(blank(), validatedFragment(SDQ2), { sectionKey: "welcome" }, opts);
    const tampered = structuredClone(draft);
    const first = tampered.instruments[SDQ2]!.forms[0]!.items[0] as Loose;
    first.stem = { ...first.stem, text: first.stem.text.replace(/\bnice\b/, "kind") };
    expect(first.stem.text).not.toBe((draft.instruments[SDQ2]!.forms[0]!.items[0] as Loose).stem.text);
    const vouchers = lockVouchers({ releases: [extractDraft(r800)], library: true, draft: tampered });
    expect(errors(tampered, { baseline: lockBaseline(null, tampered), ...vouchers }).map((i) => i.code)).toEqual(["locked.introduced"]);
  });

  it("is added whole, once: a second version is refused with the reason, the same one is already there", () => {
    const { draft } = insertFragment(blank(), validatedFragment(SDQ2), { sectionKey: "welcome" }, opts);
    const older = block(extractDraft(r730), "wellbeing", 1, FROM_R73);
    expect(older.blocks[0]!.refKey).toBe(SDQ1);
    const e = refusal(() => insertFragment(draft, older, { sectionKey: "welcome" }, opts));
    expect(e.code).toBe("locked");
    expect(e.message).toMatch(/already uses SDQ 2\.0.*one version of a validated questionnaire/);
    expect(insertFragment(draft, validatedFragment(SDQ2), { sectionKey: "welcome" }, opts).report.alreadyThere).toHaveLength(25);
    // The archive holds it whole: restoring is the way back.
    const removed = ops.removeBlock(draft, "welcome", 1, opts).draft;
    expect(refusal(() => insertFragment(removed, validatedFragment(SDQ2), { sectionKey: "welcome" }, opts)).message).toMatch(/Restore it from the archive/);
  });

  it("is vouched for by the release it was copied from, read as a draft", () => {
    const { draft } = insertFragment(blank(), block(extractDraft(r730), "wellbeing", 1, FROM_R73), { sectionKey: "welcome" }, opts);
    const baseline = lockBaseline(null, draft);
    // SDQ 1.0 is not in today's library…
    expect(errors(draft, { baseline, ...lockVouchers({ releases: [], library: true }) }).map((i) => i.code)).toEqual(["locked.introduced"]);
    // …but the release it came from froze it, exactly.
    expect(errors(draft, { baseline, ...lockVouchers({ releases: [extractDraft(r730)], library: true, draft }) })).toEqual([]);
  });

  it("matches each copy against a source that froze it whole, when two sources freeze one reference differently", () => {
    // A release frozen before the library's SDQ record changed (here: its licence note).
    const older = extractDraft(r800);
    (older.instruments[SDQ2] as Loose).licence = { ...(older.instruments[SDQ2] as Loose).licence, evidence: "Register entry 12." };
    const { draft } = insertFragment(blank(), block(older, "wellbeing", 1), { sectionKey: "welcome" }, opts);
    const baseline = lockBaseline(null, draft);
    expect(errors(draft, { baseline, ...lockVouchers({ releases: [older], library: true }) }).map((i) => i.code)).toEqual(["locked.introduced"]);
    expect(errors(draft, { baseline, ...lockVouchers({ releases: [older], library: true, draft }) })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("consent and identity modules", () => {
  it("are added only with a reason, which unlocks them and is recorded", () => {
    const f = block(source(), "welcome", 0);
    expect(refusal(() => insertFragment(blank(), f, { newSection: { title: "Consent", index: 0 } }, opts)).code).toBe("protected");
    expect(refusal(() => insertFragment(blank(), f, { newSection: { title: "Consent", index: 0 } }, { ...opts, protectedReason: "ok" })).code).toBe("protected");
    const { draft, report } = insertFragment(blank(), f, { newSection: { title: "Consent", index: 0 } }, { ...opts, protectedReason: REASON });
    expect(report.unlocked).toEqual(["ybm_intro_consent"]);
    expect(draft.unlocked["ybm_intro_consent"]).toEqual({ instrument: "ybm_intro_consent", by: opts.by, at: opts.at, reason: REASON });
    expect(asked(draft)[0]).toBe("ybm_intro_consent.intro");
    expect(describeInsert(report)).toMatch(/unlocked with the reason you gave/);
    // Validation accepts it: unlocked, it is the study's own to change.
    expect(errors(draft, { baseline: lockBaseline(null, draft), ...lockVouchers({ releases: [], library: true }) })).toEqual([]);
  });

  it("need no reason when nothing of them would be added", () => {
    const f = block(source(), "welcome", 0);
    const { report } = insertFragment(source(), f, { sectionKey: "welcome" }, opts);
    expect(report.alreadyThere).toHaveLength(3);
    expect(report.unlocked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("display conditions", () => {
  it("are kept when what they test is in the draft after the copy, and removed and reported when not", () => {
    const alone = insertFragment(blank(), questions(source(), "gaming", 0, ["top_games"]), { sectionKey: "welcome" }, opts);
    expect(item(alone.draft, "ybm_gaming.top_games")!.displayIf).toBeUndefined();
    expect(alone.report.conditionsRemoved).toEqual([
      { itemKey: "ybm_gaming.top_games", block: null, reason: "It tests ybm_gaming.hours_week, which this survey does not ask." },
    ]);
    expect(describeInsert(alone.report)).toMatch(/display condition on ybm_gaming.top_games was removed/);

    const together = insertFragment(blank(), questions(source(), "gaming", 0, ["hours_week", "top_games"]), { sectionKey: "welcome" }, opts);
    expect(item(together.draft, "ybm_gaming.top_games")!.displayIf).toBeDefined();
    expect(together.report.conditionsRemoved).toEqual([]);

    // Into a survey that already asks what it tests, the condition stays.
    const later = insertFragment(alone.draft, questions(source(), "gaming", 0, ["game_time_1"]), { sectionKey: "welcome" }, opts);
    expect(item(later.draft, "ybm_gaming.game_time_1")!.displayIf).toBeDefined();
  });

  it("on a block are removed and reported the same way", () => {
    const { draft, report } = insertFragment(blank(), block(source(), "wellbeing", 1), { sectionKey: "welcome" }, opts);
    expect(report.conditionsRemoved).toEqual([{ itemKey: null, block: "SDQ", reason: "It tests ybm_identity.dob, which this survey does not ask." }]);
    expect(draft.composition.sections[0]!.components[1]!.displayIf).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("where a piece goes", () => {
  it("goes in as a new section with the section's title, before MyStory, keeping MyStory last", () => {
    const withStory = ops.setMyStory(blank(), BUILT_IN_PROTOCOLS[0]!).draft;
    const f = fragmentFromDraft(source(), { kind: "section", sectionKey: "wellbeing" }, FROM_R8);
    const { draft, report } = insertFragment(withStory, f, { newSection: { title: "" } }, opts);
    const keys = draft.composition.sections.map((s) => s.key);
    expect(report.sectionKey).toBe("how_youve_been_feeling");
    expect(keys).toEqual(["welcome", "how_youve_been_feeling", keys[2]]);
    expect(draft.composition.sections[2]!.components[0]!.kind).toBe("narrative");
    expect(draft.composition.sections[1]!.components.map((c) => (c as Loose).ref.instrument)).toEqual(["swemwbs", "sdq25_s", "sdq25_s18", "rcads25"]);
    expect(report.conditionsRemoved).toHaveLength(2);
    // The target's title wins over the piece's.
    expect(insertFragment(blank(), f, { newSection: { title: "Wellbeing" } }, opts).report.sectionKey).toBe("wellbeing");
  });

  it("never goes before the consent module, or into MyStory's section", () => {
    const f = block(source(), "gaming", 0);
    const sqs = validatedFragment("sqs@1.0/en-GB/self/standard");
    expect(refusal(() => insertFragment(source(), sqs, { newSection: { title: "Sleep quality", index: 0 } }, opts)).message).toMatch(/asked before .*consent/i);
    // A piece that adds nothing leaves no empty section behind.
    const nothing = insertFragment(source(), f, { newSection: { title: "Games", index: 0 } }, opts);
    expect(nothing.report).toMatchObject({ added: [], sectionKey: "" });
    expect(nothing.draft.composition.sections.map((s) => s.key)).toEqual(source().composition.sections.map((s) => s.key));
    const withStory = ops.setMyStory(blank(), BUILT_IN_PROTOCOLS[0]!).draft;
    const story = withStory.composition.sections[1]!.key;
    expect(refusal(() => insertFragment(withStory, f, { sectionKey: story }, opts)).message).toMatch(/MyStory's section/);
    expect(refusal(() => insertFragment(blank(), f, { sectionKey: "nowhere" }, opts)).code).toBe("not_found");
  });

  it("goes after the question named: in its block when of the same instrument, else straight after its block", () => {
    let d: StudioDraft = extractDraft(r800);
    d = ops.archiveQuestion(d, "ybm_gaming.social_pct", opts).draft;
    // Back after hours_week, inside the gaming block.
    const same = insertFragment(d, questions(source(), "gaming", 0, ["social_pct"]), { sectionKey: "gaming", afterItemKey: "ybm_gaming.hours_week" }, opts);
    expect(asked(same.draft).filter((k) => k.startsWith("ybm_gaming.")).slice(0, 2)).toEqual(["ybm_gaming.hours_week", "ybm_gaming.social_pct"]);
    expect(same.draft.composition.sections.find((s) => s.key === "gaming")!.components).toHaveLength(1);

    // After a question of another block: a block of its own, straight after that one.
    const other = insertFragment(blank(), block(source(), "gaming", 0), { sectionKey: "welcome" }, opts).draft;
    const placed = insertFragment(other, questions(source(), "phones", 0, ["own"]), { sectionKey: "welcome", afterItemKey: "pilot_studio.welcome" }, opts);
    const order = asked(placed.draft);
    expect(order.indexOf("ybm_smartphone.own")).toBe(1);
    expect(placed.draft.composition.sections[0]!.components.map((c) => (c as Loose).ref.instrument)).toEqual(["pilot_studio", "ybm_smartphone", "ybm_gaming"]);
    publishable(placed.draft);
  });

  it("goes at the end of the section, joining the last block when it is of the same instrument", () => {
    const one = insertFragment(blank(), questions(source(), "gaming", 0, ["hours_week"]), { sectionKey: "welcome" }, opts).draft;
    const two = insertFragment(one, questions(source(), "gaming", 0, ["social_pct"]), { sectionKey: "welcome" }, opts).draft;
    expect(asked(two)).toEqual(["pilot_studio.welcome", "ybm_gaming.hours_week", "ybm_gaming.social_pct"]);
    expect(two.composition.sections[0]!.components).toHaveLength(2);
    publishable(two);
  });
});

// ---------------------------------------------------------------------------

describe("provenance", () => {
  it("is what a version keeps: trimmed to the questions it still asks", () => {
    let d = insertFragment(blank(), block(source(), "gaming", 0), { sectionKey: "welcome" }, opts).draft;
    d = insertFragment(d, questions(source(), "phones", 0, ["own"]), { sectionKey: "welcome" }, { ...opts, importId: "imp_two" }).draft;
    d = ops.archiveQuestion(d, "ybm_gaming.social_pct", opts).draft;
    d = ops.archiveQuestion(d, "ybm_smartphone.own", opts).draft;
    const kept = importsForVersion(d);
    expect(kept.map((r) => r.id)).toEqual(["imp_test"]);
    expect(Object.keys(kept[0]!.items)).not.toContain("ybm_gaming.social_pct");
    expect(Object.keys(kept[0]!.items)).toHaveLength(7);
    expect(provenanceOf(d, "ybm_gaming.top_games")).toEqual({ record: d.imports![0], sourceKey: "ybm_gaming.top_games" });
    expect(provenanceOf(d, "pilot_studio.welcome")).toBeNull();
  });

  it("keeps renames only for questions still asked, and drops whether an update was dismissed", () => {
    const record: ImportRecord = {
      id: "imp_x",
      at: opts.at,
      by: opts.by,
      byEmail: opts.byEmail,
      origin: { kind: "module", moduleId: "gaming", version: 1, contentHash: "" },
      items: { "pilot_studio.welcome": "x.welcome", "pilot_studio.gone": "x.gone" },
      renamed: { "x.welcome": "pilot_studio.welcome", "x.gone": "pilot_studio.gone" },
      variablesRenamed: { welcome_x: "welcome", gone_x: "gone" },
      dismissed: 3,
    };
    const d = { ...structuredClone(blank()), imports: [record] };
    expect(importsForVersion(d)).toEqual([
      {
        id: "imp_x",
        at: opts.at,
        by: opts.by,
        byEmail: opts.byEmail,
        origin: record.origin,
        items: { "pilot_studio.welcome": "x.welcome" },
        renamed: { "x.welcome": "pilot_studio.welcome" },
        variablesRenamed: { welcome_x: "welcome" },
      },
    ]);
  });

  it("names the releases a publish must read: each once, only while something is left of it, at most the cap", () => {
    const records: ImportRecord[] = [];
    for (let i = 0; i < MAX_IMPORTED_RELEASES + 5; i++) {
      const hash = `sha256:${i.toString(16).padStart(64, "0")}`;
      const origin: FragmentOrigin = { kind: "release", study: i % 2 ? "ybm" : "pilot", surveyId: "s", version: "1.0.0", hash };
      records.push({ id: `imp_${i}`, at: opts.at, by: opts.by, byEmail: opts.byEmail, origin, items: { "pilot_studio.welcome": "x.y" } });
      records.push({ id: `imp_${i}b`, at: opts.at, by: opts.by, byEmail: opts.byEmail, origin, items: { "pilot_studio.welcome": "x.y" } });
    }
    records.push({ id: "imp_gone", at: opts.at, by: opts.by, byEmail: opts.byEmail, origin: { ...FROM_R8 }, items: { "ybm_gaming.gone": "ybm_gaming.gone" } });
    records.push({ id: "imp_val", at: opts.at, by: opts.by, byEmail: opts.byEmail, origin: { kind: "validated", instrument: "kss", refKey: "k" }, items: { "pilot_studio.welcome": "x" } });
    const { releases, overLimit } = importedReleases({ ...structuredClone(blank()), imports: records });
    expect(releases).toHaveLength(MAX_IMPORTED_RELEASES);
    expect(overLimit).toBe(5);
    expect(releases[0]).toEqual({ study: "pilot", hash: `sha256:${"0".repeat(64)}` });
    expect(releases.some((r) => r.hash === r800.hash)).toBe(false);
    expect(importedReleases(blank())).toEqual({ releases: [], overLimit: 0 });
  });

  it("is carried through a stored draft, a damaged entry dropped rather than refusing the draft", () => {
    const d = insertFragment(blank(), block(source(), "gaming", 0), { sectionKey: "welcome" }, opts).draft;
    expect(parseDraft(serialiseDraft(d))).toEqual(d);
    expect(parseDraft(serialiseDraft(blank())).imports).toBeUndefined();
    const damaged = JSON.parse(serialiseDraft(d));
    damaged.imports.push({ id: 3 }, { ...damaged.imports[0], origin: { kind: "release", study: "ybm" } }, "nonsense", {
      ...damaged.imports[0],
      id: "imp_ok",
      renamed: "not a map",
      extra: "dropped",
    });
    const read = parseDraft(JSON.stringify(damaged));
    expect(read.imports!.map((r) => r.id)).toEqual(["imp_test", "imp_ok"]);
    expect(read.imports![1]).not.toHaveProperty("renamed");
    expect(read.imports![1]).not.toHaveProperty("extra");
  });

  it("is not a change to the survey: the change summary and bump ignore it", () => {
    const d = insertFragment(blank(), block(source(), "gaming", 0), { sectionKey: "welcome" }, opts).draft;
    const without = { ...structuredClone(d) };
    delete without.imports;
    const summary = diffDrafts(without, d);
    expect(summary.entries).toEqual([]);
    expect(suggestBump(summary)).toBeNull();
    expect(validateDraft(d, {})).toEqual(validateDraft(without, {}));
  });
});

// ---------------------------------------------------------------------------

describe("saved modules", () => {
  const MODULE: FragmentOrigin = { kind: "module", moduleId: "gaming_habits", version: 1, contentHash: "" };

  it("can be made only of editable content that makes sense on its own", () => {
    expect(moduleProblems(block(source(), "gaming", 0))).toEqual([]);
    expect(moduleProblems(block(source(), "wellbeing", 1)).map((i) => i.code)).toContain("piece.locked");
    expect(moduleProblems(validatedFragment(SDQ2)).map((i) => i.code)).toEqual(["piece.locked"]);
    expect(moduleProblems(block(source(), "welcome", 0)).map((i) => i.code)).toEqual(["piece.protected"]);
    // A validated questionnaire relicensed in the piece is still one.
    const relicensed = validatedFragment(SDQ2);
    (relicensed.blocks[0]!.definition as Loose).licence = { status: "open", modifiable: "yes" };
    expect(moduleProblems(relicensed).map((i) => i.code)).toEqual(["piece.locked"]);

    const outside = questions(source(), "gaming", 0, ["top_games"]);
    const problems = moduleProblems(outside);
    expect(problems.map((i) => i.code)).toEqual(["piece.condition_outside"]);
    expect(problems[0]!.location).toMatchObject({ kind: "question", itemKey: "ybm_gaming.top_games", field: "displayIf" });
    const fixed = withoutOutsideConditions(outside);
    expect(fixed.removed).toEqual([{ itemKey: "ybm_gaming.top_games", block: null, reason: "It tests ybm_gaming.hours_week, which is not in the piece." }]);
    expect(moduleProblems(fixed.fragment)).toEqual([]);
    expect(outside.blocks[0]!.definition.forms[0]!.items[0]).toHaveProperty("displayIf");

    const malformed = structuredClone(block(source(), "gaming", 0));
    delete (malformed.blocks[0]!.definition.forms[0]!.items[0] as Loose).variable;
    expect(moduleProblems(malformed).map((i) => i.code)).toContain("piece.schema");

    const missingScale = structuredClone(block(source(), "gaming", 0));
    missingScale.scales = {};
    expect(moduleProblems(missingScale).map((i) => i.code)).toContain("piece.scale_missing");

    const large = structuredClone(block(source(), "gaming", 0));
    (large.blocks[0]!.definition.forms[0]!.items[0] as Loose).researcherNote = "x".repeat(MAX_MODULE_CHARS);
    expect(moduleProblems(large).map((i) => i.code)).toEqual(["piece.too_large"]);

    expect(moduleProblems({ ...block(source(), "gaming", 0), blocks: [] }).map((i) => i.code)).toEqual(["piece.empty"]);
    expect(moduleProblems({ format: "x" } as unknown as StudioFragment).map((i) => i.code)).toEqual(["piece.malformed"]);
  });

  it("are stored as canonical JSON whose hash depends only on the content, the module and the version", async () => {
    const a = block(source(), "gaming", 0);
    const b = { ...block(source(), "gaming", 0, { kind: "validated", instrument: "x", refKey: "y" }), junk: "ignored" } as StudioFragment;
    const one = await moduleContent(a, { moduleId: "gaming_habits", version: 1 });
    const two = await moduleContent(b, { moduleId: "gaming_habits", version: 1 });
    expect(two).toEqual(one);
    expect(one.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await moduleContentHash(one.content)).toBe(one.contentHash);
    const stored = JSON.parse(one.content) as StudioFragment;
    expect(stored.origin).toEqual({ kind: "module", moduleId: "gaming_habits", version: 1, contentHash: "" });
    expect(canonicalJson(stored)).toBe(one.content);
    expect((await moduleContent(a, { moduleId: "gaming_habits", version: 2 })).contentHash).not.toBe(one.contentHash);
    const reworded = structuredClone(a);
    (reworded.blocks[0]!.definition.forms[0]!.items[0] as Loose).stem.text += " Roughly.";
    expect((await moduleContent(reworded, { moduleId: "gaming_habits", version: 1 })).contentHash).not.toBe(one.contentHash);
    // Key order is not content.
    const reverse = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverse) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v;
    const shuffled = reverse(a) as StudioFragment;
    expect((await moduleContent(shuffled, { moduleId: "gaming_habits", version: 1 })).contentHash).toBe(one.contentHash);
  });

  it("record the saving survey's questions as the module's, so later versions notify it too", () => {
    const d = insertFragment(blank(), block(source(), "gaming", 0), { sectionKey: "welcome" }, opts).draft;
    const saved = { ...block(d, "welcome", 1), origin: { ...MODULE, contentHash: "sha256:" + "1".repeat(64) } };
    const recorded = recordSavedModule(d, saved, { ...opts, importId: "imp_saved" }).draft;
    expect(recorded.imports!.map((r) => r.id)).toEqual(["imp_test", "imp_saved"]);
    expect(Object.keys(recorded.imports![1]!.items)).toHaveLength(8);
    expect(pendingModuleUpdates(recorded, { gaming_habits: 1 })).toEqual([]);
    expect(pendingModuleUpdates(recorded, { gaming_habits: 2 })).toEqual([
      { importId: "imp_saved", moduleId: "gaming_habits", from: 1, to: 2, itemKeys: Object.keys(recorded.imports![1]!.items) },
    ]);
    // Saving version 2 from it supersedes version 1's claim.
    const v2 = recordSavedModule(recorded, { ...saved, origin: { ...MODULE, version: 2 } }, { ...opts, importId: "imp_v2" }).draft;
    expect(v2.imports!.map((r) => r.id)).toEqual(["imp_test", "imp_v2"]);
    expect(refusal(() => recordSavedModule(d, block(d, "welcome", 1), opts)).message).toMatch(/not a version of a saved module/);
  });

  it("notify until dismissed, and again for a later version", () => {
    const f = { ...block(source(), "gaming", 0), origin: MODULE };
    const d = insertFragment(blank(), f, { sectionKey: "welcome" }, opts).draft;
    expect(pendingModuleUpdates(d, { gaming_habits: 2 })).toHaveLength(1);
    const dismissed = dismissModuleUpdate(d, "imp_test", 2).draft;
    expect(dismissed.imports![0]!.dismissed).toBe(2);
    expect(pendingModuleUpdates(dismissed, { gaming_habits: 2 })).toEqual([]);
    expect(pendingModuleUpdates(dismissed, { gaming_habits: 3 })).toHaveLength(1);
    expect(refusal(() => dismissModuleUpdate(d, "imp_test", 1)).code).toBe("invalid");
    expect(refusal(() => dismissModuleUpdate(d, "imp_none", 2)).code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------

describe("updating a module copy, three ways", () => {
  const v1Origin: FragmentOrigin = { kind: "module", moduleId: "gaming_habits", version: 1, contentHash: "sha256:" + "1".repeat(64) };
  const v2Origin: FragmentOrigin = { kind: "module", moduleId: "gaming_habits", version: 2, contentHash: "sha256:" + "2".repeat(64) };
  const stem = (f: StudioFragment | StudioDraft, key: string): Loose => {
    const items = "blocks" in f ? (f.blocks[0]!.definition.forms[0]!.items as Loose[]) : (f.instruments[GAMING]!.forms[0]!.items as Loose[]);
    return items.find((i) => i.key === key)!;
  };

  function setUp() {
    const v1 = { ...block(source(), "gaming", 0), origin: v1Origin };
    const v2 = structuredClone({ ...v1, origin: v2Origin }) as StudioFragment;
    const v2items = v2.blocks[0]!.definition.forms[0]!.items as Loose[];
    stem(v2, "hours_week").stem = { text: "In a usual week, how many hours do you spend playing games?" }; // changed upstream only
    stem(v2, "game_time_1").stem = { ...stem(v2, "game_time_1").stem, text: "Time on your first game, each week" }; // changed both
    v2items.splice(v2items.findIndex((i) => i.key === "game_time_4"), 1); // removed, unchanged here
    v2items.splice(v2items.findIndex((i) => i.key === "game_time_5"), 1); // removed, changed here
    v2items.push({ ...structuredClone(stem(v2, "social_pct")), key: "solo_pct", variable: "gaming_solo_pct", stem: { text: "How much of your gaming is on your own?" } });
    (v2.scales["scale.game_hours_5pt"]!.options[0] as Loose).label = "Less than an hour"; // options of game_time_1..3 change upstream
    let d = insertFragment(blank(), v1, { sectionKey: "welcome" }, opts).draft;
    d = ops.updateQuestion(d, "ybm_gaming.top_games", { stem: { text: "Which games do you play most?" } }).draft; // changed here only
    d = ops.updateQuestion(d, "ybm_gaming.game_time_1", { required: "hard" }).draft;
    d = ops.updateQuestion(d, "ybm_gaming.game_time_5", { hint: "Your best guess is fine." }).draft;
    return { v1, v2, d };
  }

  it("plans question by question, and changes nothing", () => {
    const { v1, v2, d } = setUp();
    const plan = planModuleUpdate(d, "imp_test", v1, v2);
    const outcome = Object.fromEntries(plan.changes.map((c) => [c.sourceKey, c.outcome]));
    expect(outcome).toEqual({
      "ybm_gaming.hours_week": "updated",
      "ybm_gaming.top_games": "kept_local",
      "ybm_gaming.game_time_1": "kept_local_conflict",
      "ybm_gaming.game_time_2": "updated",
      "ybm_gaming.game_time_3": "updated",
      "ybm_gaming.social_pct": "unchanged",
      "ybm_gaming.solo_pct": "added",
      "ybm_gaming.game_time_4": "archived",
      "ybm_gaming.game_time_5": "kept_removed_upstream",
    });
    expect(plan).toMatchObject({ importId: "imp_test", moduleId: "gaming_habits", from: 1, to: 2 });
    expect(d.imports![0]!.origin).toEqual(v1Origin);
  });

  it("applies it as one edit: IDs and variables kept, removed questions archived, new ones added, the record moved on", () => {
    const { v1, v2, d } = setUp();
    const { draft, plan } = updateFromModule(d, "imp_test", v1, v2, opts);
    expect(stem(draft, "hours_week").stem.text).toBe("In a usual week, how many hours do you spend playing games?");
    expect(stem(draft, "hours_week").variable).toBe("gaming_hours_week");
    expect(stem(draft, "top_games").stem.text).toBe("Which games do you play most?");
    expect(stem(draft, "game_time_1").required).toBe("hard");
    expect(stem(draft, "game_time_1").stem.text).not.toBe("Time on your first game, each week");
    expect(draft.archived.map((a) => a.itemKey)).toEqual(["ybm_gaming.game_time_4"]);
    expect(findQuestion(draft, "ybm_gaming.game_time_5")).not.toBeNull();
    expect(findQuestion(draft, "ybm_gaming.solo_pct")!.item.variable).toBe("gaming_solo_pct");
    expect(asked(draft).at(-1)).toBe("ybm_gaming.solo_pct");
    // game_time_1 kept its options while game_time_2 and 3 took the newer ones: it has its own list now.
    const g1 = stem(draft, "game_time_1").scale;
    const g2 = stem(draft, "game_time_2").scale;
    expect(g2).not.toBe(g1);
    expect(draft.scales[g2]!.options[0]!.label).toBe("Less than an hour");
    expect(draft.scales[g1]!.options[0]!.label).not.toBe("Less than an hour");
    const record = draft.imports![0]!;
    expect(record.origin).toEqual(v2Origin);
    expect(record.items["ybm_gaming.solo_pct"]).toBe("ybm_gaming.solo_pct");
    expect(plan.changes.find((c) => c.sourceKey === "ybm_gaming.solo_pct")!.itemKey).toBe("ybm_gaming.solo_pct");
    expect(pendingModuleUpdates(draft, { gaming_habits: 2 })).toEqual([]);
    publishable(draft);
    expect(errors(draft, { baseline: lockBaseline(null, draft) })).toEqual([]);
  });

  it("changes a list in place when only updated questions use it, retiring a published value it drops", () => {
    const v1 = { ...questions(source(), "gaming", 0, ["hours_week"]), origin: v1Origin };
    const v2 = structuredClone({ ...v1, origin: v2Origin }) as StudioFragment;
    const options = v2.scales["scale.gaming_hours_6pt"]!.options;
    const dropped = options.pop()!;
    const d = insertFragment(blank(), v1, { sectionKey: "welcome" }, opts).draft;
    const reserved = { itemKeys: new Set(["ybm_gaming.hours_week"]), variables: new Set(["gaming_hours_week"]) };
    const { draft } = updateFromModule(d, "imp_test", v1, v2, { ...opts, reserved });
    expect(item(draft, "ybm_gaming.hours_week")!.scale).toBe("scale.gaming_hours_6pt");
    expect(draft.scales["scale.gaming_hours_6pt"]!.options).toHaveLength(options.length);
    expect(draft.retiredCodes["scale.gaming_hours_6pt"]).toEqual([{ code: dropped.code, label: dropped.label, retiredAt: opts.at }]);
  });

  it("refuses versions that are not this copy's module, or not newer", () => {
    const { v1, v2, d } = setUp();
    expect(refusal(() => planModuleUpdate(d, "imp_test", v2, v1)).code).toBe("invalid");
    expect(refusal(() => planModuleUpdate(d, "imp_test", { ...v1, origin: { ...v1Origin, moduleId: "other" } }, v2)).code).toBe("invalid");
    expect(refusal(() => planModuleUpdate(d, "imp_nope", v1, v2)).code).toBe("not_found");
  });
});

describe("a repository module as a library piece (D-58)", () => {
  const LANGUAGE_KEYS = (() => {
    const form = allModules.find((m) => m.instrument === "ybm_demographics")!.forms[0]!;
    const keys = form.items.map((i) => i.key);
    return keys.slice(keys.indexOf("first_language_english"), keys.indexOf("gender"));
  })();
  const languages = () =>
    repositoryModuleFragment("ybm_demographics", { itemKeys: LANGUAGE_KEYS, title: "Languages: understanding and speaking" });

  it("carries only the questions asked for, their option lists, and conditions inside the piece", () => {
    const piece = languages();
    expect(questionCount(piece)).toBe(LANGUAGE_KEYS.length);
    expect(Object.keys(piece.scales).sort()).toEqual([
      "scale.first_language_english",
      "scale.language_ability_5",
      "scale.other_languages",
      "scale.yes_no",
    ]);
    expect(moduleProblems(piece)).toEqual([]);
  });

  it("drops into a published survey straight after Ethnicity, joining its block, and publishes", () => {
    const base = extractDraft(r800);
    const { draft, report } = insertFragment(base, languages(), { sectionKey: "about_you", afterItemKey: "ybm_demographics.ethnicity" }, opts);
    expect(report.renamed).toEqual([]);
    expect(report.variablesRenamed).toEqual([]);
    expect(report.conditionsRemoved).toEqual([]);
    const order = asked(draft).filter((k) => k.startsWith("ybm_demographics."));
    expect(order.slice(0, 3)).toEqual(["ybm_demographics.ethnicity", "ybm_demographics.first_language_english", "ybm_demographics.speaks_other_language"]);
    expect(order).toContain("ybm_demographics.understand_urdu");
    expect(order.indexOf("ybm_demographics.speak_urdu")).toBe(order.indexOf("ybm_demographics.understand_urdu") + 1);
    expect(order.at(-2)).toBe("ybm_demographics.gender");
    expect(errors(draft, { baseline: extractDraft(r800) })).toEqual([]);
    publishable(draft);
  });

  it("refuses a module or question that is not there", () => {
    expect(refusal(() => repositoryModuleFragment("ybm_nothing", { title: "x" })).code).toBe("not_found");
    expect(refusal(() => repositoryModuleFragment("ybm_demographics", { itemKeys: ["nope"], title: "x" })).code).toBe("not_found");
  });
});
