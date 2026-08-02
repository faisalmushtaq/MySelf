import { describe, expect, it, vi } from "vitest";
import { SessionTiming } from "./lib/timing.js";

/**
 * Timing paradata is only worth having if it is trustworthy, so these tests
 * pin the cases that would quietly corrupt it: an item revisited, an iPad put
 * down mid-question, and an answer changed after being reconsidered.
 */

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
      const s = new SessionTiming(2);
      expect(s.enter("a.q1")).toEqual({ visit: 1, returning: false });
      tick(5000);
      expect(s.leave("a.q1", true)).toMatchObject({ visit: 1, visitDwellMs: 5000, totalDwellMs: 5000 });

      // came back to change the answer
      expect(s.enter("a.q1")).toEqual({ visit: 2, returning: true });
      tick(3000);
      expect(s.leave("a.q1", true)).toMatchObject({ visit: 2, visitDwellMs: 3000, totalDwellMs: 8000 });
    });
  });

  it("flags an answer given faster than the question could be read", () => {
    withClock((tick) => {
      const s = new SessionTiming(2);
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
      const s = new SessionTiming(2);
      s.enter("a.q1");
      tick(4500);
      expect(s.recordResponse("a.q1", false).tooFast).toBe(false);
    });
  });

  it("never flags a revisit: changing an answer you have read is not haste", () => {
    withClock((tick) => {
      const s = new SessionTiming(2);
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
      const s = new SessionTiming(2);
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
      const s = new SessionTiming(2);
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
