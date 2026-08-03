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
    lq: { kind: "score" as const, scoringKey: "score.ehi_sf", output: "lq", decimals: 1, fallback: "—" },
    band: { kind: "score" as const, scoringKey: "score.ehi_sf", output: "lq_band", fallback: "mixed-handed" },
  };
  const say = (store: AnswerStore) => ({
    lq: resolveText("{lq}", { lq: pipes.lq }, store, new Date()),
    band: resolveText("{band}", { band: pipes.band }, store, new Date()),
  });

  it("scores someone who always uses their right hand at the top of the scale", () => {
    // canonical scale is right-first: code 1 = "Always right" = +100
    expect(say(answerAll(1))).toEqual({ lq: "100.0", band: "strongly right-handed" });
  });

  it("scores someone who always uses their left hand at the bottom", () => {
    expect(say(answerAll(5))).toEqual({ lq: "-100.0", band: "strongly left-handed" });
  });

  it("puts someone who uses either hand in the middle", () => {
    expect(say(answerAll(3))).toEqual({ lq: "0.0", band: "mixed-handed" });
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
    expect(say(store)).toEqual({ lq: "—", band: "mixed-handed" });
  });

  it("falls back when nothing has been answered at all", () => {
    expect(say(new AnswerStore())).toEqual({ lq: "—", band: "mixed-handed" });
  });
});
