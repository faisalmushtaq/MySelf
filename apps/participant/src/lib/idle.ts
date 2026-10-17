import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long a screen may sit untouched before the iPad takes itself back.
 *
 * WHY THIS EXISTS. An iPad is passed from child to child, and the screens that
 * stay up longest are the ones that say the most: "Thank you, <name>!" and the
 * review list of everything just answered, name and address included. A child
 * who wanders off leaves them for whoever picks the iPad up next. So every
 * screen that belongs to a sitting has a quiet period, a short visible
 * countdown, and then the start screen.
 *
 * ALL THE DURATIONS ARE HERE, and nowhere else. `quietMs` is how long nothing
 * has to happen before the countdown appears; `countdownMs` is how long the
 * countdown runs before the iPad goes back. A touch, a key, or "I'm still here"
 * at any point starts the quiet period again.
 */
export interface IdlePolicy {
  quietMs: number;
  countdownMs: number;
}

/**
 * The finish screen and the review list (and the start screen's DOB check and
 * an open staff panel): the sitting is already saved, so two minutes in all,
 * with the last twenty seconds counted down.
 */
export const HAND_BACK_IDLE: IdlePolicy = { quietMs: 100_000, countdownMs: 20_000 };

/**
 * A question in the middle of a sitting: ten minutes, because thinking is
 * allowed, then "Are you still there?" for sixty seconds. The sitting stays
 * resumable — with the date-of-birth check (lib/resume-check.ts).
 */
export const SURVEY_IDLE: IdlePolicy = { quietMs: 10 * 60_000, countdownMs: 60_000 };

/** Where an idle screen stands, given how long it has been left. Pure, so the arithmetic is tested. */
export type IdleStage = { kind: "active" } | { kind: "warning"; secondsLeft: number } | { kind: "expired" };

export function idleStage(idleMs: number, policy: IdlePolicy): IdleStage {
  const total = policy.quietMs + policy.countdownMs;
  if (idleMs >= total) return { kind: "expired" };
  if (idleMs >= policy.quietMs) return { kind: "warning", secondsLeft: Math.max(1, Math.ceil((total - idleMs) / 1000)) };
  return { kind: "active" };
}

/** What counts as somebody being there. Listened for on the whole window, before any handler can stop it. */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "wheel", "touchstart"] as const;

/**
 * Watch for a screen being left, while `policy` is set; null switches it off.
 *
 * Measured against the wall clock, not by counting ticks, so an iPad that was
 * locked and woken later (when Safari stops timers) is judged by how long it
 * was really away — and goes straight back to the start if that was long
 * enough. `onExpire` is called once per quiet period. `key` restarts the
 * quiet period when the screen changes (a new question is interaction too).
 */
export function useIdleTimer(
  policy: IdlePolicy | null,
  onExpire: () => void,
  key: string | number = "",
): { stage: IdleStage; stillHere: () => void } {
  const last = useRef(Date.now());
  const fired = useRef(false);
  const [stage, setStage] = useState<IdleStage>({ kind: "active" });
  const expire = useRef(onExpire);
  expire.current = onExpire;

  const stillHere = useCallback(() => {
    last.current = Date.now();
    fired.current = false;
    setStage((s) => (s.kind === "active" ? s : { kind: "active" }));
  }, []);

  useEffect(() => {
    stillHere();
    if (!policy) return;
    const tick = () => {
      const next = idleStage(Date.now() - last.current, policy);
      setStage((shown) =>
        shown.kind === next.kind && (next.kind !== "warning" || (shown.kind === "warning" && shown.secondsLeft === next.secondsLeft))
          ? shown
          : next,
      );
      if (next.kind === "expired" && !fired.current) {
        fired.current = true;
        expire.current();
      }
    };
    const onActivity = () => {
      last.current = Date.now();
      fired.current = false;
    };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { capture: true, passive: true });
    // Coming back to a woken iPad is checked at once, not a second later.
    document.addEventListener("visibilitychange", tick);
    const timer = window.setInterval(tick, 1000);
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, { capture: true });
      document.removeEventListener("visibilitychange", tick);
      window.clearInterval(timer);
    };
  }, [policy, key, stillHere]);

  return { stage: policy ? stage : { kind: "active" }, stillHere };
}
