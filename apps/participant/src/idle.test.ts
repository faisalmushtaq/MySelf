import { describe, expect, it } from "vitest";
import { HAND_BACK_IDLE, idleStage, SURVEY_IDLE } from "./lib/idle.js";

/** How long an untouched iPad keeps a sitting on screen (lib/idle.ts). */
describe("the idle lock", () => {
  it("hands a finished sitting back after two minutes, counting down the last twenty seconds", () => {
    expect(HAND_BACK_IDLE.quietMs + HAND_BACK_IDLE.countdownMs).toBe(2 * 60_000);
    expect(HAND_BACK_IDLE.countdownMs).toBe(20_000);
    expect(idleStage(99_999, HAND_BACK_IDLE)).toEqual({ kind: "active" });
    expect(idleStage(100_000, HAND_BACK_IDLE)).toEqual({ kind: "warning", secondsLeft: 20 });
    expect(idleStage(119_001, HAND_BACK_IDLE)).toEqual({ kind: "warning", secondsLeft: 1 });
    expect(idleStage(120_000, HAND_BACK_IDLE)).toEqual({ kind: "expired" });
  });

  it("asks mid-survey after ten minutes, then gives sixty seconds", () => {
    expect(SURVEY_IDLE).toEqual({ quietMs: 10 * 60_000, countdownMs: 60_000 });
    expect(idleStage(10 * 60_000 - 1, SURVEY_IDLE).kind).toBe("active");
    expect(idleStage(10 * 60_000, SURVEY_IDLE)).toEqual({ kind: "warning", secondsLeft: 60 });
    expect(idleStage(11 * 60_000, SURVEY_IDLE)).toEqual({ kind: "expired" });
  });

  it("goes straight back after an iPad was locked for longer than the whole period", () => {
    expect(idleStage(60 * 60_000, SURVEY_IDLE)).toEqual({ kind: "expired" });
  });
});
