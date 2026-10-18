import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openOnCandidate } from "./support/candidate.js";
import { openStaffPanel } from "./support/staff.js";
import { accepted, advance, position, settle } from "./support/walker.js";

/**
 * What the child tapped, against what the study stored.
 *
 * EVERY OTHER TEST CHECKS A MECHANISM. The unit suites check the engine walks and
 * the manifest parses; the integration suite checks the database keeps one device's
 * log apart from another's; the survey walk checks the app runs and resumes. None of
 * them checks the thing a scientific instrument actually has to be right about:
 * that the answer recorded is the answer given.
 *
 * A questionnaire can pass everything else and still be wrong here. An off-by-one in
 * an option list, a scale whose codes were reordered between a release and a build,
 * a control that reports the index it rendered rather than the code it was given —
 * each produces a dataset that is complete, internally consistent, correctly
 * timestamped, and silently describing different answers from the ones the children
 * gave. Nothing downstream could tell, and the analysis would be of noise.
 *
 * SO THIS CLOSES THE LOOP ON MEANING, not on plumbing. It walks the questionnaire
 * recording the visible stem and the visible label of every option it taps, hands
 * the sitting over as an encrypted file, decrypts it, and resolves each stored code
 * back to a label through the release manifest — the same manifest the app rendered
 * from. Then it asserts the two agree, answer by answer.
 */

const CODE = "NDC0042";
/** The date of birth the walk gives: 14 in 2026, so the 11–17 SDQ (D-51). */
let dateOfBirth = "2012-05-14";
const PASSPHRASE = "six brown otters reading";
/**
 * Resolved from the working directory rather than from `import.meta`.
 *
 * Playwright compiles these specs as CommonJS, where `import.meta` is a syntax
 * error, and the suite always runs from the repository root.
 */
const MANIFEST = resolve("releases/ybm_nd2026_standard_r8.0.0.manifest.json");

/**
 * `@myself/store` is ESM-only, so it is imported dynamically — a static import of a
 * `"type": "module"` package from a CommonJS spec does not resolve.
 */
const storeTools = () => import("@myself/store");

/** One thing a participant did, as the screen showed it. */
interface Tapped {
  stem: string;
  label: string;
}

/**
 * Questions where several options can be ticked at once.
 *
 * Kept apart because "the last thing tapped" means something different for them: a
 * multi-select's taps accumulate, so the last one is not what the participant settled on.
 */
const multiSelectStems = new Set<string>();

interface Manifest {
  hash?: string;
  instruments: Record<
    string,
    {
      instrument: string;
      forms: {
        items: {
          key: string;
          stem: { text: string };
          responseType: string;
          scale?: string;
        }[];
      }[];
    }
  >;
  scales: Record<string, { key: string; options: { code: number; label: string }[] }>;
}

/**
 * Where an item's stem and its option labels come from.
 *
 * Built from the manifest rather than from the source packages on purpose: the
 * manifest is what the app actually rendered, so a disagreement between the library
 * and the frozen release shows up here instead of being papered over by both sides
 * reading the same source.
 */
interface Definitions {
  stemOf: Map<string, string>;
  labelOf: Map<string, Map<number, string>>;
}

async function definitions(): Promise<Definitions> {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
  const stemOf = new Map<string, string>();
  const labelOf = new Map<string, Map<number, string>>();

  const scaleByPrefix = new Map<string, { code: number; label: string }[]>();
  for (const scale of Object.values(manifest.scales)) scaleByPrefix.set(scale.key, scale.options);

  for (const instrument of Object.values(manifest.instruments)) {
    for (const form of instrument.forms) {
      for (const item of form.items) {
        const key = `${instrument.instrument}.${item.key}`;
        stemOf.set(key, item.stem.text);
        const options = item.scale ? scaleByPrefix.get(item.scale) : undefined;
        if (options) labelOf.set(key, new Map(options.map((o) => [o.code, o.label])));
      }
    }
  }
  return { stemOf, labelOf };
}

/**
 * Answer the screen, and say what was tapped.
 *
 * Only the single-choice presentations are reported, because they are the ones where
 * a code and a label can disagree — and therefore the ones where a silent error
 * would survive every other test. Sliders, dates and free text are answered so the
 * walk can continue, and are checked by the survey suite rather than here.
 */
async function answerAndRecord(page: Page, ledger: Tapped[]): Promise<void> {
  const consent = page.locator(".consent-list input[type=checkbox]:visible");
  const statements = await consent.count();
  if (statements > 0) {
    for (let i = 0; i < statements; i += 1) await consent.nth(i).check();
    return;
  }

  const group = page.locator('[role="radiogroup"]:visible').first();
  if ((await group.count()) > 0) {
    const stem = (await group.getAttribute("aria-label")) ?? "";
    const options = group.locator("button:visible");
    const total = await options.count();
    for (let i = 0; i < total; i += 1) {
      const option = options.nth(i);
      if (!(await option.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
      const label = await optionLabel(option);
      await option.click({ timeout: 5_000 });
      /**
       * Recorded whether or not the app accepts it, and that is the point.
       *
       * Some items are checked against an earlier answer — "the month you were born" (to r7.3.0)
       * has to agree with the date of birth — so the walker tries options until one
       * is accepted. Every tap along the way IS an answer the participant gave, and
       * the event log records all of them in order, because it is append-only.
       *
       * The first version of this test recorded only the accepted option and then
       * failed on finding "January" in the data. The data was right: a log that
       * quietly dropped a changed answer would be the bug, since which answers a
       * child revised is paradata a study may want.
       */
      ledger.push({ stem, label });
      if (await accepted(page)) return;
    }
    return;
  }

  const cards = page.locator('[role="group"] button.card:visible, [role="group"] button.chip:visible');
  const cardCount = await cards.count();
  if (cardCount > 0) {
    /**
     * A multi-select, recorded the same as a single choice.
     *
     * The stem comes from the heading rather than the group's `aria-label`, because the
     * chip presentation does not carry one — and the heading IS the stem.
     *
     * Its dataset row is the pipe-joined list of everything ticked, so each option is
     * recorded separately here and the joined label is split when it is checked. The
     * first version skipped these entirely and then failed on finding a joined label it
     * had no record of; the data was right.
     */
    const stem = ((await page.locator(".survey-body h1").first().textContent()) ?? "").trim();
    for (let i = 0; i < Math.min(3, cardCount); i += 1) {
      const card = cards.nth(i);
      if (!(await card.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
      const label = await optionLabel(card);
      await card.click({ timeout: 5_000 });
      if (stem !== "" && label !== "") {
        ledger.push({ stem, label });
        multiSelectStems.add(stem);
      }
    }
    return;
  }

  const ladder = page.locator(".survey-body .ladder-svg:visible").first();
  if ((await ladder.count()) > 0 && (await ladder.isVisible())) {
    await ladder.click({ timeout: 5_000 });
    return;
  }

  const slider = page.locator('.survey-body input[type="range"]:visible').first();
  if ((await slider.count()) > 0) {
    await slider.fill("5");
    return;
  }

  const select = page.locator(".survey-body select.picker:visible").first();
  if ((await select.count()) > 0) {
    const values = await select
      .locator("option")
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
    if (values[0] !== undefined) await select.selectOption(values[0]);
    return;
  }

  const date = page.locator('.survey-body input[type="date"]:visible').first();
  if ((await date.count()) > 0) {
    await date.fill(dateOfBirth);
    return;
  }

  const text = page.locator(".survey-body textarea:visible, .survey-body input.text-input:visible").first();
  if ((await text.count()) > 0) {
    // A postcode for the address screen (D-52), which rejects the others.
    for (const candidate of ["1", "A", "LS2 9JT", "Something I would say about this."]) {
      await text.fill(candidate);
      if (await accepted(page)) return;
    }
  }
}

/**
 * The label an option shows, without the decoration around it.
 *
 * A selected card renders a tick in its own span, so reading the button's whole text
 * gave "Yes✓" and the cross-reference failed against the manifest's "Yes" — a real
 * mismatch with no real cause. Each presentation puts the words in an element whose
 * class ends `-label` (card, tile, spectrum); chips put them straight in the button,
 * so that is the fallback, with the tick stripped.
 */
async function optionLabel(option: Locator): Promise<string> {
  return option.evaluate((element) => {
    const named = element.querySelector('[class$="-label"]');
    const text = named?.textContent ?? element.textContent ?? "";
    return text.replace(/[\u2713\u2714]/g, "").trim();
  });
}

/** Answer screen after screen until the survey finishes, or `enough` says to stop. */
async function walk(
  page: Page,
  ledger: Tapped[],
  enough: () => boolean | Promise<boolean> = () => false,
  options: { candidate?: boolean } = {},
): Promise<void> {
  if (options.candidate) await openOnCandidate(page);
  else await page.goto("./");
  await page.locator("input.code").fill(CODE);
  await page.locator("button.next.big").click();

  for (let screens = 0; screens < 400; screens += 1) {
    if ((await position(page)) === "finished" || (await enough())) break;
    const before = await position(page);
    await answerAndRecord(page, ledger);
    const moved = await settle(page, before);
    if (!moved) {
      await advance(page);
      await expect.poll(() => position(page), { timeout: 10_000 }).not.toBe(before);
    }
  }
}

test("someone 18 or over on the day is given the 18+ SDQ, word for word (D-51)", async ({ page }) => {
  test.slow();
  dateOfBirth = "2000-01-15";
  const ledger: Tapped[] = [];
  const asked = (stem: string) => ledger.some((t) => t.stem.includes(stem));
  // Both forms end with the same item, so the walk can stop once it is answered.
  await walk(page, ledger, () => asked("I finish the work I'm doing"));

  expect(asked("I am restless, I find it hard to sit down for long")).toBe(true);
  expect(asked("I get along better with older people than with people of my own age")).toBe(true);
  expect(asked("I often offer to help others (family members, friends, colleagues)")).toBe(true);
  // and nothing from the 11–17 form
  expect(asked("I am restless, I cannot stay still for long")).toBe(false);
  expect(asked("Other children or young people pick on me or bully me")).toBe(false);
});

test("the address screen names a postcode's area, and keeps one outside it only after two confirmations (D-52)", async ({ page }) => {
  test.slow();
  dateOfBirth = "2012-05-14";
  const postcode = page.getByRole("textbox", { name: "Postcode" });
  await walk(page, [], async () => (await postcode.count()) > 0);

  const next = page.locator("button.next:not(.big)").first();
  const note = page.locator(".field-note");
  await postcode.fill("ls2 9jt");
  await expect(note).toHaveText("✓ Little London & Woodhouse, Leeds");
  await expect(next).toBeEnabled();

  // Harrogate: a real postcode, outside West Yorkshire. Questioned twice, never
  // refused: is it typed correctly, and is the home really outside the area?
  await postcode.fill("HG1 2AA");
  await expect(note).toHaveText("We can't find HG1 2AA in West Yorkshire. Check it's typed correctly.");
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "It's typed correctly" }).click();
  await expect(note).toHaveText("Is your home outside West Yorkshire?");
  await expect(next).toBeDisabled();
  // Saying no goes back to checking the postcode, with the box ready to edit.
  await page.getByRole("button", { name: "No — I'll check my postcode" }).click();
  await expect(note).toContainText("Check it's typed correctly");
  await expect(postcode).toBeFocused();
  await page.getByRole("button", { name: "It's typed correctly" }).click();
  await page.getByRole("button", { name: "Yes, my home is outside West Yorkshire" }).click();
  await expect(note).toHaveText("✓ Kept as you gave it — outside West Yorkshire");
  await expect(next).toBeEnabled();
  // A different postcode starts the questions again.
  await postcode.fill("YO1 7HH");
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "It's typed correctly" }).click();
  await page.getByRole("button", { name: "Yes, my home is outside West Yorkshire" }).click();
  await expect(next).toBeEnabled();

  // The rest is optional; what they know is what is kept.
  await page.getByRole("textbox", { name: "House number or name" }).fill("12");
  await next.click();
  await expect(postcode).toHaveCount(0);
});

/**
 * The screens D-53 adds are only in r9.0.0, which is a candidate until it is
 * approved — so these walk it as a release downloaded from the study.
 */
test.describe("on the r9.0.0 candidate", () => {
  test.use({ serviceWorkers: "block" });

  test("consent states record linkage and moves on by itself once every statement is ticked (D-53, D-58)", async ({ page }) => {
    test.slow();
    dateOfBirth = "2012-05-14";
    const statements = page.locator(".consent-list input[type=checkbox]");
    await walk(page, [], async () => (await statements.count()) > 0, { candidate: true });

    await expect(page.locator(".survey-body h1")).toContainText("We'll move on once they're all ticked");
    // Linkage is part of consent (D-58): explained above the statements, and one of them.
    await expect(page.locator(".survey-body .lede")).toContainText("Connected Yorkshire");
    await expect(page.locator(".survey-body .lede")).toContainText("brainpop@leeds.ac.uk");
    await expect(page.locator(".consent-list")).toContainText("health records");
    await expect(page.locator(".consent-list")).toContainText("education records");
    const total = await statements.count();
    for (let i = 0; i < total - 1; i += 1) await statements.nth(i).check();
    // Not yet: one statement is still unticked.
    await page.waitForTimeout(900);
    await expect(statements).toHaveCount(total);
    // The last tick moves the screen on without Next being pressed.
    await statements.nth(total - 1).check();
    await expect(page.locator(".survey-body h1")).toHaveText("Why your answers matter");
    await expect(page.locator("button.next:not(.big)")).toHaveText("I understand");

    // Coming back to the finished consent screen does not throw anyone forward.
    await page.locator("button.back").click();
    await expect(statements.first()).toBeChecked();
    await page.waitForTimeout(1_200);
    await expect(statements).toHaveCount(total);
  });

  test("someone who doesn't know their postcode finds their street instead (D-53)", async ({ page }) => {
    test.slow();
    dateOfBirth = "2012-05-14";
    const postcode = page.getByRole("textbox", { name: "Postcode" });
    await walk(page, [], async () => (await postcode.count()) > 0, { candidate: true });

    const next = page.locator("button.next:not(.big)").first();
    // Offered from the start, for someone who knows straight away.
    await expect(page.getByRole("button", { name: "I don't know my postcode" })).toBeVisible();

    // A postcode the list doesn't know: warned, then allowed to say they don't know it.
    await postcode.fill("LS99 9ZZ");
    await expect(page.locator(".field-note").first()).toHaveText("We can't find LS99 9ZZ in West Yorkshire. Check it's typed correctly.");
    await expect(next).toBeDisabled();
    await page.getByRole("button", { name: "I don't know my postcode" }).click();
    await expect(postcode).toHaveValue("");
    await expect(page.locator(".field-note").first()).toHaveText("That's fine — type your street below and choose it from the list.");
    await expect(next).toBeEnabled();

    // A typo and an abbreviation still find it; the choice records the area and district.
    const street = page.getByRole("textbox", { name: "Street" });
    await expect(street).toBeFocused();
    await street.fill("hyde prak rd");
    const match = page.locator(".street-match", { hasText: "Hyde Park Road" }).filter({ hasText: "LS6" });
    await expect(match).toBeVisible();
    await match.click();
    await expect(street).toHaveValue("Hyde Park Road");
    await expect(page.locator(".field-note").nth(1)).toHaveText("✓ Hyde Park Road, Leeds (LS6)");
    await expect(page.locator(".street-match")).toHaveCount(0);

    // A street the list doesn't know is kept as typed, never refused.
    await street.fill("Nowhere In Particular Lane");
    await expect(page.locator(".field-note").nth(1)).toContainText("We can't find that street in West Yorkshire");
    await expect(next).toBeEnabled();
    await street.fill("hyde park rd");
    await page.locator(".street-match", { hasText: "Hyde Park Road" }).filter({ hasText: "LS6" }).click();
    await page.getByRole("textbox", { name: "House number or name" }).fill("12");
    await next.click();
    await expect(postcode).toHaveCount(0);
  });

  test("sleep quality is one numbered row, a long time without social media is checked, and family control asks how (D-53)", async ({ page }) => {
    test.slow();
    dateOfBirth = "2012-05-14";
    const heading = page.locator(".survey-body h1");
    // Read without waiting: the pace and check-in screens have no question heading.
    const headingIs = (text: string) => async () =>
      (await page.evaluate(() => document.querySelector(".survey-body h1")?.textContent ?? "")).includes(text);
    await walk(page, [], headingIs("how would you rate your sleep quality overall"), { candidate: true });

    // Eleven numbers, each named with its band; the bands drawn beneath.
    const numbers = page.locator(".numbered-option");
    await expect(numbers).toHaveCount(11);
    await expect(page.getByRole("radio", { name: "0, Terrible" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "5, Fair" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "10, Excellent" })).toBeVisible();
    await expect(page.locator(".band-label")).toHaveText(["Terrible", "Poor", "Fair", "Good", "Excellent"]);
    await page.getByRole("radio", { name: "7, Good" }).click();
    // …then straight on to sleepiness right now.
    await expect(heading).toHaveText("How sleepy are you feeling right now?");

    await walk_on(page, headingIs("How long do you think you could go without social media?"));
    const days = page.locator(".survey-body input.numeric");
    const next = page.locator("button.next:not(.big)").first();
    await days.fill("30");
    await expect(page.locator(".number-check")).toHaveCount(0);
    await expect(next).toBeEnabled();
    await days.fill("400");
    await expect(page.locator(".number-check-text")).toHaveText("That's about 1 year, 1 month and 5 days. Is that right?");
    await expect(next).toBeDisabled();
    await page.getByRole("button", { name: "Yes, that's right" }).click();
    await expect(next).toBeEnabled();
    await next.click();

    await expect(heading).toHaveText("Does your family manage or control your social media use?");
    await page.getByRole("radio", { name: "Yes" }).click();
    await expect(heading).toHaveText("How does your family manage or control your social media use?");
    await page.getByRole("checkbox", { name: "Something else" }).click();
    await page.locator("button.next:not(.big)").first().click();
    await expect(heading).toHaveText("What else does your family do?");
  });
});

/** Carry on answering from the current screen, without starting a new sitting. */
async function walk_on(page: Page, enough: () => Promise<boolean>): Promise<void> {
  for (let screens = 0; screens < 400; screens += 1) {
    if (await enough()) return;
    const before = await position(page);
    await answerAndRecord(page, []);
    const moved = await settle(page, before);
    if (!moved) {
      await advance(page);
      await expect.poll(() => position(page), { timeout: 10_000 }).not.toBe(before);
    }
  }
  throw new Error("never reached the screen the test was looking for");
}

test("the dataset says what the participant actually answered", async ({ page }) => {
  test.slow();
  dateOfBirth = "2012-05-14";
  const { stemOf, labelOf } = await definitions();
  const ledger: Tapped[] = [];

  await walk(page, ledger);

  await expect(page.locator(".screen.finish")).toBeVisible();
  expect(ledger.length).toBeGreaterThan(20);

  // Hand over, and read the file back the way the researcher view does.
  await page.locator("button.next.big").first().click();
  await openStaffPanel(page);
  await page.locator('.handover input[type="password"]').fill(PASSPHRASE);
  const download = page.waitForEvent("download");
  await page.locator("button", { hasText: "Export completed sessions" }).click();
  const file = await (await download).path();

  const { isEncryptedEnvelope, openExport } = await storeTools();
  const envelope: unknown = JSON.parse(await readFile(file!, "utf8"));
  expect(isEncryptedEnvelope(envelope)).toBe(true);
  const opened = (await openExport(envelope as never, PASSPHRASE)) as {
    sessions: {
      studyCode: string;
      releaseHash: string;
      events: { seq: number; type: string; itemKey?: string; payload?: Record<string, unknown> }[];
    }[];
  };

  expect(opened.sessions).toHaveLength(1);
  const sitting = opened.sessions[0]!;

  // The sitting is filed under the code that was typed, and under the release the
  // app rendered from. A dataset joined on the wrong code is worse than no dataset.
  expect(sitting.studyCode).toBe(CODE);
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
  expect(sitting.releaseHash).toBe(manifest.hash);

  /**
   * Now the cross-reference.
   *
   * For every stored single-choice answer, resolve its item to the stem the screen
   * displayed and its code to the label the option carried, then require that the
   * pair is one this walk actually tapped. A code that had drifted by one would
   * resolve to a neighbouring label and fail here — which is the whole point, because
   * it would fail nowhere else.
   */
  const key = (stem: string, label: string) => `${stem}\u0000${label}`;
  const tapped = new Set(ledger.map((entry) => key(entry.stem, entry.label)));
  /**
   * The last thing tapped for each question — what the participant settled on.
   *
   * Only meaningful for a single choice. A multi-select's last tap is one of several
   * answers rather than a replacement for the earlier ones, so those stems are dropped
   * from this map rather than being recorded as having "settled on" whichever option
   * happened to be ticked last.
   */
  const tapCounts = new Map<string, number>();
  for (const entry of ledger) tapCounts.set(entry.stem, (tapCounts.get(entry.stem) ?? 0) + 1);
  const settledOn = new Map<string, string>();
  for (const entry of ledger) settledOn.set(entry.stem, entry.label);
  for (const [stem] of tapCounts) {
    // A stem whose taps all remain selected is a multi-select; the event log tells them
    // apart by kind, so this map is only consulted for single choices anyway.
    if (multiSelectStems.has(stem)) settledOn.delete(stem);
  }

  const seen = new Set<string>();
  const storedLast = new Map<string, string>();
  let checked = 0;

  for (const stored of sitting.events) {
    if (stored.type !== "response.recorded" && stored.type !== "response.changed") continue;
    if (!stored.itemKey) continue;
    const value = stored.payload?.["value"] as { kind?: string; code?: number } | undefined;
    if (value?.kind !== "choice" || typeof value.code !== "number") continue;

    const stem = stemOf.get(stored.itemKey);
    const label = labelOf.get(stored.itemKey)?.get(value.code);

    // An item the manifest does not describe means the app stored an answer against
    // something that was never published, which is its own kind of wrong.
    expect(stem, `no item ${stored.itemKey} in the release the app claims to run`).toBeTruthy();
    expect(label, `code ${value.code} is not an option on ${stored.itemKey}`).toBeTruthy();

    seen.add(key(stem!, label!));
    // Events arrive in sequence order, so the last one wins — which is what the
    // dataset derives as the answer.
    storedLast.set(stem!, label!);

    // NOTHING INVENTED. Every choice in the log is one that was actually tapped. A
    // code that had drifted by one would resolve to a neighbouring label and fail
    // here, and it would fail nowhere else in the suite.
    expect(
      tapped.has(key(stem!, label!)),
      `the dataset holds "${label}" against "${stem}", and that was never tapped`,
    ).toBe(true);
    checked += 1;
  }

  expect(checked).toBeGreaterThan(20);

  /**
   * NOTHING LOST. Every single choice tapped is in the log, including the ones a
   * consistency check rejected — the log is append-only and a revised answer is
   * paradata, not noise to be discarded.
   *
   * SINGLE CHOICES ONLY, because this loop reads `kind: "choice"` payloads. A
   * multi-select is stored as `kind: "checkboxes"` against the option keys rather than a
   * code, so it is absent from `seen` by construction rather than by loss — and it is
   * checked thoroughly the other way round below, where every part of its joined dataset
   * label has to be something that was tapped. Between the two directions the coverage
   * is complete; conflating them here would only make this loop re-implement `ingest`.
   */
  const singleChoiceTaps = [...tapped].filter((pair) => !multiSelectStems.has(pair.split("\u0000")[0]!));
  const missing = singleChoiceTaps.filter((pair) => !seen.has(pair));
  expect(missing, `tapped but absent from the log: ${missing.join(" / ")}`).toEqual([]);

  // AND THE ANSWER THAT COUNTS IS THE ONE GIVEN LAST. This is the assertion an
  // analysis actually depends on: whatever revisions happened on the way, the value
  // the dataset resolves to is what the participant settled on.
  for (const [stem, label] of settledOn) {
    if (!storedLast.has(stem)) continue;
    expect(storedLast.get(stem), `the last answer stored for "${stem}" is not the last one tapped`).toBe(label);
  }

  /**
   * Then the same question of the table a researcher actually analyses.
   *
   * Everything above checks the event log, which is the record. This checks what is
   * DERIVED from it — and the derivation is its own chance to be wrong: `ingest` resolves
   * each event to a variable, a code and the label that code stands for, and a dataset
   * whose `value` and `label` disagreed with each other, or with the screen, would be
   * analysed by somebody with no way to notice.
   *
   * It is the same `ingest` the researcher view and the nightly BIDS export both run, so
   * this is the analysis output rather than a proxy for it.
   */
  const { ingest } = await storeTools();
  const derived = ingest([sitting as never], { manifest: manifest as never, study: "ybm" });

  // A rejected sitting is one that never reaches an analysis at all.
  expect(derived.rejected, `ingest refused the sitting: ${JSON.stringify(derived.rejected)}`).toEqual([]);
  expect(derived.dataset.sessions).toHaveLength(1);
  expect(derived.dataset.sessions[0]!.complete).toBe(true);

  const answered = derived.dataset.responses.filter((row) => row.status === "answered" && row.label !== null);
  expect(answered.length).toBeGreaterThan(20);

  let crossChecked = 0;
  for (const row of answered) {
    const itemKey = `${row.instrument}.${row.item}`;
    const stem = stemOf.get(itemKey);
    if (!stem) continue;

    /**
     * The label in the dataset is one the participant was shown for this question.
     *
     * A multi-select's row joins everything ticked with " | ", so it is split and each
     * part checked — the joined string is a rendering of several answers rather than one
     * answer with a strange name.
     */
    for (const part of row.label!.split(" | ").map((piece) => piece.trim())) {
      expect(
        tapped.has(key(stem, part)),
        `the dataset's row for "${stem}" includes "${part}", which was never tapped`,
      ).toBe(true);
    }

    // And the code agrees with that label. A dataset where `value` and `label` disagree
    // is one where the numbers and the words tell different stories.
    if (row.value !== null) {
      const fromCode = labelOf.get(itemKey)?.get(row.value);
      if (fromCode !== undefined) {
        expect(fromCode, `${itemKey}: code ${row.value} is "${fromCode}" but the row says "${row.label}"`).toBe(
          row.label,
        );
      }
    }

    // For a single choice, the final row is the answer the participant settled on rather
    // than an earlier revision. A multi-select has no single last answer — its row is
    // the whole set — so the joined form is exempt from this one.
    const settled = settledOn.get(stem);
    if (settled !== undefined && !row.label!.includes(" | ")) {
      expect(row.label, `the dataset's final answer for "${stem}" is not the last one tapped`).toBe(settled);
    }
    crossChecked += 1;
  }
  expect(crossChecked).toBeGreaterThan(20);

  /**
   * And finally the file an analyst actually opens.
   *
   * THE LAST SEAM. Everything above stops at the `Dataset` — an in-memory structure
   * nobody analyses. What gets analysed is `phenotype/<instrument>.tsv`: a grid of
   * codes, one column per variable, whose meaning lives entirely in the `Levels` map
   * of the sidecar beside it. That grid is assembled by a different function from the
   * one checked above, and it has its own ways to be wrong — a column that drifted out
   * of step with its header, a code written into the wrong variable's cell, a sidecar
   * whose `Levels` came from a different release than the codes did. Each produces a
   * file that opens cleanly in any tool and describes answers nobody gave.
   *
   * So this walks from the child's finger to the cell: the code in the TSV, and the
   * label that cell's `Levels` entry resolves it to, both have to be what was tapped.
   * Read by parsing the TSV the way a reader would, by header name, rather than by
   * trusting a column order.
   */
  const { buildBidsExport } = await storeTools();
  const exported = buildBidsExport(derived.dataset, { manifest: manifest as never, datasetName: "accuracy check" });
  const fileAt = (path: string) => exported.find((f) => f.path === path)?.content;

  let inTheTsv = 0;
  for (const row of answered) {
    const stem = stemOf.get(`${row.instrument}.${row.item}`);
    // Single choices only: a multi-select's cell is a set, and the dataset-level check
    // above already takes it apart part by part.
    if (!stem || row.value === null || row.label!.includes(" | ")) continue;

    const tsv = fileAt(`phenotype/${row.instrument}.tsv`);
    expect(tsv, `no phenotype table was written for ${row.instrument}`).toBeTruthy();
    const [header, ...body] = tsv!.trim().split("\n");
    const columns = header!.split("\t");
    const column = columns.indexOf(row.variable);
    expect(column, `${row.variable} has no column in phenotype/${row.instrument}.tsv`).toBeGreaterThan(-1);

    // One sitting, so one row per instrument — and if that stopped being true the
    // cell being read would silently become another participant's.
    expect(body).toHaveLength(1);
    const cell = body[0]!.split("\t")[column];
    expect(cell, `phenotype/${row.instrument}.tsv holds "${cell}" for ${row.variable}, not the recorded code`).toBe(
      String(row.value),
    );

    // The status column beside it must agree that this was answered, or an analysis
    // filtering on status would drop a real answer.
    const status = body[0]!.split("\t")[columns.indexOf(`${row.variable}_status`)];
    expect(status).toBe("answered");

    /**
     * And the cell is interpretable. `Levels` is the only thing standing between a
     * column of integers and a finding, and its entry is either the label or the label
     * with its code name in brackets — so the label the child was shown has to be where
     * that string starts.
     */
    const sidecar = JSON.parse(fileAt(`phenotype/${row.instrument}.json`)!) as Record<
      string,
      { Levels?: Record<string, string> }
    >;
    const level = sidecar[row.variable]?.Levels?.[String(row.value)];
    if (level !== undefined) {
      expect(
        level === row.label || level.startsWith(`${row.label!} (`),
        `phenotype/${row.instrument}.json resolves ${row.variable}=${row.value} to "${level}", but the child was shown "${row.label}"`,
      ).toBe(true);
    }
    inTheTsv += 1;
  }
  // Enough of the questionnaire to mean something, rather than one lucky column.
  expect(inTheTsv).toBeGreaterThan(20);
});
