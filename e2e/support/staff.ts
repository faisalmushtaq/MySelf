import { expect, type Page } from "@playwright/test";

/**
 * How staff get into the handover panel, shared by every suite that needs it.
 *
 * Five taps on the build line, then the staff PIN (apps/participant
 * lib/pin.ts): chosen the first time the panel is opened on a device — every
 * test starts on a fresh one — and asked for after that.
 */
export const STAFF_PIN = "2468";

export async function openStaffPanel(page: Page, pin = STAFF_PIN): Promise<void> {
  const buildLine = page.locator("p.demo-note");
  for (let i = 0; i < 5; i += 1) await buildLine.click();
  const gate = page.locator("form.staff-pin");
  await expect(gate).toBeVisible();
  const inputs = gate.locator('input[type="password"]');
  if ((await inputs.count()) === 2) {
    await inputs.nth(0).fill(pin);
    await inputs.nth(1).fill(pin);
    await gate.getByRole("button", { name: "Set PIN and open" }).click();
  } else {
    await inputs.first().fill(pin);
    await gate.getByRole("button", { name: "Open" }).click();
  }
  await expect(page.locator(".handover")).toBeVisible({ timeout: 15_000 });
}
