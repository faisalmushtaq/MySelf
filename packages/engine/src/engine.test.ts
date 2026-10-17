import { describe, expect, it } from "vitest";
import type { ItemDefinition, LogicExpr } from "@myself/schema";
import { AnswerStore } from "./answers.js";
import { evaluate } from "./evaluate.js";
import { computeVisibility, Walker, type PresentableUnit } from "./walker.js";

/**
 * Engine tests built on the YBM structure with the decided corrections:
 * - social-media branch (SM_Own = Yes) covering both branched blocks
 * - corrected gaming logic (D-03: games list for people who DO game)
 * - corrected Twitch row condition (D-02: in_group Twitch)
 */

const ref = (instrument: string, item: string) => ({ instrument, item, revision: 1 });

const stubItem = (key: string, variable: string): ItemDefinition => ({
  responseType: "single_choice",
  key,
  revision: 1,
  variable,
  stem: { text: key },
  required: "soft",
  allowDecline: false,
  identifying: false,
  scale: "scale.yes_no",
  scaleVersion: "1.0.0",
  presentation: "cards",
  spectrumReverse: false,
  autoAdvance: true,
});

const smUse = ref("ybm_smartphone", "sm_use");
const gamingHours = ref("ybm_gaming", "gaming_hours_week");
const appsOwned = ref("ybm_social_media", "sm_apps_owned");

const inBranch: LogicExpr = { op: "selected", target: { item: smUse }, code: 1 };
const gamerOnly: LogicExpr = { op: "not_selected", target: { item: gamingHours }, code: 1 };
const twitchRow: LogicExpr = { op: "in_group", target: { item: appsOwned }, group: "have", code: 9 };

const units: PresentableUnit[] = [
  { instrument: "ybm_smartphone", sectionKey: "phones", item: stubItem("sm_use", "sm_use") },
  {
    instrument: "ybm_social_media",
    sectionKey: "social_media",
    item: stubItem("sm_overuse", "sm_overuse"),
    displayIf: inBranch,
  },
  {
    instrument: "ybm_social_media",
    sectionKey: "social_media",
    item: stubItem("sm_time_twitch", "sm_time_twitch"),
    displayIf: { op: "all", args: [inBranch, twitchRow] },
  },
  {
    instrument: "ybm_screen_attitudes",
    sectionKey: "screens",
    item: stubItem("doomscroll_1", "doomscroll_1"),
    displayIf: inBranch, // Screen-control block is also inside the branch (QSF finding)
  },
  { instrument: "ybm_gaming", sectionKey: "gaming", item: stubItem("gaming_hours_week", "gaming_hours_week") },
  {
    instrument: "ybm_gaming",
    sectionKey: "gaming",
    item: stubItem("gaming_top_games", "gaming_top_games"),
    displayIf: gamerOnly,
  },
  { instrument: "ybm_state", sectionKey: "feelings", item: stubItem("stai5_q1", "stai5_q1") },
];

const answered = (code: number) => ({ status: "answered" as const, value: { kind: "choice" as const, code } });

describe("evaluate", () => {
  it("branch condition is false while unanswered, true after Yes", () => {
    const store = new AnswerStore();
    expect(evaluate(inBranch, store)).toBe(false);
    store.set(smUse, answered(1));
    expect(evaluate(inBranch, store)).toBe(true);
  });

  it("not_selected is false for unanswered questions (no leaking through)", () => {
    const store = new AnswerStore();
    expect(evaluate(gamerOnly, store)).toBe(false);
    store.set(gamingHours, answered(4)); // "Less than 5 hours"
    expect(evaluate(gamerOnly, store)).toBe(true);
    store.set(gamingHours, answered(1)); // "I do not play video games"
    expect(evaluate(gamerOnly, store)).toBe(false);
  });

  it("in_group matches only the declared group (D-02 Twitch fix)", () => {
    const store = new AnswerStore();
    store.set(appsOwned, {
      status: "answered",
      value: {
        kind: "group_rank",
        assignments: { 6: { group: "have", rank: 1 }, 9: { group: "dont_have" } },
      },
    });
    expect(evaluate(twitchRow, store)).toBe(false); // Twitch (9) not owned — X (6) being owned no longer leaks in
    store.set(appsOwned, {
      status: "answered",
      value: { kind: "group_rank", assignments: { 9: { group: "have", rank: 1 } } },
    });
    expect(evaluate(twitchRow, store)).toBe(true);
  });
});

describe("walker", () => {
  it("skips the whole social-media path for a non-user", () => {
    const store = new AnswerStore();
    store.set(smUse, answered(2)); // No
    store.set(gamingHours, answered(1)); // non-gamer
    const w = new Walker(units, store, true);
    const visible = w.visibleUnits().map((i) => units[i]!.item.key);
    expect(visible).toEqual(["sm_use", "gaming_hours_week", "stai5_q1"]);
  });

  it("routes a social-media-using gamer through everything relevant", () => {
    const store = new AnswerStore();
    store.set(smUse, answered(1));
    store.set(gamingHours, answered(5));
    store.set(appsOwned, {
      status: "answered",
      value: { kind: "group_rank", assignments: { 9: { group: "have", rank: 2 } } },
    });
    const w = new Walker(units, store, true);
    const visible = w.visibleUnits().map((i) => units[i]!.item.key);
    expect(visible).toEqual([
      "sm_use",
      "sm_overuse",
      "sm_time_twitch",
      "doomscroll_1",
      "gaming_hours_week",
      "gaming_top_games",
      "stai5_q1",
    ]);
  });

  it("next/back honour visibility and the back-navigation policy", () => {
    const store = new AnswerStore();
    store.set(smUse, answered(2));
    const w = new Walker(units, store, true);
    const first = w.first();
    expect(first).toBe(0);
    const second = w.next(first!);
    expect(units[second!]!.item.key).toBe("gaming_hours_week");
    expect(w.back(second!)).toBe(0);
    const noBack = new Walker(units, store, false);
    expect(noBack.back(second!)).toBeNull();
  });

  it("section progress reports reachable segments, not raw counts", () => {
    const store = new AnswerStore();
    store.set(smUse, answered(2));
    store.set(gamingHours, answered(1));
    const w = new Walker(units, store, true);
    const progress = w.sectionProgress(4);
    expect(progress.sections).toEqual(["phones", "gaming", "feelings"]);
    expect(progress.activeIndex).toBe(1);
  });
});

describe("age conditions (D-51)", () => {
  const dob = ref("ybm_identity", "dob");
  const adult: LogicExpr = { op: "age_gte", target: { item: dob }, years: 18 };
  const underAdult: LogicExpr = { op: "not", arg: adult };
  const born = (iso: string) => {
    const store = new AnswerStore();
    store.set(dob, { status: "answered", value: { kind: "date", iso } });
    return store;
  };
  const started = new Date("2026-09-29T10:15:00Z");

  it("counts whole years to the day the sitting started, turning 18 on the birthday itself", () => {
    expect(evaluate(adult, born("2008-09-29"), started)).toBe(true); // 18 today
    expect(evaluate(adult, born("2008-09-30"), started)).toBe(false); // 18 tomorrow
    expect(evaluate(adult, born("2008-10-01"), started)).toBe(false);
    expect(evaluate(adult, born("1990-01-01"), started)).toBe(true);
    expect(evaluate(adult, born("2013-02-11"), started)).toBe(false);
  });

  it("judges the age on the sitting's start, not on the day it is evaluated again", () => {
    // A sitting started the day before an 18th birthday stays an under-18 sitting
    // when it is resumed, or re-read by a researcher, after the birthday.
    const store = born("2008-09-30");
    expect(evaluate(adult, store, started)).toBe(false);
    expect(evaluate(adult, store, new Date("2026-10-05T09:00:00Z"))).toBe(true);
  });

  it("uses the UTC calendar date of the start, so every machine agrees", () => {
    // 23:30 UTC on the 28th is 00:30 on the 29th in London (BST); the rule reads the 28th.
    expect(evaluate(adult, born("2008-09-29"), new Date("2026-09-28T23:30:00Z"))).toBe(false);
    expect(evaluate(adult, born("2008-09-29"), new Date("2026-09-29T00:00:00Z"))).toBe(true);
  });

  it("is false without a usable date of birth or a sitting date, so the under-18 branch is taken", () => {
    const none = new AnswerStore();
    expect(evaluate(adult, none, started)).toBe(false);
    expect(evaluate(underAdult, none, started)).toBe(true);
    expect(evaluate(adult, born("not-a-date"), started)).toBe(false);
    expect(evaluate(adult, born("2008-13-01"), started)).toBe(false);
    expect(evaluate(adult, born("1990-01-01"))).toBe(false); // no sitting date supplied
    const skipped = new AnswerStore();
    skipped.set(dob, { status: "skipped" });
    expect(evaluate(underAdult, skipped, started)).toBe(true);
  });

  it("routes exactly one of two age-conditioned units through the walker", () => {
    const sdqUnits: PresentableUnit[] = [
      { instrument: "ybm_identity", sectionKey: "about_you", item: stubItem("dob", "dob") },
      { instrument: "sdq25_s", sectionKey: "wellbeing", item: stubItem("q1", "sdq25_q1"), displayIf: underAdult },
      { instrument: "sdq25_s18", sectionKey: "wellbeing", item: stubItem("q1", "sdq25_s18_q1"), displayIf: adult },
    ];
    const shown = (iso: string) =>
      new Walker(sdqUnits, born(iso), true, started).visibleUnits().map((i) => sdqUnits[i]!.instrument);
    expect(shown("2011-05-04")).toEqual(["ybm_identity", "sdq25_s"]);
    expect(shown("2008-09-29")).toEqual(["ybm_identity", "sdq25_s18"]);
    expect(new Walker(sdqUnits, born("2008-09-29"), true).visibleUnits().map((i) => sdqUnits[i]!.instrument)).toEqual([
      "ybm_identity",
      "sdq25_s",
    ]);
  });
});

describe("cascading visibility", () => {
  // The live repro: Yes to another language, tick Polish, answer the Polish
  // questions, then go back and say No.
  const speaks = ref("ybm_demographics", "speaks_other_language");
  const languages = ref("ybm_demographics", "other_languages");
  const understand = ref("ybm_demographics", "understand_polish");
  const POLISH = 3;
  const unitFor = (item: string, displayIf?: LogicExpr): PresentableUnit => ({
    instrument: "ybm_demographics",
    sectionKey: "about_you",
    item: stubItem(item, item),
    ...(displayIf ? { displayIf } : {}),
  });
  const chain: PresentableUnit[] = [
    unitFor("speaks_other_language"),
    unitFor("other_languages", { op: "selected", target: { item: speaks }, code: 1 }),
    unitFor("understand_polish", { op: "selected", target: { item: languages }, code: POLISH }),
    // A third level, and a condition that only asks whether there is an answer.
    unitFor("speak_polish", { op: "selected", target: { item: understand }, code: 1 }),
    unitFor("languages_note", { op: "answered", target: { item: languages } }),
    unitFor("sleep_hours"),
  ];
  const keys = (w: Walker) => w.visibleUnits().map((i) => chain[i]!.item.key);
  const yesPolish = () => {
    const store = new AnswerStore();
    store.set(speaks, answered(1));
    store.set(languages, { status: "answered", value: { kind: "multi", codes: [POLISH] } });
    store.set(understand, answered(1));
    return store;
  };

  it("shows every level while the chain holds", () => {
    expect(keys(new Walker(chain, yesPolish(), true))).toEqual([
      "speaks_other_language",
      "other_languages",
      "understand_polish",
      "speak_polish",
      "languages_note",
      "sleep_hours",
    ]);
  });

  it("hides everything downstream when an earlier answer changes, however deep", () => {
    const store = yesPolish();
    // One walker across the change, as SurveyScreen memoises it: the answer
    // written after it was built must still be seen.
    const w = new Walker(chain, store, true);
    expect(w.isVisible(2)).toBe(true);
    store.set(speaks, answered(2)); // back, and No
    expect(keys(w)).toEqual(["speaks_other_language", "sleep_hours"]);
    expect(w.next(0)).toBe(5);
    expect(w.back(5)).toBe(0);
    expect(w.sectionProgress(5).sections).toEqual(["about_you"]);
  });

  it("leaves stale answers out of what pipes and checks read, without touching the store", () => {
    const store = yesPolish();
    store.set(speaks, answered(2));
    const w = new Walker(chain, store, true);
    const visible = w.visibleAnswers();
    expect(visible.get(speaks)).toEqual(answered(2));
    expect(visible.get(languages)).toBeUndefined();
    expect(visible.isAnswered(understand)).toBe(false);
    // What was said is not edited: change back, and it is all there again.
    expect(store.get(understand)).toEqual(answered(1));
    store.set(speaks, answered(1));
    expect(keys(w)).toHaveLength(6);
    expect(w.visibleAnswers().get(understand)).toEqual(answered(1));
  });

  it("reports the hidden items by key, and reads targets outside the walk as stored", () => {
    const store = yesPolish();
    store.set(speaks, answered(2));
    const { visible, hidden } = computeVisibility(chain, store);
    expect(visible).toEqual([true, false, false, false, false, true]);
    expect([...hidden].sort()).toEqual([
      "ybm_demographics.languages_note",
      "ybm_demographics.other_languages",
      "ybm_demographics.speak_polish",
      "ybm_demographics.understand_polish",
    ]);
    const outside = [unitFor("understand_polish", { op: "selected", target: { item: languages }, code: POLISH })];
    expect(computeVisibility(outside, store).visible).toEqual([true]);
  });

  it("counts an item placed twice as shown when either placement is", () => {
    const store = new AnswerStore();
    store.set(speaks, answered(2));
    const twice: PresentableUnit[] = [
      unitFor("speaks_other_language"),
      unitFor("other_languages", { op: "selected", target: { item: speaks }, code: 1 }),
      unitFor("other_languages"),
    ];
    expect(computeVisibility(twice, store).hidden.size).toBe(0);
  });

  it("works out visibility once per answer, not once per question asked of it", () => {
    const store = new AnswerStore();
    const many: PresentableUnit[] = Array.from({ length: 220 }, (_, i) =>
      unitFor(`q${i}`, i === 0 ? undefined : { op: "answered", target: { item: ref("ybm_demographics", `q${i - 1}`) } }),
    );
    for (let i = 0; i < 220; i++) store.set(ref("ybm_demographics", `q${i}`), answered(1));
    const w = new Walker(many, store, true);
    let at: number | null = w.first();
    let steps = 0;
    while (at !== null) {
      at = w.next(at);
      steps += 1;
    }
    expect(steps).toBe(220);
    expect(w.visibleAnswers()).toBe(w.visibleAnswers());
    // Skipping the head of a 220-deep chain hides all of it.
    store.set(ref("ybm_demographics", "q0"), { status: "skipped" });
    expect(w.visibleUnits()).toEqual([0]);
  });
});
