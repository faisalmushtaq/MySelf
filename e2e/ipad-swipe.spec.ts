import { expect, test } from "@playwright/test";

/**
 * A swipe anywhere on an iPad scrolls the screen (D-101).
 *
 * The survey's text sits in a 720px column. The scrolling screen used to be
 * that column too, so on an iPad, wider than 720px either way up, a swipe in
 * the strip either side of the text landed on nothing that scrolls, and
 * children kept swiping at a page that would not move. The screen now runs
 * edge to edge, with the text where it was.
 */
for (const [name, width, height] of [
  ["upright", 810, 1080],
  ["sideways", 1180, 820],
] as const) {
  test(`an iPad held ${name}: the screen spans the width, and a swipe at the edge scrolls it`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("./");
    await page.locator("input.code").fill("NDC0042");
    await page.locator("button.next.big").click();
    const screen = page.locator(".screen.survey");
    await expect(screen).toBeVisible();

    // The scrolling screen is the full width; the heading stays in the centred column.
    const box = await screen.boundingBox();
    expect(Math.round(box!.x)).toBe(0);
    expect(Math.round(box!.width)).toBe(width);
    const heading = await page.locator(".survey-body h1").boundingBox();
    expect(Math.round(heading!.x)).toBe(Math.round((width - 720) / 2 + 48));

    // Make the screen taller than the iPad, so there is something to scroll.
    await screen.evaluate((el) => {
      const filler = document.createElement("div");
      filler.style.height = "3000px";
      el.appendChild(filler);
    });
    for (const x of [8, width - 8]) {
      await screen.evaluate((el) => (el.scrollTop = 0));
      await page.mouse.move(x, height * 0.6);
      await page.mouse.wheel(0, 400);
      await expect.poll(() => screen.evaluate((el) => el.scrollTop), { message: `a swipe at x=${x} did not scroll` }).toBeGreaterThan(0);
    }
  });
}
