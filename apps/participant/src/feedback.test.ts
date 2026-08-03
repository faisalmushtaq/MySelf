import { describe, expect, it } from "vitest";
import { AnswerStore } from "@myself/engine";
import { releaseManifest, scoringDefinition } from "@myself/schema";
import rawManifest from "../../../releases/ybm_nd2026_standard_r6.0.0.manifest.json";
import { resolveText, useScoringDefinitions } from "./lib/pipes.js";

/**
 * Telling a participant their own score is only worth doing if the number is
 * right and the sentence still reads when it isn't available. A screen that
 * says "your score is undefined" is worse than no feedback at all.
 */

const manifest = releaseManifest.parse(rawManifest);
useScoringDefinitions(
  new Map(Object.entries(manifest.scoring).map(([k, v]) => [k, scoringDefinition.parse(v)])),
);

/** Answer all four EHI items with the same option code. */
const answerAll = (code: number): AnswerStore => {
  const store = new AnswerStore();
  for (const item of ["writing", "throwing", "toothbrush", "spoon"]) {
    store.set({ instrument: "ehi_sf", item, revision: 1 }, { status: "answered", value: { kind: "choice", code } });
  }
  return store;
};

describe("handedness feedback", () => {
  const pipes = {
    lq: { kind: "score" as const, scoringKey: "score.ehi_sf", output: "lq", decimals: 1, fallback: "not complete" },
    band: {
      kind: "score" as const,
      scoringKey: "score.ehi_sf",
      output: "lq_band",
      fallback: "somewhere in the middle",
    },
  };
  const say = (store: AnswerStore) => ({
    lq: resolveText("{lq}", { lq: pipes.lq }, store, new Date()),
    band: resolveText("{band}", { band: pipes.band }, store, new Date()),
  });

  it("scores someone who always uses their right hand at the top of the scale", () => {
    // canonical scale is right-first: code 1 = "Always right" = +100
    expect(say(answerAll(1))).toEqual({ lq: "100.0", band: "very right-handed" });
  });

  it("scores someone who always uses their left hand at the bottom", () => {
    expect(say(answerAll(5))).toEqual({ lq: "-100.0", band: "very left-handed" });
  });

  it("puts someone who uses either hand in the middle", () => {
    expect(say(answerAll(3))).toEqual({ lq: "0.0", band: "equally comfortable with either hand" });
  });

  it("scores a mixed pattern between the extremes", () => {
    const store = new AnswerStore();
    const codes = { writing: 1, throwing: 1, toothbrush: 2, spoon: 2 }; // +100,+100,+50,+50
    for (const [item, code] of Object.entries(codes)) {
      store.set({ instrument: "ehi_sf", item, revision: 1 }, { status: "answered", value: { kind: "choice", code } });
    }
    expect(say(store)).toEqual({ lq: "75.0", band: "right-handed" });
  });

  it("falls back to readable text when the items were not all answered", () => {
    // The mean requires all four; a partial answer set must not produce a
    // confident-looking number, and must not leave "{lq}" on screen either.
    const store = new AnswerStore();
    store.set({ instrument: "ehi_sf", item: "writing", revision: 1 }, { status: "answered", value: { kind: "choice", code: 1 } });
    expect(say(store)).toEqual({ lq: "not complete", band: "somewhere in the middle" });
  });

  it("falls back when nothing has been answered at all", () => {
    expect(say(new AnswerStore())).toEqual({ lq: "not complete", band: "somewhere in the middle" });
  });

  it("every band completes the sentence it is dropped into", () => {
    // The label is read inside "Your answers suggest you're ___", so a label
    // that does not finish that sentence is a bug in the wording, not a
    // formatting nicety.
    const def = manifest.scoring["score.ehi_sf"] as {
      steps: { op: string; bands?: { label: string }[] }[];
    };
    const bands = def.steps.find((st) => st.op === "classify")?.bands ?? [];
    expect(bands.length).toBeGreaterThan(0);
    for (const b of bands) {
      expect(`Your answers suggest you're ${b.label}`).toMatch(
        /^Your answers suggest you're [a-z][a-z -]+(hand(ed)?|with either hand)$/,
      );
    }
  });

  it("says nothing about whether a result is normal, unusual or a mistake", () => {
    // Report what the answers say about this person. Anything that excuses or
    // ranks the result is a judgement nobody asked for (D-34).
    const text = JSON.stringify(manifest.instruments);
    for (const phrase of ["not a mistake", "uncommon", "unusual", "normal", "most people"]) {
      expect(text.toLowerCase()).not.toContain(phrase);
    }
  });
});
