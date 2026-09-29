import { describe, expect, it } from "vitest";
import { AnswerStore, Walker, type PresentableUnit } from "@myself/engine";
import { releaseManifest, responseScale, type ItemDefinition, type LogicExpr, type ResponseScale } from "@myself/schema";
import { flattenManifest } from "@participant/lib/flatten.js";
import { describeAnswer } from "@participant/components/ReviewScreen.js";
import rawR730 from "../../../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json";
import { describeCondition, type DescribeContext } from "./model-adapter.js";
import {
  answerSummaries,
  computeVisibility,
  conditionTargets,
  pathEntries,
  problemParts,
  resolveStart,
  restartPoint,
  sectionRuns,
  shorten,
  unitKeyOf,
  unitLabel,
} from "./path.js";
import type { StateMessage } from "./protocol.js";

const r730 = releaseManifest.parse(rawR730);
const yesNo = responseScale.parse(r730.scales["scale.yes_no"]);
const scales = new Map<string, ResponseScale>([["scale.yes_no", yesNo]]);

const ref = (item: string) => ({ instrument: "q", item, revision: 1 });
const selected = (item: string, code: number): LogicExpr => ({ op: "selected", target: { item: ref(item) }, code });

const question = (key: string, extra: Record<string, unknown> = {}): ItemDefinition =>
  ({
    key,
    revision: 1,
    variable: key,
    responseType: "single_choice",
    scale: "scale.yes_no",
    stem: { text: `Question ${key}?` },
    required: "optional",
    allowDecline: true,
    identifying: false,
    ...extra,
  }) as ItemDefinition;

// a → b only after "Yes" to a → c when a was answered and (b is "No" or a is not "Yes").
const cCondition: LogicExpr = {
  op: "all",
  args: [
    { op: "answered", target: { item: ref("a") } },
    { op: "any", args: [selected("b", 2), { op: "not_selected", target: { item: ref("a") }, code: 1 }] },
  ],
};
const units: PresentableUnit[] = [
  { instrument: "q", sectionKey: "s1", item: question("a") },
  { instrument: "q", sectionKey: "s1", item: question("b"), displayIf: selected("a", 1) },
  { instrument: "q", sectionKey: "s2", item: question("c"), displayIf: cCondition },
];

const state = (partial: Partial<StateMessage>): StateMessage => ({
  type: "studio-preview:state",
  nonce: "nonce-000001",
  phase: "running",
  index: 0,
  itemKey: "q.a",
  answers: {},
  visibility: {},
  ...partial,
});

describe("preview visibility", () => {
  it("hides what a condition hides, and tells seen from not reached", () => {
    const store = new AnswerStore();
    expect(computeVisibility(units, store, new Set())).toEqual({ "q.a": "not_reached", "q.b": "hidden", "q.c": "hidden" });

    store.set(ref("a"), { status: "answered", value: { kind: "choice", code: 1 } });
    expect(computeVisibility(units, store, new Set(["q.a"]))).toEqual({
      "q.a": "shown",
      "q.b": "not_reached",
      "q.c": "hidden",
    });

    store.set(ref("a"), { status: "answered", value: { kind: "choice", code: 2 } });
    expect(computeVisibility(units, store, new Set(["q.a", "q.b"]))).toEqual({
      // Seen earlier, but the changed answer now hides it.
      "q.a": "shown",
      "q.b": "hidden",
      "q.c": "not_reached",
    });
  });

  it("agrees with the participant engine's own walk on r7.3.0", () => {
    const flat = flattenManifest(r730);
    const store = new AnswerStore();
    const check = () => {
      const visibility = computeVisibility(flat.units, store, new Set());
      const shown = new Walker(flat.units, store, true).visibleUnits().map((i) => unitKeyOf(flat.units[i]!));
      const notHidden = flat.units.map(unitKeyOf).filter((k) => visibility[k] !== "hidden");
      expect(notHidden).toEqual(shown);
      return visibility;
    };

    let visibility = check();
    // The social media section is shown only to people who use social media.
    const socialMedia = flat.units.filter((u) => u.sectionKey === "social_media").map(unitKeyOf);
    expect(socialMedia.length).toBeGreaterThan(5);
    expect(socialMedia.every((k) => visibility[k] === "hidden")).toBe(true);

    store.set({ instrument: "ybm_smartphone", item: "sm_use", revision: 1 }, { status: "answered", value: { kind: "choice", code: 1 } });
    visibility = check();
    expect(visibility["ybm_social_media.apps_owned"]).toBe("not_reached");
    // Each app's time question still waits on the app being chosen.
    expect(visibility["ybm_social_media.time_tiktok"]).toBe("hidden");
  });
});

describe("preview path rows", () => {
  it("marks the current screen, answers, and what hidden rows are waiting on", () => {
    const rows = pathEntries(
      units,
      state({
        index: 0,
        answers: { "q.a": "No" },
        visibility: { "q.a": "shown", "q.b": "hidden", "q.c": "not_reached" },
      }),
    );
    expect(rows.map((r) => r.state)).toEqual(["current", "hidden", "not_reached"]);
    expect(rows[0]!.answer).toBe("No");
    expect(rows[1]!.drivers).toEqual([{ itemKey: "q.a", answer: "No" }]);
    expect(rows[2]!.drivers).toEqual([]);
  });

  it("keeps an answer on a row its condition now hides", () => {
    const rows = pathEntries(
      units,
      state({ phase: "finished", index: null, itemKey: null, answers: { "q.b": "Yes" }, visibility: { "q.b": "hidden" } }),
    );
    expect(rows[1]).toMatchObject({ state: "hidden", answer: "Yes" });
    expect(rows[1]!.drivers).toEqual([{ itemKey: "q.a", answer: null }]);
  });

  it("reports nothing as reached before the frame has said anything", () => {
    expect(pathEntries(units, null).map((r) => r.state)).toEqual(["not_reached", "not_reached", "not_reached"]);
  });

  it("reads answers back in the participant's own words", () => {
    const store = new AnswerStore();
    store.set(ref("a"), { status: "answered", value: { kind: "choice", code: 1 } });
    store.set(ref("b"), { status: "skipped" });
    store.set(ref("c"), { status: "declined" });
    expect(answerSummaries(units, store, scales, describeAnswer)).toEqual({
      "q.a": "Yes",
      "q.b": "Left blank",
      "q.c": "Prefer not to say",
    });

    const long = new AnswerStore();
    long.set(ref("a"), { status: "answered", value: { kind: "text", value: "word ".repeat(40) } });
    const summary = answerSummaries(units, long, scales, describeAnswer)["q.a"]!;
    expect(summary.length).toBeLessThanOrEqual(60);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("groups screens into runs by section, in order", () => {
    const titles = new Map([
      ["s1", "First"],
      ["s2", "Second"],
    ]);
    expect(sectionRuns(units, titles)).toEqual([
      { sectionKey: "s1", title: "First", indices: [0, 1] },
      { sectionKey: "s2", title: "Second", indices: [2] },
    ]);
  });

  it("labels instruction screens by their instrument", () => {
    const flat = flattenManifest(r730);
    const swemwbs = flat.units.find((u) => u.item.key === "__instructions_swemwbs")!;
    expect(unitLabel(swemwbs, new Map([["swemwbs", "Short Warwick–Edinburgh Mental Wellbeing Scale"]]))).toBe(
      "Instructions: Short Warwick–Edinburgh Mental Wellbeing Scale",
    );
    expect(unitLabel(units[0]!, new Map())).toBe("Question a?");
    expect(shorten("a  b\n c", 10)).toBe("a b c");
  });
});

describe("preview start points", () => {
  it("resolves a start to a screen, or to the start screen when it no longer exists", () => {
    expect(resolveStart(units, null, true)).toEqual({ kind: "start" });
    expect(resolveStart(units, "q.c", true)).toEqual({ kind: "running", index: 2 });
    expect(resolveStart(units, "q.gone", true)).toEqual({ kind: "start" });
    expect(resolveStart(units, "finish", true)).toEqual({ kind: "finished" });
    expect(resolveStart(units, "review", true)).toEqual({ kind: "review" });
    // A survey with no review screen has nowhere to show one.
    expect(resolveStart(units, "review", false)).toEqual({ kind: "finished" });
  });
});

describe("picking the run up after the draft changes", () => {
  const keys = new Set(units.map(unitKeyOf));

  it("stays on the screen the frame last reported", () => {
    expect(restartPoint(state({ phase: "running", index: 2, itemKey: "q.c" }), keys)).toBe("q.c");
    // The check-in and pace screens report the question they lead to.
    expect(restartPoint(state({ phase: "checkin", index: 1, itemKey: "q.b" }), keys)).toBe("q.b");
    expect(restartPoint(state({ phase: "finished", index: null, itemKey: null }), keys)).toBe("finish");
    expect(restartPoint(state({ phase: "review", index: null, itemKey: null }), keys)).toBe("review");
  });

  it("keeps a researcher on the start screen there, not at the chosen starting question", () => {
    // null is "the start screen"; it must not be read as "unknown", which the
    // page answers with the "Start from…" choice.
    expect(restartPoint(state({ phase: "start", index: null, itemKey: null }), keys)).toBeNull();
  });

  it("does not know where to go without a report, after an error, or when the question has gone", () => {
    expect(restartPoint(null, keys)).toBeUndefined();
    expect(restartPoint(state({ phase: "error", index: null, itemKey: null, error: "x" }), keys)).toBeUndefined();
    expect(restartPoint(state({ phase: "running", index: 0, itemKey: "q.deleted" }), keys)).toBeUndefined();
  });
});

describe("problem lines", () => {
  it("sets a leading field path apart from what is wrong with it", () => {
    expect(problemParts("composition.sections.0.key: Required")).toEqual({
      path: "composition.sections.0.key",
      message: "Required",
    });
    expect(problemParts("(draft): Expected object")).toEqual({ path: "(draft)", message: "Expected object" });
  });

  it("leaves a sentence that merely contains a colon whole", () => {
    const line = "manifest inconsistency: 'kss@1.0/en-GB/self/standard' has no question 'q9'";
    expect(problemParts(line)).toEqual({ path: null, message: line });
    expect(problemParts("No colon here")).toEqual({ path: null, message: "No colon here" });
    expect(problemParts(": leading")).toEqual({ path: null, message: ": leading" });
  });
});

describe("conditions in plain English", () => {
  const byKey = new Map(units.map((u) => [unitKeyOf(u), u]));
  const ctx: DescribeContext = {
    questionLabel: (key) => `“${byKey.get(key)?.item.stem.text ?? key}”`,
    optionLabel: (_key, code) => yesNo.options.find((o) => o.code === code)?.label ?? null,
    isMulti: () => false,
  };

  it("names the questions and options, not their codes", () => {
    expect(describeCondition(selected("a", 1), ctx)).toBe("“Question a?” is “Yes”");
    expect(describeCondition(cCondition, ctx)).toBe(
      "“Question a?” is answered and (“Question b?” is “No” or “Question a?” is answered with something other than “Yes”)",
    );
    expect(
      describeCondition({ op: "gte", target: { item: ref("n") }, value: 3 }, { ...ctx, optionLabel: () => null }),
    ).toBe("“q.n” is 3 or more");
    expect(
      describeCondition({ op: "in_group", target: { item: ref("a") }, group: "have", code: 2 }, ctx),
    ).toBe("“Question a?” puts “No” in “have”");
  });

  it("lists the questions a condition reads, once each, in order", () => {
    expect(conditionTargets(cCondition)).toEqual(["q.a", "q.b"]);
    expect(conditionTargets(undefined)).toEqual([]);
  });
});
