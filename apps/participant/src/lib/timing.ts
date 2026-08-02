/**
 * Per-item timing paradata (D-23).
 *
 * Everything here is a measurement of *when things happened on screen*, kept
 * separate from the answers themselves. The event log stays the record — this
 * tracker only decides what to emit and when, so a session's timings can be
 * rebuilt from the log alone without trusting any figure computed at capture
 * time.
 *
 * What it makes answerable, per item:
 *   - how long the item was on screen, in total and per visit
 *   - how many times the participant came back to it
 *   - how long from first seeing it to first answering
 *   - whether an answer arrived faster than the item could have been read
 * and, per session: total elapsed time, and time actually spent with the app
 * in the foreground (the two differ when an iPad is put down mid-session).
 */

export interface ItemTimingState {
  itemKey: string;
  visits: number;
  dwellMs: number;
  /** Milliseconds from the first presentation to the first response. */
  timeToFirstResponseMs?: number;
  changes: number;
  tooFast: boolean;
  /** Monotonic ms when the current visit began; null while not on screen. */
  enteredAt: number | null;
  /** Monotonic ms when the item was first presented, across all visits. */
  firstSeenAt: number;
}

export interface LeftPayload extends Record<string, unknown> {
  visit: number;
  visitDwellMs: number;
  totalDwellMs: number;
  answered: boolean;
}

const now = () => performance.now();

export class SessionTiming {
  private items = new Map<string, ItemTimingState>();
  private current: string | null = null;
  private readonly startedAt = now();
  /** Milliseconds the app has spent hidden (backgrounded, screen locked). */
  private hiddenMs = 0;
  private hiddenSince: number | null = null;

  constructor(private readonly tooFastSeconds: number) {}

  /** Elapsed wall time for the session, in milliseconds. */
  elapsedMs(): number {
    return Math.round(now() - this.startedAt);
  }

  /** Elapsed time minus any period the app was backgrounded. */
  foregroundMs(): number {
    const hidden = this.hiddenMs + (this.hiddenSince === null ? 0 : now() - this.hiddenSince);
    return Math.round(now() - this.startedAt - hidden);
  }

  suspend(): { hiddenAtMs: number } | null {
    if (this.hiddenSince !== null) return null;
    this.hiddenSince = now();
    // A backgrounded app is not being read: stop the clock on the open item so
    // a session left overnight does not read as an hours-long deliberation.
    const state = this.current === null ? undefined : this.items.get(this.current);
    if (state?.enteredAt != null) {
      state.dwellMs += Math.round(now() - state.enteredAt);
      state.enteredAt = null;
    }
    return { hiddenAtMs: this.elapsedMs() };
  }

  resume(): { awayMs: number } | null {
    if (this.hiddenSince === null) return null;
    const away = Math.round(now() - this.hiddenSince);
    this.hiddenMs += away;
    this.hiddenSince = null;
    const state = this.current === null ? undefined : this.items.get(this.current);
    if (state) state.enteredAt = now();
    return { awayMs: away };
  }

  /** Item shown. Returns the visit number (1 on first sight). */
  enter(itemKey: string): { visit: number; returning: boolean } {
    this.current = itemKey;
    const existing = this.items.get(itemKey);
    if (existing) {
      existing.visits += 1;
      existing.enteredAt = now();
      return { visit: existing.visits, returning: true };
    }
    this.items.set(itemKey, {
      itemKey,
      visits: 1,
      dwellMs: 0,
      changes: 0,
      tooFast: false,
      enteredAt: now(),
      firstSeenAt: now(),
    });
    return { visit: 1, returning: false };
  }

  /** Item left. Returns the payload for the `item.left` event. */
  leave(itemKey: string, answered: boolean): LeftPayload | null {
    const state = this.items.get(itemKey);
    if (!state) return null;
    const visitDwell = state.enteredAt === null ? 0 : Math.round(now() - state.enteredAt);
    state.dwellMs += visitDwell;
    state.enteredAt = null;
    if (this.current === itemKey) this.current = null;
    return {
      visit: state.visits,
      visitDwellMs: visitDwell,
      totalDwellMs: state.dwellMs,
      answered,
    };
  }

  /**
   * A response was recorded. Returns the timing facts about it, including
   * whether it arrived too fast to have been read. The answer is always kept —
   * this only labels it.
   */
  recordResponse(
    itemKey: string,
    isChange: boolean,
  ): { sinceShownMs: number; tooFast: boolean; timeToFirstResponseMs?: number; changes: number } {
    const state = this.items.get(itemKey);
    const sinceShown = state?.enteredAt == null ? 0 : Math.round(now() - state.enteredAt);
    if (!state) return { sinceShownMs: sinceShown, tooFast: false, changes: 0 };
    if (isChange) state.changes += 1;
    if (state.timeToFirstResponseMs === undefined) {
      state.timeToFirstResponseMs = Math.round(now() - state.firstSeenAt);
    }
    // Only the first sight of an item can be "too fast": coming back to change
    // an answer you have already read is a different act, and flagging it would
    // punish exactly the care we want people to take.
    const tooFast = state.visits === 1 && !isChange && sinceShown < this.tooFastSeconds * 1000;
    if (tooFast) state.tooFast = true;
    return {
      sinceShownMs: sinceShown,
      tooFast,
      changes: state.changes,
      ...(state.timeToFirstResponseMs !== undefined
        ? { timeToFirstResponseMs: state.timeToFirstResponseMs }
        : {}),
    };
  }

  /** Summary for every item seen, for the session-complete event. */
  summary(): {
    totalMs: number;
    foregroundMs: number;
    itemsSeen: number;
    tooFastCount: number;
    revisitedCount: number;
  } {
    const all = [...this.items.values()];
    return {
      totalMs: this.elapsedMs(),
      foregroundMs: this.foregroundMs(),
      itemsSeen: all.length,
      tooFastCount: all.filter((i) => i.tooFast).length,
      revisitedCount: all.filter((i) => i.visits > 1).length,
    };
  }
}
