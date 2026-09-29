import { describe, expect, it } from "vitest";
import type { ItemDefinition, LogicExpr } from "@myself/schema";
import { AnswerStore } from "./answers.js";
import { evaluate } from "./evaluate.js";
import { Walker, type PresentableUnit } from "./walker.js";

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
