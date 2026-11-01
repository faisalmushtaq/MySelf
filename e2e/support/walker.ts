import type { Page } from "@playwright/test";

/**
 * The parts of a walk through the survey that every end-to-end suite shares.
 *
 * Each suite answers a screen its own way, on purpose: the survey walk tries values
 * until the app accepts one, the accuracy walk records every option it taps, and the
 * sync walk only needs to get through. So answering stays in the specs. What is the
 * same everywhere is how a walker asks the app whether an answer will do, reads where
 * it has got to, and moves on when a control did not move on by itself — and those
 * are here, so a change to the app's markup is followed in one place rather than
 * three.
 */

/**
 * Whether the app considers the current screen answered.
 *
 * Read off the Next button, which is the app's own verdict: it is disabled until
 * the answer satisfies whatever the item requires. Asking the app beats
 * re-implementing its validation here and then disagreeing with it.
 */
export async function accepted(page: Page): Promise<boolean> {
  const next = page.locator("button.next:not(.big)").first();
  if ((await next.count()) === 0) return true;
  return next.isEnabled({ timeout: 2_000 }).catch(() => false);
}

/**
 * Where the walk currently is, as the app itself reports it.
 *
 * Used to prove each step actually moved. A walker that cannot tell progress from
 * a stuck screen spends its timeout clicking the same disabled button, and the
 * failure it eventually reports is "timed out" rather than "the survey would not
 * advance past this question" — which is the only version worth reading.
 *
 * Three screens are named rather than described: `"finished"`, `"start"`, and
 * `"save-failed"`, the calm stop the app puts up when the device could not save an
 * answer — which the sync suite checks for, because a walk that ended there has
 * not tested anything.
 */
export async function position(page: Page): Promise<string> {
  return page.evaluate(() => {
    // The app's own phase, read off the outermost screen's class list. Matching
    // on a bare `.finish` risked a false positive from any element that happened
    // to carry the class; the wrapper is unambiguous.
    const screen = document.querySelector(".screen");
    if (screen?.classList.contains("finish")) return "finished";
    if (screen?.classList.contains("start")) return "start";
    if (screen?.classList.contains("save-failed")) return "save-failed";
    const heading = document.querySelector(".survey h1, .screen h1");
    const segments = document.querySelector(".segments")?.getAttribute("aria-label") ?? "";
    /**
     * The step within the item, where there is one.
     *
     * Some items ask two things on one screen — "tap the apps you have", then
     * "how long on each" — and the section and heading are identical across
     * them. Without this, moving from step one to step two reads as not having
     * moved at all, and the walk fails on a screen that is working perfectly.
     */
    const step = document.querySelector(".survey-body p")?.textContent?.slice(0, 60) ?? "";
    /**
     * Deliberately NOT including how many options are selected.
     *
     * It was here so that ticking a box counted as progress, and that made the
     * walk loop: `step` treats any change as "the survey moved on", so selecting
     * a second option on a multi-select looked like advancing and the walker
     * stayed on one screen until it ran out of screens. Progress is a new
     * question or a new step in one — not a changed answer to the same question.
     */
    return `${segments}|${heading?.textContent?.slice(0, 80) ?? ""}|${step}`;
  });
}

/**
 * Advance past the current screen, dealing with anything the app puts in the way.
 *
 * The app deliberately interrupts: a check-in after a run of skips, a "no rush"
 * screen after a run of answers given faster than the question could be read.
 * A robot answers faster than any child, so the pace screen is not an edge case
 * here — it is the common path, and a test that did not handle it would fail on
 * the third question every time.
 */
export async function advance(page: Page): Promise<void> {
  const candidates = [
    ".screen.checkin button.next.big",
    "button.next:not(.big)",
    "button.skip-go",
    ".screen button.primary",
    "button.primary",
  ];
  for (const selector of candidates) {
    const button = page.locator(selector).first();
    // A short timeout on each speculative probe: these are "is this kind of
    // screen showing" questions, and the default would spend ten seconds per
    // miss on a walk hundreds of screens long.
    if ((await button.count()) === 0) continue;
    if (!(await button.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
    await button.click({ timeout: 5_000 });
    return;
  }
  const where = await page.evaluate(() => ({
    classes: document.querySelector(".screen")?.className ?? "(no .screen)",
    heading: document.querySelector("h1")?.textContent?.slice(0, 60) ?? "",
    buttons: [...document.querySelectorAll("button")]
      .filter((b) => !(b as HTMLButtonElement).disabled)
      .map((b) => `${b.className}:${b.textContent?.slice(0, 24) ?? ""}`)
      .slice(0, 8),
  }));
  throw new Error(
    `no way forward from this screen: nothing recognised to click. ${JSON.stringify(where)}`,
  );
}

/** Pages whose clock the walk controls: see `installClock`. */
const clocked = new WeakSet<Page>();

/**
 * Longer than the app's longest auto-advance pause (450ms, after the tick that
 * completes the consent set), so one jump fires whichever is pending.
 */
const AUTO_ADVANCE_MS = 500;

/**
 * Put the page on a clock the walk can move, so a single-choice screen's 300ms
 * pause (and the consent set's 450ms) does not have to be waited out in real time.
 *
 * It is the same time passing, only sooner: the page's clock jumps by the pause,
 * so anything that reads elapsed time (the pace check that interrupts answers
 * given faster than the question could be read, the paradata timings) sees what it
 * would have seen. Time still flows in real time between jumps, so debounces and
 * `expect` waits behave as they always did. Call it before the first `goto`, and
 * instead of `page.clock.install()` in a test that also moves the clock itself.
 * Safe to call twice.
 */
export async function installClock(page: Page): Promise<void> {
  if (clocked.has(page)) return;
  await page.clock.install();
  clocked.add(page);
}

/**
 * Whether the screen holds a control that can move the survey on by itself.
 *
 * Three do, and only three: a single choice (all five presentations are a
 * `radiogroup`) pauses 300ms and moves on, the social ladder does the same after
 * a tap, and the consent set moves on 450ms after the tick that completes it.
 * Everything else (text, dates, selects, sliders, a multi-select) waits for Next.
 * If a new control learns to auto-advance, it belongs in this list.
 */
async function mayAdvanceItself(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('[role="radiogroup"], .ladder-svg, .consent-list') !== null);
}

/**
 * After answering a screen: did the survey move on, and is it worth waiting to see?
 *
 * The walks used to give every screen 600 to 800ms to move on by itself, polling
 * every 100ms, whether or not anything on it could. About one screen in four
 * cannot, and each of those cost the whole wait: 30 of the 95 seconds in a single
 * whole-sitting walk. A screen with an auto-advancing control is still given the
 * same grace, polled faster so a move is seen as soon as it happens. Any other
 * screen is given two frames for its own re-render (a follow-up step opening, a
 * date read back) and then reported as not moved, so the caller clicks Next.
 *
 * Returns whether the position changed. `position` is a parameter for the one
 * suite that reads it differently.
 */
export async function settle(
  page: Page,
  before: string,
  options: { position?: (page: Page) => Promise<string>; graceMs?: number } = {},
): Promise<boolean> {
  const read = options.position ?? position;
  let graceMs = options.graceMs ?? 600;

  if (await mayAdvanceItself(page)) {
    if (clocked.has(page)) {
      // The app's own pause is a timer, so let it run out on the page's clock rather
      // than on ours. The pending move fires now; all that is left to wait for is
      // the render, which is a few milliseconds, not the pause.
      await page.clock.fastForward(AUTO_ADVANCE_MS);
      graceMs = Math.min(graceMs, 250);
    }
    const deadline = Date.now() + graceMs;
    for (;;) {
      if ((await read(page)) !== before) return true;
      if (Date.now() >= deadline) return false;
      await page.waitForTimeout(25);
    }
  }

  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  return (await read(page)) !== before;
}

// Throwaway change to exercise the pull request tiers in CI. Not for merging.
