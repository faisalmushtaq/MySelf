import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StudioDraft } from "./contract.js";
import { checkChosenVersion, diffDrafts, minimumVersion, nextVersion, suggestBump } from "./diff.js";
import { emptyDraft, extractDraft } from "./draft.js";
import { validateDraft } from "./validate.js";

// Test-only: drafts are edited here as plain JSON, the way the editor edits them.
type Loose = Record<string, any>;

const r730 = JSON.parse(readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json"), "utf8")) as unknown;
const baseline = extractDraft(r730);

function edit(change: (draft: StudioDraft) => void): StudioDraft {
  const draft = structuredClone(baseline);
  change(draft);
  return draft;
}

function items(draft: StudioDraft, instrument: string): Loose[] {
  return (Object.values(draft.instruments).find((d) => d.instrument === instrument) as Loose).forms[0].items;
}

function item(draft: StudioDraft, itemKey: string): Loose {
  const [instrument, key] = itemKey.split(".");
  return items(draft, instrument!).find((i) => i.key === key)!;
}

function section(draft: StudioDraft, key: string): Loose {
  return draft.composition.sections.find((s) => s.key === key) as Loose;
}

describe("diffDrafts", () => {
  it("finds nothing when nothing changed", () => {
    const summary = diffDrafts(baseline, structuredClone(baseline));
    expect(summary).toEqual({ bump: null, entries: [], counts: { added: 0, removed: 0, archived: 0, changed: 0, moved: 0 } });
  });

  it("rewording a question is a MAJOR change of wording, named by its text and ID", () => {
    const summary = diffDrafts(baseline, edit((d) => (item(d, "ybm_smartphone.age_smartphone").stem.text = "How old were you when you got your first phone?")));
    expect(summary.bump).toBe("major");
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({ kind: "question.changed", itemKey: "ybm_smartphone.age_smartphone", aspects: ["wording"], bump: "major", breaking: false });
    expect(summary.entries[0]!.message).toBe("Changed the wording of “How old were you when you got your first phone?” (ybm_smartphone.age_smartphone).");
    expect(summary.counts.changed).toBe(1);
  });

  it("help text is MINOR", () => {
    const summary = diffDrafts(baseline, edit((d) => (item(d, "ehi_sf.writing").hint = "The hand you write with most of the time.")));
    expect(summary.bump).toBe("minor");
    expect(summary.entries[0]).toMatchObject({ aspects: ["help"], bump: "minor" });
  });

  it("researcher notes are PATCH", () => {
    const summary = diffDrafts(baseline, edit((d) => (item(d, "kss.q1").researcherNote = "Asked at the start of the EEG block.")));
    expect(summary.bump).toBe("patch");
    expect(summary.entries[0]).toMatchObject({ aspects: ["notes"], bump: "patch" });
  });

  it("archiving a question is MAJOR", () => {
    const draft = edit((d) => {
      const list = items(d, "ybm_gaming");
      const [removed] = list.splice(list.findIndex((i) => i.key === "social_pct"), 1);
      d.archived.push({ itemKey: "ybm_gaming.social_pct", refKey: "ybm_gaming@1.0/en-GB/self/standard", item: removed as never, sectionKey: "gaming", archivedAt: "", archivedBy: "" });
    });
    const summary = diffDrafts(baseline, draft);
    expect(summary.bump).toBe("major");
    expect(summary.entries).toMatchObject([{ kind: "question.archived", itemKey: "ybm_gaming.social_pct" }]);
    expect(summary.counts.archived).toBe(1);
    // …and restoring it is reported as such.
    expect(diffDrafts(draft, baseline).entries).toMatchObject([{ kind: "question.restored", itemKey: "ybm_gaming.social_pct" }]);
  });

  it("a question removed outright", () => {
    const draft = edit((d) => {
      const list = items(d, "ybm_gaming");
      list.splice(list.findIndex((i) => i.key === "social_pct"), 1);
    });
    expect(diffDrafts(baseline, draft).entries).toMatchObject([{ kind: "question.removed", itemKey: "ybm_gaming.social_pct", bump: "major" }]);
  });

  it("moving a question to another section reports that question only", () => {
    const draft = edit((d) => {
      const gaming = section(d, "gaming").components[0];
      gaming.items = ["hours_week", "top_games", "game_time_1", "game_time_2", "game_time_3", "game_time_4", "game_time_5"];
      section(d, "right_now").components.push({ ...structuredClone(gaming), items: ["social_pct"] });
    });
    // The move itself is a valid survey: the same ID, placed by subset.
    expect(validateDraft(draft, { baseline }).filter((i) => i.severity === "error")).toEqual([]);
    const summary = diffDrafts(baseline, draft);
    expect(summary.entries).toMatchObject([{ kind: "question.moved", itemKey: "ybm_gaming.social_pct", sectionKey: "right_now", bump: "major" }]);
    expect(summary.entries[0]!.message).toMatch(/from the section “Gaming” to “Right now”/);
    expect(summary.counts.moved).toBe(1);
  });

  it("reordering one question reports one question, not every one it passed", () => {
    const draft = edit((d) => {
      const list = items(d, "ybm_social_media");
      list.push(list.shift()!);
    });
    const summary = diffDrafts(baseline, draft);
    expect(summary.entries).toMatchObject([{ kind: "question.reordered", itemKey: "ybm_social_media.overuse" }]);
  });

  it("inserting a question reports the insertion only", () => {
    const draft = edit((d) => {
      const list = items(d, "ybm_gaming");
      list.splice(2, 0, { ...structuredClone(list[0]), key: "platform", variable: "gaming_platform", stem: { text: "Which console do you play on most?" } });
    });
    expect(diffDrafts(baseline, draft).entries).toMatchObject([{ kind: "question.added", itemKey: "ybm_gaming.platform" }]);
  });

  it("changing an option's value is breaking", () => {
    const summary = diffDrafts(baseline, edit((d) => (d.scales["scale.gaming_hours_6pt"]!.options[0]!.code = 0)));
    const entry = summary.entries.find((e) => e.itemKey === "ybm_gaming.hours_week")!;
    expect(entry.aspects).toContain("coding");
    expect(entry.breaking).toBe(true);
  });

  it("relabelling an option changes the options, without breaking the coding", () => {
    const summary = diffDrafts(baseline, edit((d) => (d.scales["scale.gaming_hours_6pt"]!.options[1]!.label = "Under 5 hours")));
    expect(summary.entries[0]).toMatchObject({ aspects: ["options"], bump: "major", breaking: false });
  });

  it("classifies other aspects of a question", () => {
    const summary = diffDrafts(
      baseline,
      edit((d) => {
        Object.assign(item(d, "ybm_future_self.message"), { required: "hard", identifying: true, maxChars: 2000 });
        Object.assign(item(d, "ybm_smartphone.own"), { variable: "phone_own", allowDecline: true });
        item(d, "ybm_smartphone.age_smartphone").displayIf = undefined;
      }),
    );
    const aspects = Object.fromEntries(summary.entries.map((e) => [e.itemKey, e.aspects]));
    expect(aspects["ybm_future_self.message"]).toEqual(["required", "validation", "identifying"]);
    expect(aspects["ybm_smartphone.own"]).toEqual(["coding", "decline"]);
    expect(aspects["ybm_smartphone.age_smartphone"]).toEqual(["logic"]);
    expect(summary.entries.filter((e) => e.breaking).map((e) => e.itemKey).sort()).toEqual(["ybm_future_self.message", "ybm_smartphone.own"]);
  });

  it("sections, the start and finishing screens and settings", () => {
    const summary = diffDrafts(
      baseline,
      edit((d) => {
        section(d, "gaming").title = "Games";
        d.composition.participantCode = { ...d.composition.participantCode!, hint: "Your code from the team" };
        d.composition.screens["finish"]!.body = { text: "All done — thank you!" };
        d.composition.allowBackNavigation = false;
        d.composition.title = "YBM standard battery";
      }),
    );
    expect(summary.entries.map((e) => [e.kind, e.bump])).toEqual([
      ["welcome.changed", "minor"],
      ["section.changed", "minor"],
      ["completion.changed", "minor"],
      ["settings.changed", "patch"], // the title is researcher-facing
      ["settings.changed", "minor"], // going back is something participants notice
    ]);
    expect(summary.bump).toBe("minor");
  });

  it("section added, removed, reordered and made conditional", () => {
    const moved = diffDrafts(
      baseline,
      edit((d) => {
        const sections = d.composition.sections;
        const [sleep] = sections.splice(3, 1);
        sections.splice(5, 0, sleep!);
      }),
    );
    expect(moved.entries).toMatchObject([{ kind: "section.reordered", sectionKey: "sleep", bump: "major" }]);

    const conditional = diffDrafts(
      baseline,
      edit((d) => (section(d, "gaming").displayIf = { op: "answered", target: { item: { instrument: "ybm_smartphone", item: "own", revision: 1 } } })),
    );
    expect(conditional.entries).toMatchObject([{ kind: "section.changed", aspects: ["logic"], bump: "major" }]);
  });

  it("a first version lists everything as added", () => {
    const draft = emptyDraft({ surveyId: "pilot_2027", study: "ybm", title: "Pilot" });
    const summary = diffDrafts(null, draft);
    expect(summary.bump).toBe("major");
    expect(summary.entries.map((e) => e.kind)).toEqual(["section.added", "question.added"]);
  });

  it("never throws", () => {
    const summary = diffDrafts(baseline, { ...baseline, composition: null } as unknown as StudioDraft);
    expect(summary.bump).toBe("major");
  });
});

describe("version numbers", () => {
  it("suggest the largest bump any change needs", () => {
    expect(suggestBump({ entries: [] })).toBeNull();
    expect(
      suggestBump({
        entries: [
          { kind: "settings.changed", bump: "patch", breaking: false, message: "" },
          { kind: "section.changed", bump: "minor", breaking: false, message: "" },
        ],
      }),
    ).toBe("minor");
  });

  it("count on from the latest version", () => {
    expect(nextVersion("7.1.0", "major")).toBe("8.0.0");
    expect(nextVersion("7.1.0", "minor")).toBe("7.2.0");
    expect(nextVersion("7.1.0", "patch")).toBe("7.1.1");
    expect(nextVersion(null, "patch")).toBe("1.0.0");
    expect(minimumVersion("7.1.0", "minor")).toBe("7.2.0");
    expect(() => nextVersion("seven", "major")).toThrow(RangeError);
  });

  it("allow a larger bump than needed, never a smaller one or a reused number", () => {
    expect(checkChosenVersion("7.1.0", "8.0.0", "major")).toEqual({ ok: true });
    expect(checkChosenVersion("7.1.0", "9.0.0", "minor")).toEqual({ ok: true });
    expect(checkChosenVersion("7.1.0", "7.2.0", "major")).toEqual({ ok: false, reason: "bump_too_small", minimum: "8.0.0" });
    expect(checkChosenVersion("7.1.0", "7.1.5", "minor")).toEqual({ ok: false, reason: "bump_too_small", minimum: "7.2.0" });
    expect(checkChosenVersion("7.1.0", "7.1.0", "patch")).toEqual({ ok: false, reason: "not_greater", minimum: "7.1.1" });
    expect(checkChosenVersion("7.1.0", "7.0.9", null)).toEqual({ ok: false, reason: "not_greater", minimum: "7.1.1" });
    expect(checkChosenVersion("7.1.0", "8.0", "major")).toEqual({ ok: false, reason: "not_semver", minimum: "8.0.0" });
    expect(checkChosenVersion("7.1.0", "v8.0.0", "major")).toEqual({ ok: false, reason: "not_semver", minimum: "8.0.0" });
    expect(checkChosenVersion(null, "1.0.0", "major")).toEqual({ ok: true });
    expect(checkChosenVersion(null, "0.9.0", "major")).toEqual({ ok: false, reason: "bump_too_small", minimum: "1.0.0" });
  });
});
