import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

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
const PASSPHRASE = "six brown otters reading";
/**
 * Resolved from the working directory rather than from `import.meta`.
 *
 * Playwright compiles these specs as CommonJS, where `import.meta` is a syntax
 * error, and the suite always runs from the repository root.
 */
const MANIFEST = resolve("releases/ybm_nd2026_standard_r7.2.0.manifest.json");

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
       * Some items are checked against an earlier answer — "the month you were born"
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
    await date.fill("2012-05-14");
    return;
  }

  const text = page.locator(".survey-body textarea:visible, .survey-body input.text-input:visible").first();
  if ((await text.count()) > 0) {
    for (const candidate of ["1", "A", "Something I would say about this."]) {
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

async function accepted(page: Page): Promise<boolean> {
  const next = page.locator("button.next:not(.big)").first();
  if ((await next.count()) === 0) return true;
  return next.isEnabled({ timeout: 2_000 }).catch(() => false);
}

async function position(page: Page): Promise<string> {
  return page.evaluate(() => {
    const screen = document.querySelector(".screen");
    if (screen?.classList.contains("finish")) return "finished";
    const heading = document.querySelector(".survey h1, .screen h1");
    const segments = document.querySelector(".segments")?.getAttribute("aria-label") ?? "";
    const step = document.querySelector(".survey-body p")?.textContent?.slice(0, 60) ?? "";
    return `${segments}|${heading?.textContent?.slice(0, 80) ?? ""}|${step}`;
  });
}

async function advance(page: Page): Promise<void> {
  for (const selector of [
    ".screen.checkin button.next.big",
    "button.next:not(.big)",
    "button.skip-go",
    ".screen button.primary",
    "button.primary",
  ]) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) continue;
    if (!(await button.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
    await button.click({ timeout: 5_000 });
    return;
  }
  throw new Error(`nothing to click on ${await position(page)}`);
}

test("the dataset says what the participant actually answered", async ({ page }) => {
  test.slow();
  const { stemOf, labelOf } = await definitions();
  const ledger: Tapped[] = [];

  await page.goto("./");
  await page.locator("input.code").fill(CODE);
  await page.locator("button.next.big").click();

  for (let screens = 0; screens < 400; screens += 1) {
    if ((await position(page)) === "finished") break;
    const before = await position(page);
    await answerAndRecord(page, ledger);
    let moved = false;
    for (let waited = 0; waited < 600; waited += 100) {
      if ((await position(page)) !== before) {
        moved = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    if (!moved) {
      await advance(page);
      await expect.poll(() => position(page), { timeout: 10_000 }).not.toBe(before);
    }
  }

  await expect(page.locator(".screen.finish")).toBeVisible();
  expect(ledger.length).toBeGreaterThan(20);

  // Hand over, and read the file back the way the researcher view does.
  await page.locator("button.next.big").first().click();
  const buildLine = page.locator("p.demo-note");
  for (let i = 0; i < 5; i += 1) await buildLine.click();
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
