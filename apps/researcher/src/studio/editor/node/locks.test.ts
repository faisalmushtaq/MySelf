import { describe, expect, it } from "vitest";
import { addQuestion, findQuestion, PROTECTED_MODULES, unlockModule } from "@myself/studio";
import { liveDraft } from "./fixture.js";
import { allowedWords, identifierLock, identityText, lockedBanner, protectedBanner, questionLock, typeLock } from "./locks.js";
import { pipeUses } from "./pipes.js";

const lockOf = (d: ReturnType<typeof liveDraft>, itemKey: string, published: ReadonlySet<string> = new Set()) =>
  questionLock(d, itemKey, findQuestion(d, itemKey)!.item, published);

describe("lock banners", () => {
  const d = liveDraft();

  it("names a licensed questionnaire by its abbreviation and lists what can still change", () => {
    const text = lockedBanner(lockOf(d, "sdq25_s.q7"));
    expect(text.title).toBe("From the SDQ, a licensed questionnaire");
    expect(text.body).toMatch(/You can change: required, ‘Prefer not to say’, help text, presentation, notes and reporting category\.$/);
    expect(allowedWords("protected")).toBe("notes and reporting category");
  });

  it("explains protected modules by their reason", () => {
    expect(protectedBanner(PROTECTED_MODULES["ybm_intro_consent"]!).title).toBe("Part of the ethics-approved consent");
    expect(protectedBanner(PROTECTED_MODULES["ybm_identity"]!).body).toMatch(/safe for participant linkage/);
  });

  it("keeps the participant-code questions fixed even when unlocked", () => {
    const unlocked = unlockModule(d, "ybm_identity", { by: "t", at: "2026-09-28T00:00:00Z", reason: "A wording fix to the hint only." }).draft;
    const lock = lockOf(unlocked, "ybm_identity.ps_house_digit");
    expect(lock.tier).toBe("editable");
    expect(lock.unlocked?.reason).toBe("A wording fix to the hint only.");
    expect(lock.identityRole).toBe("linkage");
    expect(identifierLock(lock, "ID")).toMatch(/never change/);
    expect(typeLock(lock)).toMatch(/never change/);
    expect(identityText("linkage", "ps_house_digit")).toBe("Makes up the participant code — its key, type, options and variable can never change.");
  });

  it("locks a published question's ID and label, but not a new one's", () => {
    const published = new Set(["ybm_smartphone.own"]);
    expect(identifierLock(lockOf(d, "ybm_smartphone.own", published), "reporting label")).toMatch(/^Published/);
    const added = addQuestion(d, { sectionKey: "sleep", typeId: "number", text: "Hours of sleep" });
    const lock = lockOf(added.draft, added.itemKey, published);
    expect(identifierLock(lock, "ID")).toBeNull();
    expect(typeLock(lock)).toBeNull();
  });
});

describe("inserted answers, in words", () => {
  it("describes the finish screen's {first_name} with its fallback", () => {
    const d = liveDraft();
    const uses = pipeUses(d.composition.screens["finish"]!.title, d);
    expect(uses).toEqual([
      { name: "first_name", used: true, defined: true, description: "the answer to “First Name”", fallback: "and well done" },
    ]);
  });

  it("flags a placeholder with nothing set up to fill it", () => {
    const d = liveDraft();
    expect(pipeUses({ text: "Hi {nickname}" }, d)).toEqual([{ name: "nickname", used: true, defined: false, description: null, fallback: null }]);
  });
});
