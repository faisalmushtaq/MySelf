import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StudioDraft } from "./contract.js";
import { extractDraft } from "./draft.js";
import { editTier, isUnlocked, lockedDifferences, lockedFingerprint, lockedTest, protectedDifferences } from "./locked.js";

// Test-only: drafts are edited here as plain JSON, the way the editor edits them.
type Loose = Record<string, any>;

const r710 = JSON.parse(readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json"), "utf8")) as unknown;
const baseline = extractDraft(r710);

function edit(change: (draft: StudioDraft) => void): StudioDraft {
  const draft = structuredClone(baseline);
  change(draft);
  return draft;
}

const SDQ = "sdq25_s@1.0/en-GB/self/standard";
const CONSENT = "ybm_intro_consent@1.0/en-GB/self/standard";
const sdqItems = (d: StudioDraft) => (d.instruments[SDQ] as Loose).forms[0].items as Loose[];

describe("tiers", () => {
  it("lock anything whose licence does not allow modification, and protect consent and identity until unlocked", () => {
    expect(editTier(baseline.instruments[SDQ], {})).toBe("locked");
    expect(editTier(baseline.instruments["bisbas12_ybm@1.0/en-GB/self/standard"], {})).toBe("locked"); // with_permission
    expect(editTier(baseline.instruments[CONSENT], {})).toBe("protected");
    expect(editTier(baseline.instruments[CONSENT], { ybm_intro_consent: { instrument: "ybm_intro_consent", by: "x", at: "y", reason: "z" } })).toBe(
      "editable",
    );
    expect(editTier(baseline.instruments["ybm_gaming@1.0/en-GB/self/standard"], {})).toBe("editable");
  });

  it("count only a real unlock record: one with a reason, for that module", () => {
    const record = { instrument: "ybm_intro_consent", by: "a@b.c", at: "2026-09-28T00:00:00Z", reason: "Amendment 3 approved" };
    expect(isUnlocked({ ybm_intro_consent: record }, "ybm_intro_consent")).toBe(true);
    expect(isUnlocked({ ybm_intro_consent: null as never }, "ybm_intro_consent")).toBe(false);
    expect(isUnlocked({ ybm_intro_consent: { ...record, reason: "  " } }, "ybm_intro_consent")).toBe(false);
    expect(isUnlocked({ ybm_intro_consent: { ...record, instrument: "ybm_identity" } }, "ybm_intro_consent")).toBe(false);
    expect(isUnlocked(undefined, "ybm_intro_consent")).toBe(false);
    // …so a hollow record leaves the module protected.
    expect(editTier(baseline.instruments[CONSENT], { ybm_intro_consent: null as never })).toBe("protected");
  });

  it("take a licence from the published version and the library, not from the draft's copy", () => {
    const relicensed = { ...(structuredClone(baseline.instruments[SDQ]) as Loose), licence: { status: "open", modifiable: "yes" } };
    // The draft's copy on its own would say "editable"…
    expect(editTier(relicensed, {})).toBe("editable");
    // …but the published version says SDQ is licensed, at this reference or any other.
    expect(lockedTest(baseline)(relicensed, SDQ, {})).toBe(true);
    expect(lockedTest(baseline)(relicensed, "sdq25_s@1.1/en-GB/self/standard", {})).toBe(true);
    // The library says so too, for a survey that has never published it.
    expect(lockedTest(undefined, { [SDQ]: baseline.instruments[SDQ]! })(relicensed, "sdq25_s@9.0/en-GB/self/standard", {})).toBe(true);
    expect(lockedTest(baseline)(baseline.instruments["ybm_gaming@1.0/en-GB/self/standard"], "ybm_gaming@1.0/en-GB/self/standard", {})).toBe(false);
  });
});

describe("lockedFingerprint", () => {
  it("ignores what a locked instrument may change", () => {
    const before = lockedFingerprint(baseline.instruments[SDQ]);
    const after = edit((d) => {
      Object.assign(sdqItems(d)[0]!, { required: "hard", allowDecline: false, hint: "Take your time", presentation: "compact", researcherNote: "n", a11yNote: "a", reportingCategory: "Mood" });
    });
    expect(lockedFingerprint(after.instruments[SDQ])).toBe(before);
  });

  it("changes with anything else", () => {
    const before = lockedFingerprint(baseline.instruments[SDQ]);
    const reworded = edit((d) => (sdqItems(d)[0]!.stem.text = "I try to be nice to people"));
    const recoded = edit((d) => (sdqItems(d)[0]!.variable = "sdq_nice"));
    expect(lockedFingerprint(reworded.instruments[SDQ])).not.toBe(before);
    expect(lockedFingerprint(recoded.instruments[SDQ])).not.toBe(before);
  });

  it("does not mistake a default written out for a change", () => {
    const explicit = edit((d) => {
      for (const item of sdqItems(d)) item.spectrumReverse = false;
    });
    expect(lockedFingerprint(explicit.instruments[SDQ])).toBe(lockedFingerprint(baseline.instruments[SDQ]));
  });
});

describe("lockedDifferences", () => {
  it("finds nothing in an untouched draft", () => {
    expect(lockedDifferences(baseline, baseline)).toEqual([]);
    expect(protectedDifferences(baseline, baseline)).toEqual([]);
  });

  it("names the question that was reworded", () => {
    const draft = edit((d) => (sdqItems(d)[2]!.stem.text = "I get headaches"));
    const [difference, ...rest] = lockedDifferences(draft, baseline);
    expect(rest).toEqual([]);
    expect(difference).toMatchObject({ instrument: "sdq25_s", refKey: SDQ, itemKey: "sdq25_s.q3", change: "question" });
    expect(difference!.message).toMatch(/wording/);
  });

  it("reports removed, added and reordered questions", () => {
    const draft = edit((d) => {
      const items = sdqItems(d);
      items.splice(0, 1);
      items.push({ ...structuredClone(items[0]), key: "q26", variable: "sdq25_q26" });
      [items[0], items[1]] = [items[1]!, items[0]!];
    });
    expect(lockedDifferences(draft, baseline).map((d) => d.change).sort()).toEqual(["order", "question_added", "question_removed"]);
  });

  it("reports changed answer options, which live outside the instrument", () => {
    const draft = edit((d) => (d.scales["scale.sdq_3pt"]!.options[2]!.label = "Clearly True"));
    expect(lockedDifferences(draft, baseline)).toMatchObject([{ change: "scale", itemKey: "sdq25_s.q1" }]);
  });

  it("reports changed scoring rules", () => {
    const draft = edit((d) => ((d.scoring["score.sdq25_s"] as Loose).provenance = "made up"));
    expect(lockedDifferences(draft, baseline)).toMatchObject([{ change: "scoring", refKey: SDQ }]);
  });

  it("refuses a locked instrument the published version did not have, unless it matches the library", () => {
    const withoutSdq = structuredClone(baseline);
    delete withoutSdq.instruments[SDQ];
    expect(lockedDifferences(baseline, withoutSdq)).toMatchObject([{ change: "introduced", refKey: SDQ }]);
    expect(lockedDifferences(baseline, withoutSdq, { reference: { [SDQ]: baseline.instruments[SDQ]! } })).toEqual([]);
    const reworded = edit((d) => (sdqItems(d)[0]!.stem.text = "Changed"));
    expect(lockedDifferences(reworded, withoutSdq, { reference: { [SDQ]: baseline.instruments[SDQ]! } })).toMatchObject([{ change: "introduced" }]);
  });

  it("cannot be switched off by re-licensing the draft's copy", () => {
    // The whole lock used to hinge on the draft's own `licence.modifiable`.
    const relicensed = edit((d) => {
      (d.instruments[SDQ] as Loose).licence.modifiable = "yes";
      sdqItems(d)[2]!.stem.text = "I get headaches";
    });
    expect(lockedDifferences(relicensed, baseline).map((x) => [x.change, x.itemKey])).toEqual([
      ["definition", undefined], // the licence itself
      ["question", "sdq25_s.q3"],
    ]);

    // Nor by a re-licensed, reworded copy at a new version.
    const copied = edit((d) => {
      const def = structuredClone(d.instruments[SDQ]) as Loose;
      delete d.instruments[SDQ];
      Object.assign(def, { version: "1.1", licence: { ...def.licence, modifiable: "yes" } });
      def.forms[0].items[2].stem.text = "I get headaches";
      d.instruments["sdq25_s@1.1/en-GB/self/standard"] = def as never;
    });
    expect(lockedDifferences(copied, baseline)).toMatchObject([{ change: "introduced", refKey: "sdq25_s@1.1/en-GB/self/standard" }]);
  });

  it("holds an instrument added from the library to the library's answer options and scoring too", () => {
    // Published without SDQ, its options or its scoring; the draft adds it.
    const without = structuredClone(baseline);
    delete without.instruments[SDQ];
    delete without.scales["scale.sdq_3pt"];
    delete without.scoring["score.sdq25_s"];
    const library = { reference: { [SDQ]: baseline.instruments[SDQ]! }, referenceScales: baseline.scales, referenceScoring: baseline.scoring };
    expect(lockedDifferences(baseline, without, library)).toEqual([]);

    // The instrument matches the library, but its options were relabelled and its scoring emptied.
    const tampered = edit((d) => {
      d.scales["scale.sdq_3pt"]!.options[2]!.label = "Clearly True";
      (d.scoring["score.sdq25_s"] as Loose).steps = [];
    });
    expect(lockedDifferences(tampered, without, library).map((x) => x.change)).toEqual(["scale", "scoring"]);
    // With no library options to compare with, they can't be vouched for.
    expect(lockedDifferences(baseline, without, { reference: library.reference }).map((x) => x.change)).toEqual(["scale", "scoring"]);
  });
});

describe("protectedDifferences", () => {
  const consentItems = (d: StudioDraft) => (d.instruments[CONSENT] as Loose).forms[0].items as Loose[];

  it("reports consent changes until the module is unlocked", () => {
    const draft = edit((d) => (consentItems(d)[1]!.required = "optional"));
    expect(protectedDifferences(draft, baseline)).toMatchObject([{ change: "question", itemKey: "ybm_intro_consent.consent" }]);
    draft.unlocked["ybm_intro_consent"] = { instrument: "ybm_intro_consent", by: "a@b.c", at: "2026-09-28T00:00:00Z", reason: "Amendment approved" };
    expect(protectedDifferences(draft, baseline)).toEqual([]);
    // An entry with no acknowledgement in it is not an unlock.
    draft.unlocked["ybm_intro_consent"] = { ...draft.unlocked["ybm_intro_consent"], reason: "" };
    expect(protectedDifferences(draft, baseline)).toMatchObject([{ change: "question", itemKey: "ybm_intro_consent.consent" }]);
  });

  it("allows researcher notes without an unlock", () => {
    const draft = edit((d) => Object.assign(consentItems(d)[0]!, { researcherNote: "checked", reportingCategory: "Consent" }));
    expect(protectedDifferences(draft, baseline)).toEqual([]);
  });

  it("needs the unlock for help text too, which participants read", () => {
    // Matches the editing operations, and holds for a draft written without them.
    const draft = edit((d) => Object.assign(consentItems(d)[0]!, { hint: "Read carefully" }));
    expect(protectedDifferences(draft, baseline)).not.toEqual([]);
  });

  it("reports a protected module taken out of the survey", () => {
    const draft = edit((d) => delete d.instruments[CONSENT]);
    expect(protectedDifferences(draft, baseline)).toMatchObject([{ change: "removed", instrument: "ybm_intro_consent" }]);
  });
});
