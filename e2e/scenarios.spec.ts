import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CANDIDATE, openOnCandidate } from "./support/candidate.js";
import { openStaffPanel } from "./support/staff.js";
import { installClock, settle } from "./support/walker.js";

/**
 * Whole sittings through the real app, down different paths, handed over and read
 * back — the survey's half of testing the survey and the dashboard against each
 * other.
 *
 * Each scenario is a participant with a story: an age that picks one SDQ form or
 * the other, social media or none, a postcode known or not, one language or
 * three, understood and spoken. The walk answers the screens that story is
 * about on purpose and everything else sensibly, hands the sitting over as the
 * encrypted file a researcher would receive, and reads it back through the
 * survey's own ingest. Then the dataset must say what the participant did.
 *
 * The sittings are also written to test-results/scenarios/, and a copy is kept in
 * the dashboard repository as a fixture, so the dashboard is tested on sittings
 * the real app produced rather than ones a test imagined. Every name, date and
 * address here is invented; the address is the University of Leeds campus.
 */

const PASSPHRASE = "six brown otters reading";
/**
 * The scenarios are the r9.0.0 survey's (street search, languages, D-53, D-58), and r9.0.0
 * is a candidate until it is approved — so each sitting is on it as a release
 * downloaded from the study (see support/candidate.ts), with the service worker
 * out of the way so the download reaches the stand-in study.
 */
const MANIFEST = CANDIDATE;
test.use({ serviceWorkers: "block" });
const OUT = resolve("test-results/scenarios");
const storeTools = () => import("@myself/store");

type Act = (page: Page) => Promise<void>;
interface Scenario {
  name: string;
  code: string;
  first: string;
  last: string;
  dob: string;
  /** Screens answered on purpose, matched on the question heading. */
  rules: [RegExp, Act][];
  /** Leave optional questions blank rather than answering them. */
  skipOptional?: boolean;
}

const heading = (page: Page) =>
  page.evaluate(() => document.querySelector(".survey-body h1")?.textContent?.trim() ?? "");
// Each leaves an option that is already chosen as it is: a second tap on a
// checkbox would untick it, and a chosen radio may be on a screen that is
// already moving on by itself.
const choose = (label: string): Act => async (page) => {
  const radio = page.getByRole("radio", { name: label, exact: true });
  if ((await radio.getAttribute("aria-checked")) !== "true") await radio.click();
};
const tick = (...labels: string[]): Act => async (page) => {
  for (const label of labels) {
    const box = page.getByRole("checkbox", { name: label, exact: true });
    if ((await box.getAttribute("aria-checked")) !== "true") await box.click();
  }
};
const type = (text: string): Act => async (page) => {
  await page.locator(".survey-body input.text-input:visible, .survey-body textarea:visible").first().fill(text);
};

const common = (s: { first: string; last: string; dob: string }): [RegExp, Act][] => [
  [/^What.s your first name\?$/, type(s.first)],
  [/^What.s your last name/, type(s.last)],
  [/date of birth/, async (page) => page.locator('.survey-body input[type="date"]').fill(s.dob)],
];

const scenarios: Scenario[] = [
  {
    name: "fourteen, three languages, social media",
    code: "SCN0001",
    first: "Scenario",
    last: "Alpha",
    dob: "2012-05-14",
    rules: [
      [
        /home address/,
        async (page) => {
          await page.getByRole("textbox", { name: "Postcode" }).fill("LS2 9JT");
          await page.getByRole("textbox", { name: "House number or name" }).fill("University of Leeds");
          await page.getByRole("textbox", { name: "Street" }).fill("Woodhouse Lane");
        },
      ],
      [/ethnic origin/, choose("Pakistani")],
      [/first language you learned/, choose("I learned English and another language at the same time")],
      [/any language other than English/, choose("Yes")],
      [/^Which other languages/, tick("Urdu", "Punjabi", "Another language")],
      [/^Which other language\?/, type("Pashto")],
      [/understand Urdu when/, choose("Very well")],
      [/speak Urdu\?/, choose("Only a few words")],
      [/understand Punjabi when/, choose("Well")],
      [/speak Punjabi\?/, choose("Well")],
      [/understand Pashto when/, choose("Only a few words")],
      [/speak Pashto\?/, choose("Not at all")],
      [/sleep quality overall/, choose("7, Good")],
      [/own smartphone/, choose("Yes")],
      [/currently use social media/, choose("Yes")],
      // AI chatbots (D-59): uses them, including to talk about feelings.
      [/use AI chatbots or assistants/, choose("A few times a week")],
      [/^What do you use them for/, tick("Schoolwork or homework", "Talking about my feelings or when I'm upset")],
      [/After using AI chatbots/, choose("It depends")],
      [
        /could go without social media/,
        async (page) => {
          await page.locator(".survey-body input.numeric").fill("400");
          await page.getByRole("button", { name: "Yes, that's right" }).click();
        },
      ],
      [/^Does your family manage/, choose("Yes")],
      [/^How does your family manage/, tick("They set time limits or times when I can't use it", "Something else")],
      // A formula, as typed: the exports must never let a spreadsheet run it.
      [/What else does your family do/, type("=HYPERLINK(\"http://example.invalid\",\"x\")")],
    ],
  },
  {
    name: "twenty, no social media, no postcode",
    code: "SCN0002",
    first: "Scenario",
    last: "Bravo",
    dob: "2006-03-01",
    rules: [
      [
        /home address/,
        async (page) => {
          await page.getByRole("textbox", { name: "Postcode" }).fill("LS99 9ZZ");
          await page.getByRole("button", { name: "I don't know my postcode" }).click();
          await page.getByRole("textbox", { name: "House number or name" }).fill("University of Leeds");
          await page.getByRole("textbox", { name: "Street" }).fill("woodhouse ln");
          await page.locator(".street-match", { hasText: "Woodhouse Lane" }).filter({ hasText: "LS2" }).click();
        },
      ],
      [/ethnic origin/, choose("English, Welsh, Scottish, Northern Irish or British")],
      [/first language you learned/, choose("Yes")],
      [/any language other than English/, choose("No")],
      [/sleep quality overall/, choose("2, Poor")],
      [/own smartphone/, choose("No")],
      [/currently use social media/, choose("No")],
      [/^Just to check/, choose("No")],
    ],
  },
  {
    name: "twelve, leaves optional questions blank, Polish",
    code: "SCN0003",
    first: "Scenario",
    last: "Charlie",
    dob: "2014-09-30",
    skipOptional: true,
    rules: [
      [/ethnic origin/, choose("Prefer not to say")],
      [/first language you learned/, choose("No")],
      [/any language other than English/, choose("Yes")],
      [/^Which other languages/, tick("Polish")],
      [/understand Polish when/, choose("Very well")],
      [/speak Polish\?/, choose("Well")],
      [/sleep quality overall/, choose("10, Excellent")],
      [/own smartphone/, choose("Yes")],
      [/currently use social media/, choose("Yes")],
      [/could go without social media/, async (page) => page.locator(".survey-body input.numeric").fill("20")],
      [/^Does your family manage/, choose("No")],
    ],
  },
];

async function position(page: Page): Promise<string> {
  return page.evaluate(() => {
    const screen = document.querySelector(".screen");
    if (screen?.classList.contains("finish")) return "finished";
    const h = document.querySelector(".survey h1, .screen h1");
    const segments = document.querySelector(".segments")?.getAttribute("aria-label") ?? "";
    const step = document.querySelector(".survey-body p")?.textContent?.slice(0, 60) ?? "";
    return `${segments}|${h?.textContent?.slice(0, 80) ?? ""}|${step}`;
  });
}

const nextButton = (page: Page) => page.locator("button.next:not(.big)").first();

/** Whatever the screen is, give a plausible answer (the first option, mostly). */
async function answerGenerally(page: Page): Promise<void> {
  const consent = page.locator(".consent-list input[type=checkbox]:visible");
  if ((await consent.count()) > 0) {
    for (let i = 0; i < (await consent.count()); i += 1) await consent.nth(i).check();
    return;
  }
  const radios = page.locator('[role="radiogroup"] button:visible');
  if ((await radios.count()) > 0) {
    await radios.first().click();
    return;
  }
  const cards = page.locator('[role="group"] button.card:visible, [role="group"] button.chip:visible');
  if ((await cards.count()) > 0) {
    await cards.first().click();
    return;
  }
  const ladder = page.locator(".survey-body .ladder-svg:visible").first();
  if ((await ladder.count()) > 0) {
    await ladder.click();
    return;
  }
  const slider = page.locator('.survey-body input[type="range"]:visible').first();
  if ((await slider.count()) > 0) {
    await slider.fill("5");
    return;
  }
  const text = page.locator(".survey-body textarea:visible, .survey-body input.text-input:visible").first();
  if ((await text.count()) > 0) {
    for (const candidate of ["1", "A", "LS2 9JT", "Something I would say about this."]) {
      await text.fill(candidate);
      if (await nextButton(page).isEnabled({ timeout: 1_000 }).catch(() => false)) return;
    }
  }
}

/** Move on with nothing answered, if the question allows it; true if it did. */
async function skip(page: Page): Promise<boolean> {
  const next = nextButton(page);
  if (!(await next.isEnabled({ timeout: 500 }).catch(() => false))) return false;
  await next.click();
  const go = page.locator("button.skip-go");
  if (await go.isVisible({ timeout: 1_000 }).catch(() => false)) await go.click();
  return true;
}

async function advance(page: Page): Promise<void> {
  for (const selector of [".screen.checkin button.next.big", "button.next:not(.big)", "button.skip-go", ".screen button.primary", "button.primary"]) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) continue;
    if (!(await button.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
    await button.click({ timeout: 5_000 });
    return;
  }
  throw new Error(`nothing to click on ${await position(page)}`);
}

async function sit(page: Page, s: Scenario): Promise<Set<string>> {
  const used = new Set<string>();
  const rules = [...common(s), ...s.rules];
  await installClock(page);
  await openOnCandidate(page);
  await page.locator("input.code").fill(s.code);
  await page.locator("button.next.big").click();
  /**
   * The screen a rule last answered. A screen that moves on by itself can still
   * be showing for a moment after the walk has seen something change (on a slow
   * WebKit run, often), and answering it a second time then waits on an option
   * that is leaving the page — so a screen is answered once, then only moved on.
   */
  let answered = "";
  for (let screens = 0; screens < 400; screens += 1) {
    const before = await position(page);
    if (before === "finished") return used;
    // Three blanks in a row bring a gentle check-in. Someone leaving questions
    // blank on purpose says "Keep going"; "Go back to them" would loop forever.
    // (The "No rush" pace screen looks the same but has only "Carry on".)
    const keepGoing = page.locator(".screen.checkin").getByRole("button", { name: "Keep going" });
    if (s.skipOptional && (await keepGoing.count()) > 0) {
      await keepGoing.click();
      await expect.poll(() => position(page), { timeout: 10_000 }).not.toBe(before);
      continue;
    }
    const h = await heading(page);
    const screen = `${before.split("|")[0]}|${h}`;
    const rule = rules.find(([when]) => when.test(h));
    if (rule && screen === answered) {
      // Already answered; fall through to waiting for it to move, or moving it.
    } else if (rule) {
      used.add(rule[0].source);
      await rule[1](page);
      answered = screen;
    } else if (s.skipOptional && !h.includes("Please tap each statement") && (await page.locator(".survey-body .lede-body").count()) === 0) {
      // An information screen (lede-body) is not a question to leave blank.
      if (await skip(page)) {
        await expect.poll(() => position(page), { timeout: 10_000 }).not.toBe(before);
        continue;
      }
      await answerGenerally(page);
    } else {
      await answerGenerally(page);
    }
    const moved = await settle(page, before, { position, graceMs: 800 });
    if (!moved) {
      await advance(page);
      await expect.poll(() => position(page), { timeout: 10_000, message: `stuck on ${before}` }).not.toBe(before);
    }
  }
  throw new Error("the sitting did not finish");
}

async function handOver(page: Page): Promise<unknown> {
  await page.locator("button.next.big").first().click();
  await openStaffPanel(page);
  await page.locator('.handover input[type="password"]').fill(PASSPHRASE);
  const download = page.waitForEvent("download");
  await page.locator("button", { hasText: "Export completed sessions" }).click();
  const file = await (await download).path();
  const { openExport } = await storeTools();
  const opened = (await openExport(JSON.parse(await readFile(file!, "utf8")) as never, PASSPHRASE)) as { sessions: unknown[] };
  expect(opened.sessions).toHaveLength(1);
  return opened.sessions[0];
}

test.describe.configure({ mode: "serial" });

const sittings: Record<string, unknown> = {};

for (const s of scenarios) {
  test(`a whole sitting: ${s.name}`, async ({ page }) => {
    test.setTimeout(420_000);
    const used = await sit(page, s);
    // Every screen this story is about was actually reached and answered on purpose.
    const missed = [...common(s), ...s.rules].map(([when]) => when.source).filter((w) => !used.has(w));
    expect(missed, "screens the scenario never reached").toEqual([]);
    sittings[s.code] = await handOver(page);
  });
}

test("the survey's own dataset says what each scenario answered", async () => {
  expect(Object.keys(sittings)).toHaveLength(scenarios.length);
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/r9-scenarios.json`, `${JSON.stringify({ sessions: Object.values(sittings) }, null, 2)}\n`);

  const { ingest } = await storeTools();
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const result = ingest(Object.values(sittings) as never, { manifest, study: "ybm" });
  expect(result.rejected).toEqual([]);

  const sessionOf = new Map(result.dataset.sessions.map((x: { sessionId: string; studyCode?: string }) => [x.studyCode, x.sessionId]));
  const value = (code: string, variable: string) => {
    const row = result.dataset.responses.find(
      (r: { sessionId: string; variable: string }) => r.sessionId === sessionOf.get(code) && r.variable === variable,
    ) as { value: number | null; text: string | null; status: string } | undefined;
    return row;
  };

  // Alpha: three languages, the third named; a long break from social media.
  // Record linkage is one of the consent statements now (D-58), not a question.
  expect(value("SCN0001", "linkage_consent")).toBeUndefined();
  expect(value("SCN0001", "consent")?.text).toContain("record_linkage");
  expect(value("SCN0001", "first_language_english")?.value).toBe(3);
  expect(value("SCN0001", "other_languages")?.text).toBe("1,2,15");
  expect(value("SCN0001", "other_language_named")?.text).toBe("Pashto");
  expect(value("SCN0001", "understand_urdu")?.value).toBe(1);
  expect(value("SCN0001", "understand_punjabi")?.value).toBe(2);
  expect(value("SCN0001", "understand_other_language")?.value).toBe(4);
  // Understood very well, spoken only a few words: receptive, not expressive (D-58).
  expect(value("SCN0001", "speak_urdu")?.value).toBe(4);
  expect(value("SCN0001", "speak_punjabi")?.value).toBe(2);
  expect(value("SCN0001", "speak_other_language")?.value).toBe(5);
  expect(value("SCN0001", "ai_use_frequency")?.value).toBe(3);
  expect(value("SCN0001", "ai_use_purpose")?.text).toBe("1,6");
  expect(value("SCN0001", "ai_use_feeling")?.value).toBe(4);
  expect(value("SCN0001", "understand_polish")).toBeUndefined();
  expect(value("SCN0001", "sqs_q1")?.value).toBe(7);
  expect(value("SCN0001", "sm_abstain_days")?.value).toBe(400);
  expect(value("SCN0001", "ethnicity")?.value).toBe(2);
  expect(value("SCN0001", "sm_family_control_how")?.text).toBe("1,8");
  expect(value("SCN0001", "sm_family_control_other")?.text).toMatch(/^=HYPERLINK/);

  // Bravo: 18+ SDQ, no social media, street found without a postcode.
  expect(value("SCN0002", "speaks_other_language")?.value).toBe(2);
  expect(value("SCN0002", "other_languages")).toBeUndefined();
  expect(value("SCN0002", "sqs_q1")?.value).toBe(2);
  expect(value("SCN0002", "sdq25_s18_q1")).toBeDefined();
  expect(value("SCN0002", "sdq25_q1")).toBeUndefined();
  expect(value("SCN0001", "sdq25_q1")).toBeDefined();
  expect(value("SCN0001", "sdq25_s18_q1")).toBeUndefined();
  expect(value("SCN0002", "sm_abstain_days")).toBeUndefined();

  // Charlie: declined ethnicity, Polish, a short break from social media.
  expect(value("SCN0003", "ethnicity")?.value).toBe(20);
  expect(value("SCN0003", "understand_polish")?.value).toBe(1);
  expect(value("SCN0003", "speak_polish")?.value).toBe(2);
  expect(value("SCN0003", "sm_abstain_days")?.value).toBe(20);

  // Identifiers go to the identity partition only, never a response row.
  const everything = JSON.stringify(result.dataset);
  for (const secret of ["Alpha", "Bravo", "Charlie", "Woodhouse", "LS2 9JT", "University of Leeds"]) {
    expect(everything, secret).not.toContain(secret);
  }
  const address = result.identity.find(
    (r: { variable: string; sessionId: string }) => r.variable === "home_address" && r.sessionId === sessionOf.get("SCN0002"),
  ) as { value: string } | undefined;
  expect(JSON.parse(address!.value)).toMatchObject({ street: "Woodhouse Lane", area: "Leeds", postcode_district: "LS2" });
  // Three different people, three different IDs from name and date of birth.
  const ids = new Set(result.dataset.sessions.map((x: { participantId: string }) => x.participantId));
  expect(ids.size).toBe(3);
});
