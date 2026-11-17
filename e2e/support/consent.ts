import type { Page } from "@playwright/test";

/**
 * Tick every statement on a consent screen, however it is laid out.
 *
 * A short set shows all its statements at once; a long one shows them one at a
 * time (D-100), each tick moving straight on to the next. Either way the move is
 * the same: tick the visible statement that is still unticked, until there is
 * none. Returns how many were ticked, and the text of each, in order.
 */
export async function tickEveryStatement(page: Page, options: { leave?: number } = {}): Promise<string[]> {
  const texts: string[] = [];
  const total = await statementCount(page);
  for (let guard = 0; guard < 40; guard += 1) {
    if (options.leave !== undefined && texts.length >= total - options.leave) break;
    const box = page.locator(".consent-list input[type=checkbox]:visible:not(:checked)").first();
    if ((await box.count()) === 0) break;
    texts.push((await box.locator("xpath=..").innerText()).trim());
    // A click, not check(): check() re-finds "the first unticked box" to confirm
    // the tick, and on a one-at-a-time screen that is already the NEXT
    // statement, so a single check() would tick them all.
    await box.click();
    // The next statement, or the next screen, takes a moment to come: wait for
    // one or the other rather than reading the screen before it has changed.
    await page
      .waitForFunction(
        () =>
          document.querySelector(".consent-list") === null ||
          [...document.querySelectorAll<HTMLInputElement>(".consent-list input[type=checkbox]")].some((b) => !b.checked),
        undefined,
        { timeout: 2_000, polling: 100 },
      )
      .catch(() => undefined);
  }
  return texts;
}

/** How many statements the consent screen has: the "Statement 1 of 8" count, or the boxes shown. */
export async function statementCount(page: Page): Promise<number> {
  const count = page.locator(".consent-count");
  if ((await count.count()) > 0) return Number(/of (\d+)/.exec(await count.innerText())?.[1] ?? 0);
  return page.locator(".consent-list input[type=checkbox]").count();
}

/** Whether this screen is a consent screen with a statement still to tick. */
export async function hasStatementToTick(page: Page): Promise<boolean> {
  return (await page.locator(".consent-list input[type=checkbox]:visible:not(:checked)").count()) > 0;
}
