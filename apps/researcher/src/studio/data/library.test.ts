import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  emptyDraft,
  extractDraft,
  fragmentFromDraft,
  insertFragment,
  lockBaseline,
  validateDraft,
  validatedFragment,
  type InsertOptions,
  type StudioDraft,
} from "@myself/studio";
import { LibraryCache, libraryKeys, releaseRefKey, vouchersFor } from "./library.js";

/**
 * The library's data layer (D-57): answers shared between the panels that ask
 * for them, forgotten when the library changes; and the vouchers the editor
 * validates with, which must accept a copied questionnaire exactly when the
 * server will (docs/16 §12.4).
 */

const manifest = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../../../releases/${name}`), "utf8"));
const r730 = manifest("ybm_nd2026_standard_r7.3.0.manifest.json");
const opts: InsertOptions = { by: "uid-researcher", byEmail: "researcher@example.org", at: "2026-10-06T12:00:00.000Z", importId: "imp_test" };

describe("shared library answers", () => {
  it("asks once for an answer several panels want, and again after a failure", async () => {
    const cache = new LibraryCache();
    const load = vi.fn().mockResolvedValue(["a"]);
    const [x, y] = await Promise.all([cache.get("modules|ybm|shelf", load), cache.get("modules|ybm|shelf", load)]);
    expect(x).toBe(y);
    expect(load).toHaveBeenCalledTimes(1);

    const failing = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("ok");
    await expect(cache.get("catalogue|ybm", failing)).rejects.toThrow("offline");
    expect(cache.has("catalogue|ybm")).toBe(false);
    await expect(cache.get("catalogue|ybm", failing)).resolves.toBe("ok");
  });

  it("forgets what can change when the library changes, keeps numbered versions, and tells its readers", async () => {
    const cache = new LibraryCache();
    const heard = vi.fn();
    cache.subscribe(heard);
    const keys = [
      libraryKeys.catalogue("ybm"),
      libraryKeys.modules("ybm", false),
      libraryKeys.module("ybm", "sleep_habits", null),
      libraryKeys.module("ybm", "sleep_habits", 3),
    ];
    for (const key of keys) await cache.get(key, async () => key);
    const before = cache.version();
    cache.invalidate();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(cache.version()).toBe(before + 1);
    expect(keys.map((k) => cache.has(k))).toEqual([false, false, false, true]);
  });

  it("asks again once an answer is older than a reader allows, showing the last one meanwhile", async () => {
    const cache = new LibraryCache();
    const load = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    expect(cache.peek("catalogue|ybm")).toBeNull();
    await cache.get("catalogue|ybm", load, 15_000, 1_000);
    await cache.get("catalogue|ybm", load, 15_000, 10_000);
    expect(load).toHaveBeenCalledTimes(1);
    const fresher = cache.get("catalogue|ybm", load, 15_000, 20_000);
    expect(cache.peek("catalogue|ybm")).toEqual({ value: "first" });
    await expect(fresher).resolves.toBe("second");
    expect(cache.peek("catalogue|ybm")).toEqual({ value: "second" });
    // Forgotten on invalidation, but still shown until the next answer arrives.
    cache.invalidate();
    expect(cache.has("catalogue|ybm")).toBe(false);
    expect(cache.peek("catalogue|ybm")).toEqual({ value: "second" });
  });

  it("names a release by its study and hash", () => {
    expect(releaseRefKey({ study: "future", hash: "sha256:ab" })).toBe("future/sha256:ab");
  });
});

describe("the editor's vouchers", () => {
  /** A never-published pilot survey, checked as the server checks a first publish. */
  const lockErrors = (d: StudioDraft, releases: StudioDraft[] | null) =>
    validateDraft(d, { baseline: lockBaseline(null, d), ...(releases ? vouchersFor(releases, d) : {}) }).filter((i) => i.code.startsWith("locked."));
  const pilot = () => emptyDraft({ surveyId: "pilot_2027", study: "pilot", title: "Pilot" });

  it("accept a validated questionnaire added from the library, unchanged", () => {
    const d = insertFragment(pilot(), validatedFragment("kss@1.0/en-GB/self/standard"), { sectionKey: "welcome" }, opts).draft;
    expect(lockErrors(d, null).length).toBeGreaterThan(0);
    expect(lockErrors(d, [])).toEqual([]);
  });

  it("accept a questionnaire copied from a published version only when that verified version is given", () => {
    const source = extractDraft(r730);
    const piece = fragmentFromDraft(source, { kind: "block", sectionKey: "wellbeing", componentIndex: 1 }, {
      kind: "release",
      study: "ybm",
      surveyId: "ybm_nd2026_standard",
      version: "7.3.0",
      hash: r730.hash,
    });
    const d = insertFragment(pilot(), piece, { sectionKey: "welcome" }, opts).draft;
    expect(lockErrors(d, [source])).toEqual([]);
    // Naming the release is not enough: without it, the older SDQ is not the library's.
    expect(lockErrors(d, []).length).toBeGreaterThan(0);
  });
});
