import { describe, expect, it, vi } from "vitest";
import {
  addQuestion,
  archiveQuestion,
  definedQuestions,
  editTier,
  extractDraft,
  liveQuestions,
  setQuestionNotes,
  unlockModule,
  validateDraft,
  type StudioDraft,
} from "@myself/studio";
import { bundledManifests } from "../releases.js";
import { authorsOf, bumpTaken } from "./publish.js";
import { identityIssues, licenceEscapes, lockBaseline } from "./store.js";
import { mergeRestore } from "./versions.js";

vi.mock("firebase-functions/logger", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn(), write: vi.fn() }));

/**
 * The decisions behind restore and publish that need no database: what a
 * restore keeps, what a never-published survey's locks are checked against,
 * and what the server refuses beyond Studio validation. Real releases
 * throughout — r7.0.1 and r7.1.0 from the repository — because the cases worth
 * catching are the ones real content produces.
 */

const draftOf = (version: string): StudioDraft => extractDraft(bundledManifests.find((b) => b.manifest.release.version === version)!.raw);
const AT = "2026-09-28T12:00:00.000Z";
const keys = (d: StudioDraft) => new Set(definedQuestions(d).map((q) => q.itemKey));

describe("restoring a version into the draft", () => {
  const current = () => {
    let d = draftOf("7.1.0");
    const section = d.composition.sections[1]!.key;
    d = addQuestion(d, { sectionKey: section, typeId: "short_text", text: "What is your favourite colour?" }).draft;
    d = setQuestionNotes(d, "ybm_studio.favourite_colour", { codingNotes: "Free text; code later." }).draft;
    d = unlockModule(d, "ybm_intro_consent", { by: "u_ed", at: AT, reason: "Ethics amendment AM-3 approved the new wording." }).draft;
    d.retiredCodes = { "scale.kept_for_ever": [{ code: 7, label: "Old answer", retiredAt: AT }] };
    return d;
  };

  it("is the version's content, with the Studio's own memory carried over", () => {
    const restored = draftOf("7.0.1");
    const merged = mergeRestore(restored, current(), { at: AT, by: "u_pub", publishedCodes: new Map() });
    expect(merged.draft.composition).toEqual(restored.composition);
    expect(merged.draft.instruments).toMatchObject(restored.instruments);
    // Notes are about question IDs, which do not change.
    expect(merged.draft.notes["ybm_studio.favourite_colour"]).toEqual({ codingNotes: "Free text; code later." });
    // Retired values stay retired.
    expect(merged.draft.retiredCodes["scale.kept_for_ever"]).toEqual([{ code: 7, label: "Old answer", retiredAt: AT }]);
  });

  it("drops unlocks: going back to a published version needs a fresh acknowledgement to change protected content", () => {
    const merged = mergeRestore(draftOf("7.0.1"), current(), { at: AT, by: "u_pub", publishedCodes: new Map() });
    expect(merged.draft.unlocked).toEqual({});
  });

  it("archives every question the version does not have, rather than lose it — published or not", () => {
    const restored = draftOf("7.0.1");
    const now = current();
    const merged = mergeRestore(restored, now, { at: AT, by: "u_pub", publishedCodes: new Map() });
    const missing = [...keys(now)].filter((k) => !keys(restored).has(k));
    expect(missing).toContain("ybm_studio.favourite_colour");
    expect(merged.archived.sort()).toEqual(missing.sort());
    const record = merged.draft.archived.find((a) => a.itemKey === "ybm_studio.favourite_colour")!;
    expect(record).toMatchObject({ archivedAt: AT, archivedBy: "u_pub", sectionKey: now.composition.sections[1]!.key });
    // r7.0.1 has no Studio module, so the record carries the (empty) module to restore into.
    expect(record.instrumentShell?.instrument).toBe("ybm_studio");
    expect(record.instrumentShell?.forms[0]?.items).toEqual([]);
    // Nothing archived is also live.
    const live = new Set(liveQuestions(merged.draft).map((q) => q.itemKey));
    expect(merged.draft.archived.filter((a) => live.has(a.itemKey))).toEqual([]);
  });

  it("brings nothing back as both live and archived", () => {
    const restored = draftOf("7.1.0");
    const target = liveQuestions(restored).find((q) => editTier(restored, q.instrument) === "editable")!.itemKey;
    const now = archiveQuestion(restored, target, { by: "u_ed", at: AT }).draft;
    expect(now.archived.map((a) => a.itemKey)).toContain(target);
    const merged = mergeRestore(restored, now, { at: AT, by: "u_pub", publishedCodes: new Map() });
    expect(merged.draft.archived.map((a) => a.itemKey)).not.toContain(target);
  });

  it("retires every published option value the restored lists lack, and only those", () => {
    const restored = draftOf("7.1.0");
    const [scaleKey, scale] = Object.entries(restored.scales)[0]!;
    const published = new Map<string, Map<number, string>>([
      [scaleKey, new Map([...scale.options.map((o) => [o.code, o.label] as [number, string]), [99, "An answer r8 added"]])],
      ["scale.only_in_r8", new Map([[1, "Yes"], [2, "No"]])],
    ]);
    const merged = mergeRestore(restored, current(), { at: AT, by: "u_pub", publishedCodes: published });
    expect(merged.draft.retiredCodes[scaleKey]).toEqual([{ code: 99, label: "An answer r8 added", retiredAt: AT }]);
    expect(merged.draft.retiredCodes["scale.only_in_r8"]?.map((r) => r.code)).toEqual([1, 2]);
    expect(merged.retired).toBe(3);
  });

  it("restores the version as it is when the current draft cannot be read — that is how a broken draft is mended", () => {
    const restored = draftOf("7.0.1");
    const merged = mergeRestore(restored, null, { at: AT, by: "u_pub", publishedCodes: new Map() });
    expect(merged.draft).toEqual({ ...restored, unlocked: {} });
    expect(merged.archived).toEqual([]);
  });

  it("gives a draft the editor accepts, against the live version", () => {
    const merged = mergeRestore(draftOf("7.1.0"), current(), { at: AT, by: "u_pub", publishedCodes: new Map() });
    const errors = validateDraft(merged.draft, { baseline: draftOf("7.1.0") }).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("does not carry an unlock across, so going back over protected wording needs a fresh acknowledgement to publish", () => {
    // r7.1.0 changed the consent introduction. Restoring r7.0.1 puts the old
    // wording back, which is a change to ethics-approved text like any other:
    // the publisher unlocks the module and says why before it can go live.
    const merged = mergeRestore(draftOf("7.0.1"), current(), { at: AT, by: "u_pub", publishedCodes: new Map() });
    const errors = validateDraft(merged.draft, { baseline: draftOf("7.1.0") }).filter((i) => i.severity === "error");
    expect(errors.map((i) => `${i.code} ${i.location.itemKey}`)).toEqual(["protected.question ybm_intro_consent.intro"]);
    const unlocked = unlockModule(merged.draft, "ybm_intro_consent", { by: "u_pub", at: AT, reason: "Rolling back to the r7.0.1 wording, still approved." }).draft;
    expect(validateDraft(unlocked, { baseline: draftOf("7.1.0") }).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("the locks on a survey that has never been published", () => {
  it("are checked against the release it was copied from — its licensed and protected instruments, and nothing else", () => {
    const origin = draftOf("7.1.0");
    const base = lockBaseline(origin, origin);
    expect(base.composition.sections).toEqual([]);
    const instruments = Object.values(base.instruments).map((d) => d.instrument);
    expect(instruments).toContain("ybm_intro_consent");
    expect(instruments).not.toContain("ybm_about_you");
    for (const def of Object.values(base.instruments)) {
      expect(def.licence.modifiable !== "yes" || ["ybm_intro_consent", "ybm_identity"].includes(def.instrument)).toBe(true);
    }
    // Unchanged: nothing to report.
    expect(validateDraft(origin, { baseline: base }).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("refuse a reworded licensed question in a copy", () => {
    const origin = draftOf("7.1.0");
    const copy = structuredClone(origin);
    const locked = Object.values(copy.instruments).find((d) => d.licence.modifiable !== "yes")!;
    const item = locked.forms[0]!.items[0]! as { stem?: { text: string } };
    item.stem = { text: "Something the licence never said" };
    const errors = validateDraft(copy, { baseline: lockBaseline(origin, copy) }).filter((i) => i.severity === "error");
    expect(errors.some((i) => i.code.startsWith("locked."))).toBe(true);
  });

  it("refuse a licensed instrument in a survey started blank, where nothing vouches for it", () => {
    const origin = draftOf("7.1.0");
    const errors = validateDraft(origin, { baseline: lockBaseline(null, origin) }).filter((i) => i.severity === "error");
    expect(errors.some((i) => i.code === "locked.introduced")).toBe(true);
  });
});

describe("what the server refuses beyond Studio validation", () => {
  it("a licensed instrument whose licence the draft now says may be modified", () => {
    const live = draftOf("7.1.0");
    const draft = structuredClone(live);
    const [refKey, locked] = Object.entries(draft.instruments).find(([, d]) => d.licence.modifiable !== "yes")!;
    locked.licence = { ...locked.licence, modifiable: "yes" };
    const issues = licenceEscapes(draft, [live]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "locked.licence_changed", location: { refKey } });
    expect(licenceEscapes(live, [live])).toEqual([]);
  });

  it("a draft that claims to be another survey, or another study's", () => {
    const d = draftOf("7.1.0");
    expect(identityIssues(d, "ybm_nd2026_standard", "ybm")).toEqual([]);
    expect(identityIssues(d, "other_survey", "ybm").map((i) => i.code)).toEqual(["survey.key_mismatch"]);
    expect(identityIssues(d, "ybm_nd2026_standard", "another_study").map((i) => i.code)).toEqual(["survey.study_mismatch"]);
    const renamed = { ...d, composition: { ...d.composition, key: "other_survey" } };
    expect(identityIssues(renamed, "ybm_nd2026_standard", "ybm").map((i) => i.code)).toEqual(["survey.key_mismatch"]);
  });
});

describe("the bump a version number takes", () => {
  it("is read from the number chosen, not the one suggested", () => {
    expect(bumpTaken("7.1.0", "8.0.0", "minor")).toBe("major");
    expect(bumpTaken("7.1.0", "7.2.0", "minor")).toBe("minor");
    expect(bumpTaken("7.1.0", "7.1.1", "patch")).toBe("patch");
    expect(bumpTaken(null, "1.0.0", "major")).toBe("major");
  });
});

describe("a version's authors", () => {
  it("are everyone the trigger recorded, plus whoever saved the revision published, once", () => {
    const saver = { updatedBy: "u_late", updatedByEmail: "late@example.org" };
    expect(authorsOf(["ed@example.org"], saver)).toEqual(["ed@example.org", "late@example.org"]);
    expect(authorsOf(["late@example.org", "ed@example.org"], saver)).toEqual(["late@example.org", "ed@example.org"]);
    expect(authorsOf(undefined, saver)).toEqual(["late@example.org"]);
    // Keyed as the trigger keys a saver with no address.
    expect(authorsOf([], { updatedBy: "u_owner", updatedByEmail: "" })).toEqual(["uid:u_owner"]);
    expect(authorsOf(["ed@example.org", 42], {})).toEqual(["ed@example.org"]);
  });
});
