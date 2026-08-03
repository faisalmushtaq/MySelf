import { describe, expect, it, vi } from "vitest";
import { SessionTiming, tooFastThresholdMs, wordCount } from "./lib/timing.js";

/**
 * Timing paradata is only worth having if it is trustworthy, so these tests
 * pin the cases that would quietly corrupt it: an item revisited, an iPad put
 * down mid-question, and an answer changed after being reconsidered.
 */

/** 2s flat for the behavioural tests below: floor and cap both 2, so word
 *  count cannot move the threshold and each test isolates one behaviour. */
const pace = { tooFastSeconds: 2, tooFastWordsPerSecond: 8, tooFastMaxSeconds: 2 };

/** Drive performance.now() by hand so the assertions are exact, not flaky. */
function withClock(run: (tick: (ms: number) => void) => void): void {
  let t = 1000;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => t);
  try {
    run((ms) => {
      t += ms;
    });
  } finally {
    spy.mockRestore();
  }
}

describe("session timing", () => {
  it("sums dwell across visits and counts each one", () => {
    withClock((tick) => {
      const s = new SessionTiming(pace);
      expect(s.enter("a.q1")).toMatchObject({ visit: 1, returning: false, tooFastMs: 2000 });
      tick(5000);
      expect(s.leave("a.q1", true)).toMatchObject({ visit: 1, visitDwellMs: 5000, totalDwellMs: 5000 });

      // came back to change the answer
      expect(s.enter("a.q1")).toMatchObject({ visit: 2, returning: true });
      tick(3000);
      expect(s.leave("a.q1", true)).toMatchObject({ visit: 2, visitDwellMs: 3000, totalDwellMs: 8000 });
    });
  });

  it("flags an answer given faster than the question could be read", () => {
    withClock((tick) => {
      const s = new SessionTiming(pace);
      s.enter("a.q1");
      tick(900);
      const r = s.recordResponse("a.q1", false);
      expect(r.tooFast).toBe(true);
      expect(r.sinceShownMs).toBe(900);
      expect(r.timeToFirstResponseMs).toBe(900);
    });
  });

  it("does not flag a considered answer", () => {
    withClock((tick) => {
      const s = new SessionTiming(pace);
      s.enter("a.q1");
      tick(4500);
      expect(s.recordResponse("a.q1", false).tooFast).toBe(false);
    });
  });

  it("never flags a revisit: changing an answer you have read is not haste", () => {
    withClock((tick) => {
      const s = new SessionTiming(pace);
      s.enter("a.q1");
      tick(6000);
      s.recordResponse("a.q1", false);
      s.leave("a.q1", true);
      s.enter("a.q1");
      tick(400); // instant correction on return
      const r = s.recordResponse("a.q1", true);
      expect(r.tooFast).toBe(false);
      expect(r.changes).toBe(1);
      // time to FIRST response is unchanged by the correction
      expect(r.timeToFirstResponseMs).toBe(6000);
    });
  });

  it("stops the clock while the app is backgrounded", () => {
    withClock((tick) => {
      const s = new SessionTiming(pace);
      s.enter("a.q1");
      tick(2000);
      expect(s.suspend()).toEqual({ hiddenAtMs: 2000 });
      tick(600_000); // iPad put down for ten minutes
      expect(s.resume()).toEqual({ awayMs: 600_000 });
      tick(3000);
      const left = s.leave("a.q1", true);
      // 2s before + 3s after: the ten minutes away are not deliberation
      expect(left?.totalDwellMs).toBe(5000);
      expect(s.foregroundMs()).toBe(5000);
      expect(s.elapsedMs()).toBe(605_000);
    });
  });

  it("summarises a session for the completion event", () => {
    withClock((tick) => {
      const s = new SessionTiming(pace);
      s.enter("a.q1");
      tick(500);
      s.recordResponse("a.q1", false); // too fast
      s.leave("a.q1", true);
      s.enter("a.q2");
      tick(9000);
      s.recordResponse("a.q2", false);
      s.leave("a.q2", true);
      s.enter("a.q1"); // revisited
      tick(1000);
      s.leave("a.q1", true);
      expect(s.summary()).toMatchObject({
        itemsSeen: 2,
        tooFastCount: 1,
        revisitedCount: 1,
        totalMs: 10_500,
      });
    });
  });
});

describe("too-fast threshold scales with how much there is to read", () => {
  // A flat threshold flagged legitimate answers: a four-word battery item
  // genuinely can be answered in a second, and treating that as inattention
  // buried the real cases in noise.
  const policy = { tooFastSeconds: 0.8, tooFastWordsPerSecond: 8, tooFastMaxSeconds: 6 };

  it("counts the words a participant has to read", () => {
    expect(wordCount("Which hand do you write with?")).toBe(6);
    expect(wordCount("Two words", undefined, "and three more")).toBe(5);
    expect(wordCount("  spaced   out  ")).toBe(2);
    expect(wordCount(undefined)).toBe(0);
  });

  it("holds a very short item to the floor, not to a flat two seconds", () => {
    expect(tooFastThresholdMs(wordCount("Writing"), policy)).toBe(800);
    expect(tooFastThresholdMs(wordCount("First Name"), policy)).toBe(800);
  });

  it("asks more of a longer question", () => {
    const stem = "I have been feeling optimistic about the future over the last two weeks";
    expect(tooFastThresholdMs(wordCount(stem), policy)).toBe(1625); // 13 words
  });

  it("caps a page of consent text rather than demanding an absurd minimum", () => {
    expect(tooFastThresholdMs(400, policy)).toBe(6000);
  });

  it("does not flag a brisk answer to a short item, but does flag an instant one", () => {
    withClock((tick) => {
      const s = new SessionTiming(policy);
      s.enter("a.short", wordCount("Writing")); // threshold 800ms
      tick(1200);
      expect(s.recordResponse("a.short", false).tooFast).toBe(false);

      s.enter("b.short", wordCount("Throwing"));
      tick(200);
      expect(s.recordResponse("b.short", false).tooFast).toBe(true);
    });
  });

  it("still catches an instant answer to a long question", () => {
    withClock((tick) => {
      const s = new SessionTiming(policy);
      const long = "I understand that anonymised results from this study may be disseminated through conference presentations and publication in peer reviewed journals";
      s.enter("c.long", wordCount(long)); // 20 words -> 2500ms
      tick(1200);
      const r = s.recordResponse("c.long", false);
      expect(r.tooFast).toBe(true);
      expect(r.thresholdMs).toBe(2500);
    });
  });
});
