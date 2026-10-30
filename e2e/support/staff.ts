import { expect, type Page } from "@playwright/test";

/**
 * How staff get into the handover panel, shared by every suite that needs it:
 * five taps on the build line. (The staff PIN once asked for here was removed
 * at the PI's request, D-71.)
 */
export async function openStaffPanel(page: Page): Promise<void> {
  const buildLine = page.locator("p.demo-note");
  for (let i = 0; i < 5; i += 1) await buildLine.click();
  await expect(page.locator(".handover")).toBeVisible({ timeout: 15_000 });
}
