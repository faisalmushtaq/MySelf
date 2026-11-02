import { describe, expect, it } from "vitest";
import { HAND_BACK_IDLE, idleSince, idleStage, sittingIdle, SITTING_WINDOW_MS, SURVEY_IDLE } from "./lib/idle.js";

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

describe("a sitting's first 90 minutes (D-74)", () => {
  const started = "2026-11-02T09:00:00.000Z";
  const t0 = Date.parse(started);
  const policy = sittingIdle(SURVEY_IDLE, started);

  it("never count as idle, however long the screen is left", () => {
    expect(policy.notBeforeMs).toBe(t0 + SITTING_WINDOW_MS);
    expect(idleSince(t0 + 89 * 60_000, t0, policy)).toBe(0);
    expect(idleStage(idleSince(t0 + 89 * 60_000, t0, policy), policy)).toEqual({ kind: "active" });
  });

  it("then ask straight away, with the whole countdown, if nobody touched it through the end", () => {
    const at = t0 + SITTING_WINDOW_MS;
    expect(idleStage(idleSince(at, t0, policy), policy)).toEqual({ kind: "warning", secondsLeft: 60 });
    expect(idleStage(idleSince(at + 60_000, t0, policy), policy)).toEqual({ kind: "expired" });
  });

  it("and after that count the usual ten quiet minutes from the last touch", () => {
    const touched = t0 + SITTING_WINDOW_MS + 5 * 60_000;
    expect(idleStage(idleSince(touched + 9 * 60_000, touched, policy), policy)).toEqual({ kind: "active" });
    expect(idleStage(idleSince(touched + 10 * 60_000, touched, policy), policy).kind).toBe("warning");
  });

  it("leave a policy without a window as it was", () => {
    expect(idleSince(1000, 400, SURVEY_IDLE)).toBe(600);
  });
});
