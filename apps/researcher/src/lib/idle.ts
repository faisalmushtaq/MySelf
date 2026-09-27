/**
 * When somebody has stopped being there.
 *
 * Its own module so the rule can be tested and so the component cannot quietly disagree
 * with the test: the first version of the auto-lock and the first version of its test both
 * described a fifteen-minute idle timer and neither implemented one — the component armed
 * only while the tab was hidden, and the test asserted against a copy of the rule it had
 * declared itself. Both were green and the laptop-left-open case never locked.
 */

/**
 * Fifteen minutes, which is chosen against two failures rather than one.
 *
 * Shorter and it locks under the hands of somebody working through a list of names, who
 * then learns to leave it unlocked. Longer and a laptop on a staffroom table is open for
 * most of a lunch break.
 */
export const IDLE_LOCK_MS = 15 * 60 * 1000;

/**
 * What counts as a person being present.
 *
 * Pointer movement and scrolling are here because reading a long list of names involves
 * neither a keystroke nor a click, and a lock that fired while somebody was reading would
 * be worked around rather than tolerated.
 *
 * NOTHING THE PAGE DOES TO ITSELF IS ON THIS LIST. A timer, a render or a message must not
 * keep the names open; only a person may. `visibilitychange` is excluded for a sharper
 * reason: re-arming on it EXTENDS the window, because hiding the tab would restart the
 * countdown instead of counting as absence.
 */
export const PRESENCE_EVENTS = ["keydown", "pointerdown", "pointermove", "scroll", "focus"] as const;
