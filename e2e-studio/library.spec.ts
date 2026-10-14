import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { paths } from "@myself/firebase";
import { grantOwner, openStudy, stored, type Study } from "./support/study.js";

/**
 * The item library and copying between studies, end to end (D-57, docs/16 §12):
 *
 *   a validated questionnaire from the library, published → questions from
 *   another survey's published version, keeping their IDs, published → a block
 *   saved as a module, improved in another survey as version 2, and the first
 *   survey told, reviewing and taking the update → a survey copied from a
 *   published version in another study space, and published there.
 *
 * Nothing is mocked: the drawer reads the catalogue and the modules through
 * the real callables, the published versions from each study's public release
 * store (verified by hash), and every publish goes through `studioPublish`,
 * which vouches for each copied questionnaire against the library or the
 * release it came from.
 *
 * Its study spaces and people are its own, and it never touches `ybm`, so the
 * suites that set `ybm` up from scratch run as they always did.
 */

const OWNER = "library.owner@leeds.test";
const A = "libtest_a";
const A_TITLE = "Library test A";
const B = "libtest_b";
const B_TITLE = "Library test B";
const PETS = "How many pets do you have?";
const PETS_V2 = "How many pets live in your home?";
const KSS = /KSS · Karolinska Sleepiness Scale/;
const MODULE_ID = "pets_at_home";

test.describe.configure({ mode: "serial" });

let study: Study;
let page: Page;

test.beforeAll(async ({ browser }) => {
  study = openStudy();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // A control that never becomes clickable is a failure to see at once, not after the whole test's time.
  page.setDefaultTimeout(30_000);
});

test.afterAll(async () => {
  await page?.close();
  await study?.close();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function signIn(email: string): Promise<void> {
  await page.goto("researcher/#/surveys");
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await page.waitForFunction(() => typeof (window as unknown as { __studioTestSignIn?: unknown }).__studioTestSignIn === "function");
  await page.evaluate((e) => (window as unknown as { __studioTestSignIn: (e: string) => Promise<void> }).__studioTestSignIn(e), email);
}

async function newStudySpace(id: string, title: string): Promise<void> {
  await page.goto("researcher/#/surveys");
  await page.getByRole("button", { name: /^Study space:/ }).click();
  await page.getByRole("menuitem", { name: /New study space/ }).click();
  const create = page.getByRole("dialog", { name: "New study space" });
  await create.getByLabel("Title").fill(title);
  await create.getByLabel("Study ID").fill(id);
  await create.getByRole("button", { name: "Create study space" }).click();
  await expect(page).toHaveURL(new RegExp(`#/study/${id}/surveys$`), { timeout: 30_000 });
}

/** A blank survey in the study the Studio is in, opened in the editor. */
async function newSurvey(studyId: string, surveyId: string, title: string): Promise<void> {
  await page.goto(`researcher/#/study/${studyId}/surveys`);
  await page.getByRole("button", { name: "New survey" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New survey" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Survey ID").fill(surveyId);
  await dialog.getByRole("button", { name: "Create survey" }).click();
  await expectEditor(studyId, surveyId);
}

async function expectEditor(studyId: string, surveyId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`#/study/${studyId}/surveys/${surveyId}/edit`), { timeout: 30_000 });
  await expect(page.getByPlaceholder("Search questions by text or ID")).toBeVisible({ timeout: 60_000 });
}

async function openEditor(studyId: string, surveyId: string, q?: string): Promise<void> {
  await page.goto(`researcher/#/study/${studyId}/surveys/${surveyId}/edit${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  await page.reload();
  await expectEditor(studyId, surveyId);
}

/**
 * The draft as stored once it shows a change: the save landed, so leaving the
 * page now loses nothing (and the editor will not ask whether to).
 */
async function savedWhen(studyId: string, surveyId: string, check: (draft: StoredDraft) => boolean): Promise<StoredDraft> {
  let last: StoredDraft | null = null;
  await expect
    .poll(async () => {
      last = (await draftOf(studyId, surveyId)).draft;
      return !!last && check(last);
    }, { timeout: 30_000 })
    .toBe(true);
  await expect(page.getByRole("status").filter({ hasText: /^Saved/ }).first()).toBeVisible({ timeout: 30_000 });
  return last!;
}

const hasImport = (kind: string, more: Record<string, unknown> = {}) => (d: StoredDraft) =>
  (d.imports ?? []).some((r) => r.origin["kind"] === kind && Object.entries(more).every(([k, v]) => r.origin[k] === v));

async function openLibrary() {
  await page.getByRole("button", { name: "Library", exact: true }).first().click();
  const drawer = page.getByRole("dialog", { name: "Library" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function expectAdded(): Promise<void> {
  await expect(page.getByText("Added from the library").first()).toBeVisible({ timeout: 15_000 });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function publish(version: string, note: string): Promise<void> {
  await expect(page.getByRole("button", { name: /error/ })).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole("button", { name: /^Publish/ }).first().click();
  const dialog = page.getByRole("dialog", { name: /Publish a new version/ });
  await expect(dialog).toBeVisible();
  const reviewed = dialog.getByLabel("I’ve reviewed these warnings");
  if (await reviewed.count()) {
    await reviewed.check();
    await dialog.getByRole("button", { name: "Continue" }).click();
  }
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText(version).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByLabel(/Release note for/).fill(note);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: new RegExp(`^Publish r?${escape(version)}`) }).click();
  const done = page.getByRole("dialog", { name: "Published" });
  await expect(done.getByText(new RegExp(`${escape(version)} is live`))).toBeVisible({ timeout: 60_000 });
  await done.getByRole("button", { name: "Done" }).click();
}

interface StoredDraft {
  instruments: Record<string, { instrument: string; forms: { items: { key: string; stem: { text: string } }[] }[] }>;
  imports?: { origin: Record<string, unknown>; items: Record<string, string> }[];
}

async function draftOf(studyId: string, surveyId: string): Promise<{ draft: StoredDraft; basedOn: unknown }> {
  const doc = await stored(study.db, paths.studioDraft(studyId, surveyId));
  return { draft: JSON.parse(String(doc?.["content"] ?? "null")) as StoredDraft, basedOn: doc?.["basedOn"] ?? null };
}

/** The ID of the question with this wording in a draft. */
function idOf(draft: StoredDraft, text: string): string | null {
  for (const def of Object.values(draft.instruments)) {
    for (const item of def.forms[0]?.items ?? []) if (item.stem.text === text) return `${def.instrument}.${item.key}`;
  }
  return null;
}

// ── The tests ───────────────────────────────────────────────────────────────

test("a validated questionnaire is added from the library and published", async () => {
  // An owner, signed in again once the claim is on their account.
  await signIn(OWNER);
  await expect(page.getByRole("heading", { name: "You don’t have access yet" })).toBeVisible({ timeout: 30_000 });
  await grantOwner(OWNER);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await signIn(OWNER);
  await expect(page.getByRole("heading", { name: "Surveys" })).toBeVisible({ timeout: 30_000 });
  await newStudySpace(A, A_TITLE);

  await newSurvey(A, "lib_one", "Library one");
  // A question of the survey's own, written here.
  await page.getByRole("button", { name: "Add question" }).first().click();
  await page.getByRole("dialog", { name: "Add a question" }).getByRole("button", { name: /^Number/ }).click();
  await page.locator('[data-field="stem"]').first().fill(PETS);
  await savedWhen(A, "lib_one", (d) => !!idOf(d, PETS));

  // The KSS, from the library's validated questionnaires.
  const drawer = await openLibrary();
  await drawer.getByRole("tab", { name: "Validated questionnaires" }).click();
  await drawer.getByRole("button", { name: KSS }).click();
  await expect(drawer.getByText("Added whole and unchanged, exactly as licensed")).toBeVisible();
  await drawer.getByRole("button", { name: "Add 1 question" }).click();
  await expectAdded();
  await expect(drawer).toBeHidden();

  const draft = await savedWhen(A, "lib_one", hasImport("validated"));
  expect(Object.keys(draft.instruments)).toContain("kss@1.0/en-GB/self/standard");
  expect(draft.imports?.map((r) => r.origin["kind"])).toEqual(["validated"]);

  // The server vouches for it against the instrument library, and publishes.
  await publish("1.0.0", "Pets and the KSS, for the library test.");
  const version = await stored(study.db, paths.studioVersion(A, "lib_one", "1.0.0"));
  expect(version?.["imports"]).toEqual([expect.objectContaining({ origin: expect.objectContaining({ kind: "validated", instrument: "kss" }) })]);
  expect(await stored(study.db, paths.publishedPointer(A, "lib_one"))).toMatchObject({ version: "1.0.0" });
});

test("questions are copied from another survey's published version, keeping their IDs, and published", async () => {
  const pets = idOf((await draftOf(A, "lib_one")).draft, PETS)!;
  expect(pets).toBeTruthy();

  await newSurvey(A, "lib_two", "Library two");
  const drawer = await openLibrary();
  await drawer.getByRole("tab", { name: "Published surveys" }).click();
  await drawer.getByRole("button", { name: /Library one/ }).click();
  // A question of an editable block on its own; the licensed questionnaire only whole, padlocked.
  await drawer.getByRole("checkbox", { name: new RegExp(escape(PETS)) }).check();
  await expect(drawer.getByText("Licensed · whole only")).toBeVisible();
  await drawer.getByRole("checkbox", { name: /Whole block: Karolinska Sleepiness Scale/ }).check();
  await drawer.getByRole("button", { name: "Add 2 questions" }).click();
  await expectAdded();

  const draft = await savedWhen(A, "lib_two", hasImport("release"));
  // The same ID, so it exports to the same column as lib_one's.
  expect(idOf(draft, PETS)).toBe(pets);
  const origins = draft.imports?.map((r) => r.origin) ?? [];
  expect(origins.every((o) => o["kind"] === "release" && o["study"] === A && o["surveyId"] === "lib_one" && o["version"] === "1.0.0")).toBe(true);
  expect(draft.imports?.flatMap((r) => Object.keys(r.items))).toEqual(expect.arrayContaining([pets, "kss.q1"]));

  // The copied KSS is vouched for by the release it came from, read from its store.
  await publish("1.0.0", "Copied from Library one.");
  const version = await stored(study.db, paths.studioVersion(A, "lib_two", "1.0.0"));
  expect(JSON.stringify(version?.["imports"])).toContain(pets);

  // The provenance download says where each copied question came from.
  await page.goto(`researcher/#/study/${A}/surveys/lib_two/versions`);
  await expect(page.getByRole("table", { name: /Published versions/ })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Download provenance" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "As a spreadsheet (CSV)" }).click()]);
  const csv = (await readFile((await download.path())!, "utf8")).replace(/^﻿/, "").split("\r\n");
  expect(csv[0]).toMatch(/,copied_from$/);
  expect(csv.find((l) => l.startsWith("1.0.0,"))).toContain(`${pets} from survey ${A}/lib_one r1.0.0`);
});

test("a block saved as a module, improved elsewhere, offers its update to the first survey", async () => {
  const pets = idOf((await draftOf(A, "lib_one")).draft, PETS)!;

  // ── Save lib_one's own block to the library ──────────────────────────────
  await openEditor(A, "lib_one", "block:welcome:0");
  await page.getByRole("button", { name: "Save to library…" }).click();
  let dialog = page.getByRole("dialog", { name: "Save to library" });
  await dialog.getByLabel("Title").fill("Pets at home");
  await expect(dialog.getByLabel("Module ID")).toHaveValue(MODULE_ID);
  await dialog.getByLabel("Tags").fill("pets, home");
  await dialog.getByRole("checkbox", { name: /Welcome, and thank you/ }).uncheck();
  await dialog.getByLabel("Note").fill("Pets, as asked in Library one.");
  await dialog.getByRole("button", { name: "Save to library" }).click();
  await expect(page.getByText("Saved “Pets at home” to the library").first()).toBeVisible({ timeout: 30_000 });
  // lib_one records that its question is now the module's version 1, so it hears of later ones.
  await savedWhen(A, "lib_one", hasImport("module", { moduleId: MODULE_ID, version: 1 }));
  expect(await stored(study.db, paths.studioLibraryModule(MODULE_ID))).toMatchObject({ title: "Pets at home", latestVersion: 1, tags: ["pets", "home"] });

  // ── Another survey adds the module, rewords it, and saves version 2 ───────
  await newSurvey(A, "lib_three", "Library three");
  const drawer = await openLibrary();
  await drawer.getByRole("tab", { name: "Saved modules" }).click();
  await drawer.getByRole("button", { name: /Pets at home/ }).click();
  await expect(drawer.getByText("Pets, as asked in Library one.")).toBeVisible();
  await drawer.getByRole("button", { name: "Add 1 question" }).click();
  await expectAdded();
  expect(idOf(await savedWhen(A, "lib_three", hasImport("module", { moduleId: MODULE_ID })), PETS)).toBe(pets);

  await openEditor(A, "lib_three", pets);
  await page.locator('[data-field="stem"]').first().fill(PETS_V2);
  await savedWhen(A, "lib_three", (d) => idOf(d, PETS_V2) === pets);
  await openEditor(A, "lib_three", "block:welcome:0");
  await page.getByRole("button", { name: "Save to library…" }).click();
  dialog = page.getByRole("dialog", { name: "Save to library" });
  await expect(dialog.getByRole("radio", { name: /A new version of ‘Pets at home’ \(v2\)/ })).toBeChecked();
  await dialog.getByRole("checkbox", { name: /Welcome, and thank you/ }).uncheck();
  await dialog.getByLabel("What changed in this version").fill("Asks who lives at home.");
  await dialog.getByRole("button", { name: "Save version 2" }).click();
  await expect(page.getByText("Saved version 2 of “Pets at home”").first()).toBeVisible({ timeout: 30_000 });
  expect(await stored(study.db, paths.studioLibraryModule(MODULE_ID))).toMatchObject({ latestVersion: 2 });
  await savedWhen(A, "lib_three", hasImport("module", { moduleId: MODULE_ID, version: 2 }));

  // ── lib_one is told, reviews, and takes it ────────────────────────────────
  await openEditor(A, "lib_one", pets);
  const notice = page.getByText("A newer version of ‘Pets at home’ is in the library (v2)").first();
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Review" }).first().click();
  const review = page.getByRole("dialog", { name: /Update ‘Pets at home’ to version 2/ });
  await expect(review.getByText("Takes the newer version")).toBeVisible({ timeout: 30_000 });
  await review.getByRole("button", { name: "Update this survey’s copy" }).click();
  await expect(page.getByText("Updated to version 2").first()).toBeVisible();
  await expect(page.locator('[data-field="stem"]').first()).toHaveValue(PETS_V2);
  await expect(page.getByText("A newer version of ‘Pets at home’ is in the library")).toHaveCount(0);
  const draft = await savedWhen(A, "lib_one", hasImport("module", { moduleId: MODULE_ID, version: 2 }));
  expect(idOf(draft, PETS_V2)).toBe(pets);

  // The Library page lists it, with both versions.
  await page.goto(`researcher/#/study/${A}/library`);
  await page.getByRole("button", { name: "Pets at home" }).click();
  const details = page.getByRole("dialog", { name: "Pets at home" });
  await expect(details.getByText("Asks who lives at home.")).toBeVisible({ timeout: 30_000 });
  await expect(details.getByText("Pets, as asked in Library one.")).toBeVisible();
  await details.getByRole("contentinfo").getByRole("button", { name: "Close" }).click();
});

test("a survey is copied from a published version in another study space", async () => {
  await newStudySpace(B, B_TITLE);
  await page.getByRole("button", { name: "New survey" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New survey" });
  await dialog.getByLabel("Title").fill("Copied from A");
  await dialog.getByLabel("Survey ID").fill("lib_copy");
  await dialog.getByRole("radio", { name: /A published version of a survey/ }).check();
  await dialog.getByLabel("Survey", { exact: true }).selectOption({ label: "Library one (lib_one)" });
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("1.0.0");
  // Said before anything is made: another study's consent comes with it to check, and its identity module still protected.
  await expect(dialog.getByText(`From another study space, “${A_TITLE}”`)).toBeVisible();
  await expect(dialog.getByText(/check it is right for this study/)).toBeVisible();
  await dialog.getByRole("button", { name: "Create survey" }).click();
  await expectEditor(B, "lib_copy");

  const pointer = (await stored(study.db, paths.publishedPointer(A, "lib_one"))) as { hash: string };
  const { draft, basedOn } = await draftOf(B, "lib_copy");
  expect(basedOn).toEqual({ version: "1.0.0", hash: pointer.hash, study: A });
  expect(idOf(draft, PETS)).toBeTruthy();
  // The copy remembers where it came from, as any copied piece does.
  expect(draft.imports?.map((r) => r.origin)).toContainEqual({ kind: "release", study: A, surveyId: "lib_one", version: "1.0.0", hash: pointer.hash });

  // Its first publish checks its licensed questionnaire against lib_one's release, read from A's store.
  await publish("1.0.0", "Started from Library one in another study space.");
  expect(await stored(study.db, paths.publishedPointer(B, "lib_copy"))).toMatchObject({ version: "1.0.0", study: B });
});
