import { db, type SessionRow } from "./db.js";

/**
 * Whether this iPad's browser has promised to keep the data it is holding.
 *
 * THE FAILURE THIS EXISTS FOR, and it is specific to the device this study runs on.
 * WebKit puts a seven-day cap on script-writable storage: IndexedDB, the Cache API
 * and the service worker registration are all deleted after seven days of Safari
 * being used without the user visiting this site. It is not storage pressure and
 * there is no warning — a tab that was working on Friday is a blank device the
 * following week, and everything in it is gone.
 *
 * WHICH IS EXACTLY THE SHAPE OF A SCHOOL VISIT. A device collects on Monday in a
 * hall with no usable wifi, holds the morning's sittings encrypted in IndexedDB,
 * goes in a cupboard, and is picked up again when somebody remembers. Held data and
 * a week of not being opened is the normal case here, not an edge one, and it is
 * the case the cap deletes. Nothing else in this app protects against it: the space
 * warning is about a full disk, and the write guard only fires once a write has
 * already failed. By the time the eviction is visible there is nothing to recover.
 *
 * TWO THINGS MAKE IT SAFE, and this asks for both.
 *
 * The first is `navigator.storage.persist()`. Where a browser implements it, a grant
 * means the data is exempt from eviction until a person deletes it deliberately.
 * Chrome grants it to an installed app without asking. Safari does not implement it
 * at all, which is why a refusal is never treated as an error — only as "we did not
 * get the promise", which is a different and weaker thing to report.
 *
 * The second is being added to the Home Screen. An iOS web app launched from the
 * Home Screen is not subject to the seven-day cap, and on an iPad that is the only
 * thing that lifts it. So this reports whether the app is running installed, and the
 * operator panel says what to do when it is not. One tap, before fielding, and a
 * cupboard for a fortnight stops mattering.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not sniff the user agent. The question
 * that matters is not "is this Safari" but "did we get a promise that this data will
 * survive", and that is answerable directly. A future WebKit that implements
 * `persist()` would then be correctly reported as safe with no change here, and a
 * Chrome that refused would be correctly reported as at risk.
 */

/**
 * WebKit's cap, in days. Documented as a number so the panel and the runbook cannot
 * drift from each other, not because anything should be timed against it.
 */
export const EVICTION_CAP_DAYS = 7;

/** Held for this long without confirmation, and the panel stops being quiet about it. */
export const HELD_TOO_LONG_DAYS = 3;

export interface Durability {
  /**
   * Whether the browser has promised not to evict this origin.
   *
   * `"granted"` is a promise and means the data is safe. `"refused"` is a browser
   * that implements the API and said no. `"unsupported"` is every current iPad, and
   * is the reason the Home Screen answer exists.
   */
  promise: "granted" | "refused" | "unsupported";
  /**
   * Running as an installed app rather than a browser tab.
   *
   * On iOS this is what lifts the seven-day cap. Checked two ways because the
   * standard `display-mode` query only reached iOS in 16.4 and `navigator.standalone`
   * is what older iPads answer to; a school's devices are rarely all the same age.
   */
  installed: boolean;
  /**
   * Whether data this device is the only copy of could be deleted without warning.
   *
   * True only when we have neither protection. This is the thing the operator needs
   * to act on, and it is deliberately the conjunction: either answer alone is enough.
   */
  atRisk: boolean;
}

/** Ask once per launch; a second call would not change the answer and may prompt. */
let asked: Promise<Durability> | null = null;

function runningInstalled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    // A browser without matchMedia is not an installed app; fall through.
  }
  // iOS Safari's own flag, and the only one an iPad before 16.4 sets.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * Ask the browser to keep this origin's storage, and report where that leaves us.
 *
 * Safe to call before anything has been stored and with no network. Never throws:
 * a browser that refuses to answer is reported as unsupported, because a thrown
 * error here would take out the panel that is trying to warn about it.
 */
export function storageDurability(): Promise<Durability> {
  asked ??= (async (): Promise<Durability> => {
    const installed = runningInstalled();
    let promise: Durability["promise"] = "unsupported";
    try {
      const storage = navigator.storage as StorageManager & {
        persisted?: () => Promise<boolean>;
        persist?: () => Promise<boolean>;
      };
      if (storage?.persisted && (await storage.persisted())) {
        promise = "granted";
      } else if (storage?.persist) {
        promise = (await storage.persist()) ? "granted" : "refused";
      }
    } catch {
      // Including the case where asking is a security error in a private window.
      promise = "unsupported";
    }
    return { promise, installed, atRisk: promise !== "granted" && !installed };
  })().catch(() => ({ promise: "unsupported" as const, installed: false, atRisk: true }));
  return asked;
}

/** Only for tests, which need each case to start from an unasked browser. */
export function forgetDurability(): void {
  asked = null;
}

/**
 * How long the oldest sitting this device is still the only copy of has been here.
 *
 * WHY IN DAYS AND WHY AT ALL. The eviction cap and the device's own fragility are
 * both counted in days, so "this iPad has been carrying Monday's data since Monday"
 * is the sentence an operator can act on — plug it in, let it sync — where a count
 * of held sittings is not. Null when the device is holding nothing, which is the
 * state a fielded device should end each day in.
 */
export async function heldForDays(now = new Date()): Promise<number | null> {
  return daysHeld(await db.sessions.toArray(), now);
}

/**
 * The same answer from rows already in hand.
 *
 * Separate from the database read so the arithmetic can be tested, which is where
 * the mistakes are: which states count as held, an unparseable timestamp from an
 * older release, and a device whose clock has gone backwards.
 */
export function daysHeld(sessions: Pick<SessionRow, "state" | "startedAt">[], now = new Date()): number | null {
  const held = sessions.filter((session) => session.state !== "synced_verified");
  const starts = held.map((session) => Date.parse(session.startedAt)).filter((t) => !Number.isNaN(t));
  if (starts.length === 0) return null;
  // A device whose clock has gone backwards should read as nought days held, not as
  // a negative number the panel would have to special-case.
  return Math.max(0, Math.floor((now.getTime() - Math.min(...starts)) / 86_400_000));
}
