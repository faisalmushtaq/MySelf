import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Issue, IssueLocation, StudioDraft } from "./contract.js";
import { emptyDraft, extractDraft, previewRelease } from "./draft.js";
import { manifestIndex, publishedScaleCodes, reservedFrom } from "./history.js";
import { lockBaseline } from "./locked.js";
import { hasBlockingIssues, issuesFor, summariseIssues, validateDraft, type ValidationContext } from "./validate.js";

// Test-only: drafts are edited here the way a researcher (or a bug) would, which
// is untyped by nature.
type Loose = Record<string, any>;

const releases = resolve(__dirname, "../../../releases");
const read = (file: string): unknown => JSON.parse(readFileSync(resolve(releases, file), "utf8"));
const published = readdirSync(releases)
  .filter((f) => /_r(5|6|7)\.\d+\.\d+\.manifest\.json$/.test(f))
  .map(read);
const r730 = read("ybm_nd2026_standard_r7.3.0.manifest.json");
const live = extractDraft(r730);

/** Everything the publishing function knows about the live survey. */
const fullContext: ValidationContext = {
  baseline: extractDraft(r730),
  reserved: reservedFrom(published.map(manifestIndex)),
  publishedScaleCodes: publishedScaleCodes(published),
};

function edit(change: (draft: StudioDraft) => void): StudioDraft {
  const draft = structuredClone(live);
  change(draft);
  return draft;
}

function instrument(draft: StudioDraft, key: string): Loose {
  const def = Object.values(draft.instruments).find((d) => d.instrument === key);
  if (!def) throw new Error(`no instrument ${key}`);
  return def as Loose;
}

function item(draft: StudioDraft, itemKey: string): Loose {
  const [key, name] = itemKey.split(".");
  const found = (instrument(draft, key!).forms[0].items as Loose[]).find((i) => i.key === name);
  if (!found) throw new Error(`no item ${itemKey}`);
  return found;
}

function section(draft: StudioDraft, key: string): Loose {
  const found = draft.composition.sections.find((s) => s.key === key);
  if (!found) throw new Error(`no section ${key}`);
  return found as Loose;
}

const errors = (issues: Issue[]) => issues.filter((i) => i.severity === "error");
const warnings = (issues: Issue[]) => issues.filter((i) => i.severity === "warning");

/** The one issue with this code, located as expected. */
function expectIssue(issues: Issue[], code: string, location: Partial<IssueLocation>, severity: "error" | "warning" = "error"): Issue {
  const found = issues.filter((i) => i.code === code && i.severity === severity);
  expect(found.map((i) => i.code), `expected ${code} among ${issues.map((i) => i.code).join(", ")}`).toContain(code);
  const match = found.find((i) => Object.entries(location).every(([k, v]) => (i.location as Loose)[k] === v));
  expect(match, `no ${code} at ${JSON.stringify(location)}; got ${JSON.stringify(found.map((i) => i.location))}`).toBeDefined();
  // A short line to scan, under a heading that already names the place; any
  // longer advice goes in the hint.
  expect(match!.message.length).toBeGreaterThanOrEqual(10);
  expect(match!.message.length, match!.message).toBeLessThan(80);
  expect(match!.message).not.toMatch(/\.$/);
  if (match!.hint !== undefined) expect(match!.hint.length).toBeGreaterThan(10);
  return match!;
}

describe("the live survey", () => {
  it("has no errors, on its own or against everything already published", () => {
    // If the survey participants are answering today fails validation, the
    // rules are wrong, not the survey.
    expect(errors(validateDraft(live))).toEqual([]);
    const issues = validateDraft(live, fullContext);
    expect(errors(issues)).toEqual([]);
    // Printed so the wording researchers will see can be reviewed.
    console.info(
      warnings(issues)
        .map((w) => `${w.code} @ ${w.location.itemKey ?? w.location.sectionKey ?? w.location.kind}\n  ${w.message}${w.hint ? `\n  (${w.hint})` : ""}`)
        .join("\n"),
    );
    expect(warnings(issues).map((w) => w.code).sort()).toEqual([
      "question.free_text_identifying",
      "question.free_text_identifying",
      "question.identifying_required",
      "question.identifying_required",
      "question.identifying_required",
      "question.slider_labels_missing",
    ]);
  });

  it("validates quickly enough to run on every keystroke", () => {
    validateDraft(live, fullContext); // warm up
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      validateDraft(live, fullContext);
      times.push(performance.now() - start);
    }
    expect(Math.min(...times)).toBeLessThan(100);
  });

  it("a blank survey has no errors", () => {
    expect(errors(validateDraft(emptyDraft({ surveyId: "pilot_2027", study: "ybm", title: "Pilot" })))).toEqual([]);
  });
});

describe("summaries", () => {
  it("count, block and filter", () => {
    const draft = edit((d) => {
      item(d, "kss.q1").stem.text = " ";
    });
    const issues = validateDraft(draft);
    const { errors: e, warnings: w } = summariseIssues(issues);
    expect(e).toBe(errors(issues).length);
    expect(w).toBe(warnings(issues).length);
    expect(hasBlockingIssues(issues)).toBe(true);
    expect(hasBlockingIssues(validateDraft(live))).toBe(false);
    expect(issuesFor(issues, "kss.q1").map((i) => i.code)).toContain("question.text_missing");
  });
});

describe("question errors", () => {
  it("empty question text, for questions and information blocks", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "kss.q1").stem.text = "";
        item(d, "ybm_intro_consent.intro").stem = { text: "  " };
      }),
    );
    const question = expectIssue(issues, "question.text_missing", { kind: "question", itemKey: "kss.q1", sectionKey: "sleep", field: "stem" });
    const info = expectIssue(issues, "question.text_missing", { itemKey: "ybm_intro_consent.intro", field: "stem" });
    // Shown beside the empty box, under a heading naming the question: short, and never the ID again.
    expect(question.message).toBe("Add the question text");
    expect(info.message).toBe("Add the text participants read");
    expect(question.hint).toMatch(/delete/);
  });

  it("says each thing in a short line, with the advice in the hint", () => {
    // The place is the heading the message sits under, so the message never names it.
    for (const issue of validateDraft(live, fullContext)) {
      expect(issue.message).not.toContain(issue.location.itemKey ?? "\u0000");
      expect(issue.message.length).toBeLessThan(60);
      expect(issue.hint?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("an ID that is not a valid key", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_gaming.hours_week").key = "Hours Week";
      }),
    );
    expectIssue(issues, "question.key_invalid", { itemKey: "ybm_gaming.Hours Week", field: "key" });
  });

  it("two questions with one ID in one module", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_gaming.game_time_2").key = "game_time_1";
      }),
    );
    expectIssue(issues, "question.key_duplicate", { itemKey: "ybm_gaming.game_time_1" });
  });

  it("a question administered twice", () => {
    const issues = validateDraft(
      edit((d) => {
        section(d, "right_now").components.push({ ...section(d, "gaming").components[0], items: ["hours_week"] });
      }),
    );
    expectIssue(issues, "question.administered_twice", { itemKey: "ybm_gaming.hours_week", sectionKey: "right_now" });
    // …and the gate's refusal is reported too, not swallowed.
    expectIssue(issues, "gate.administered_twice", { itemKey: "ybm_gaming.hours_week" });
  });

  it("a subset listing a question twice", () => {
    const issues = validateDraft(
      edit((d) => {
        section(d, "gaming").components[0].items = ["hours_week", "hours_week", "top_games", "game_time_1", "game_time_2", "game_time_3", "game_time_4", "game_time_5", "social_pct"];
      }),
    );
    expectIssue(issues, "question.administered_twice", { kind: "block", itemKey: "ybm_gaming.hours_week", sectionKey: "gaming" });
  });

  it("an invalid reporting label, and one used twice", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_gaming.hours_week").variable = "Gaming Hours";
        item(d, "ybm_gaming.social_pct").variable = "sm_use";
      }),
    );
    expectIssue(issues, "question.variable_invalid", { itemKey: "ybm_gaming.hours_week", field: "variable" });
    expectIssue(issues, "question.variable_duplicate", { itemKey: "ybm_gaming.social_pct", field: "variable" });
    // A schema failure stops the gate before it runs; on its own, the
    // duplicate is refused by the gate as well, at the same question.
    const duplicate = validateDraft(edit((d) => (item(d, "ybm_gaming.social_pct").variable = "sm_use")));
    expectIssue(duplicate, "gate.variable_duplicate", { itemKey: "ybm_gaming.social_pct", field: "variable" });
  });

  it("an unsupported answer type", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_future_self.message").responseType = "video_upload";
      }),
    );
    expectIssue(issues, "question.type_unsupported", { itemKey: "ybm_future_self.message", field: "responseType" });
  });

  it("a question defined but not placed in any section", () => {
    const issues = validateDraft(
      edit((d) => {
        section(d, "gaming").components[0].items = ["hours_week", "top_games", "game_time_1", "game_time_2", "game_time_3", "game_time_4", "game_time_5"];
      }),
    );
    expectIssue(issues, "question.unplaced", { itemKey: "ybm_gaming.social_pct" });
  });
});

describe("IDs and labels already published", () => {
  const reserved = { itemKeys: new Set(["ybm_gaming.old_question"]), variables: new Set(["gaming_old"]) };

  function withNewQuestion(key: string, variable: string): StudioDraft {
    return edit((d) => {
      const items = instrument(d, "ybm_gaming").forms[0].items as Loose[];
      items.push({ ...structuredClone(items[0]), key, variable, displayIf: undefined });
    });
  }

  it("refuses an ID an earlier version used for a different question", () => {
    const issues = validateDraft(withNewQuestion("old_question", "gaming_new"), { reserved, baseline: live });
    expectIssue(issues, "question.key_reserved", { itemKey: "ybm_gaming.old_question", field: "key" });
  });

  it("refuses a reporting label an earlier version used", () => {
    const issues = validateDraft(withNewQuestion("new_question", "gaming_old"), { reserved, baseline: live });
    expectIssue(issues, "question.variable_reserved", { itemKey: "ybm_gaming.new_question", field: "variable" });
  });

  it("accepts a question restored from an earlier version with its ID and label unchanged", () => {
    const paired = reservedFrom([{ itemKeys: ["ybm_gaming.old_question"], variables: ["gaming_old"] }]);
    const issues = validateDraft(withNewQuestion("old_question", "gaming_old"), { reserved: paired, baseline: live });
    expect(issues.filter((i) => i.code.startsWith("question.key_") || i.code.startsWith("question.variable_"))).toEqual([]);
  });

  it("refuses changing the reporting label of a published question", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_gaming.hours_week").variable = "gaming_hours";
      }),
      fullContext,
    );
    expectIssue(issues, "question.variable_locked", { itemKey: "ybm_gaming.hours_week", field: "variable" });
  });
});

describe("answer option errors", () => {
  it("fewer than two options", () => {
    const issues = validateDraft(
      edit((d) => {
        d.scales["scale.gaming_hours_6pt"]!.options = d.scales["scale.gaming_hours_6pt"]!.options.slice(0, 1);
      }),
    );
    expectIssue(issues, "options.too_few", { itemKey: "ybm_gaming.hours_week", field: "options" });
  });

  it("an option without a label", () => {
    const issues = validateDraft(
      edit((d) => {
        d.scales["scale.gaming_hours_6pt"]!.options[2]!.label = "";
      }),
    );
    expectIssue(issues, "options.label_missing", { kind: "option", itemKey: "ybm_gaming.hours_week", optionCode: 3 });
  });

  it("two options with one value", () => {
    const issues = validateDraft(
      edit((d) => {
        d.scales["scale.gaming_hours_6pt"]!.options[2]!.code = 2;
      }),
    );
    expectIssue(issues, "options.duplicate_value", { kind: "option", itemKey: "ybm_gaming.hours_week", optionCode: 2 });
  });

  it("a retired value reused for a different answer", () => {
    const draft = edit((d) => {
      d.scales["scale.gaming_hours_6pt"]!.options.push({ code: 7, label: "More than 30 hours" });
      d.retiredCodes["scale.gaming_hours_6pt"] = [{ code: 7, label: "Every waking hour", retiredAt: "2026-09-01T00:00:00Z" }];
    });
    expectIssue(validateDraft(draft), "options.code_retired", { kind: "option", itemKey: "ybm_gaming.hours_week", optionCode: 7 });
    // The same answer coming back under its own value is not a reuse.
    draft.retiredCodes["scale.gaming_hours_6pt"]![0]!.label = "More than 30 hours";
    expect(validateDraft(draft).filter((i) => i.code === "options.code_retired")).toEqual([]);
  });

  it("answer options that cannot be found", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_gaming.hours_week").scale = "scale.nowhere";
      }),
    );
    expectIssue(issues, "question.scale_missing", { itemKey: "ybm_gaming.hours_week", field: "scale" });
    expectIssue(issues, "gate.scale_unresolved", { itemKey: "ybm_gaming.hours_week" });
  });
});

describe("limits that no answer could satisfy", () => {
  const cases: [string, string, (i: Loose) => void, string, string][] = [
    ["slider range", "ybm_gaming.social_pct", (i) => (i.min = 100), "limits.slider_range", "min"],
    ["slider step", "ybm_gaming.social_pct", (i) => (i.step = 500), "limits.slider_step", "step"],
    ["number range", "ybm_social_media.abstain_days", (i) => (i.min = 5000), "limits.numeric_range", "min"],
    ["text length", "ybm_future_self.message", (i) => (i.maxChars = 0), "limits.max_chars", "maxChars"],
    ["choices allowed", "ybm_social_media.functions", (i) => (i.maxSelections = 12), "limits.max_selections", "maxSelections"],
    ["ladder rungs", "macarthur_ssy.family", (i) => (i.rungs = 1), "limits.ladder_rungs", "rungs"],
    ["age range", "ybm_identity.dob", (i) => (i.minAgeYears = 110), "limits.age_range", "minAgeYears"],
    ["age ceiling", "ybm_identity.dob", (i) => (i.maxAgeYears = 150), "limits.age_range", "maxAgeYears"],
    ["no form fields", "ybm_gaming.top_games", (i) => (i.fields = []), "limits.fields_missing", "fields"],
    ["too few groups", "ybm_social_media.apps_owned", (i) => (i.groups = i.groups.slice(0, 1)), "limits.groups_too_few", "groups"],
    ["no statements", "ybm_intro_consent.consent", (i) => (i.statements = []), "limits.statements_missing", "statements"],
    ["text pattern", "ybm_identity.ps_house_digit", (i) => (i.pattern = "^[0-9$"), "question.pattern_invalid", "pattern"],
    ["field pattern", "ybm_gaming.top_games", (i) => (i.fields[0].pattern = "(unclosed"), "question.pattern_invalid", "fields.game_1"],
  ];
  for (const [name, itemKey, change, code, field] of cases) {
    it(name, () => {
      const issues = validateDraft(edit((d) => change(item(d, itemKey))));
      expectIssue(issues, code, { kind: "question", itemKey, field });
    });
  }
});

describe("conditions", () => {
  const onOwn = (code: number) => ({ op: "selected", target: { item: { instrument: "ybm_smartphone", item: "own", revision: 1 } }, code });

  it("on a question that does not exist", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_smartphone.age_smartphone").displayIf = {
          op: "selected",
          target: { item: { instrument: "ybm_smartphone", item: "owns_tablet", revision: 1 } },
          code: 1,
        };
      }),
    );
    expectIssue(issues, "logic.target_missing", { itemKey: "ybm_smartphone.age_smartphone", field: "displayIf" });
    expectIssue(issues, "gate.dependency_missing", { itemKey: "ybm_smartphone.age_smartphone" });
  });

  it("on a question asked later", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "kss.q1").displayIf = onOwn(1);
      }),
    );
    expectIssue(issues, "logic.target_later", { itemKey: "kss.q1", field: "displayIf" });
    expectIssue(issues, "gate.dependency_later", { itemKey: "kss.q1" });
  });

  it("on its own answer", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_smartphone.own").displayIf = onOwn(1);
      }),
    );
    expectIssue(issues, "logic.target_later", { itemKey: "ybm_smartphone.own", field: "displayIf" });
  });

  it("on an option the question does not have", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_smartphone.age_smartphone").displayIf = onOwn(3);
      }),
    );
    expectIssue(issues, "logic.option_missing", { itemKey: "ybm_smartphone.age_smartphone", field: "displayIf" });
  });

  it("with a check that can never be true of the question it tests", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_gaming.social_pct").displayIf = {
          op: "selected",
          target: { item: { instrument: "ybm_gaming", item: "top_games", revision: 1 } },
          code: 1,
        };
      }),
    );
    expectIssue(issues, "logic.operator_incompatible", { itemKey: "ybm_gaming.social_pct", field: "displayIf" });
  });

  it("on a section, bound where the section starts", () => {
    const issues = validateDraft(
      edit((d) => {
        // ybm_social_media.overuse is the section's own first question.
        section(d, "social_media").displayIf = {
          op: "selected",
          target: { item: { instrument: "ybm_social_media", item: "overuse", revision: 1 } },
          code: 1,
        };
      }),
    );
    expectIssue(issues, "logic.target_later", { kind: "section", sectionKey: "social_media", field: "displayIf" });
  });

  it("on a block, bound at its first question", () => {
    const issues = validateDraft(
      edit((d) => {
        section(d, "social_media").components[1].displayIf = {
          op: "selected",
          target: { item: { instrument: "ybm_screen_attitudes", item: "control", revision: 1 } },
          code: 1,
        };
      }),
    );
    expectIssue(issues, "logic.target_later", { kind: "block", sectionKey: "social_media", refKey: "ybm_screen_attitudes@1.0/en-GB/self/standard", field: "displayIf" });
  });

  it("a consistency check against a later question, and an option limit from a question that is not a date", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_identity.ps_birth_month").crossChecks[0].against = { instrument: "ybm_gaming", item: "hours_week", revision: 1 };
        item(d, "ybm_smartphone.age_sm").limitOptions.from = { instrument: "ybm_smartphone", item: "own", revision: 1 };
      }),
    );
    expectIssue(issues, "logic.target_later", { itemKey: "ybm_identity.ps_birth_month", field: "crossChecks" });
    expectIssue(issues, "logic.operator_incompatible", { itemKey: "ybm_smartphone.age_sm", field: "limitOptions" });
  });
});

describe("sections", () => {
  it("with no questions", () => {
    const issues = validateDraft(
      edit((d) => {
        d.composition.sections.push({ key: "extra", title: "Extra", components: [] });
      }),
    );
    expectIssue(issues, "section.empty", { kind: "section", sectionKey: "extra" });
    // A "screen" component shows participants nothing (neither the freeze nor
    // the participant app renders one), so it does not make a section non-empty.
    const screenOnly = validateDraft(
      edit((d) => {
        d.composition.sections.push({ key: "extra", title: "Extra", components: [{ kind: "screen", screen: "finish" }] });
      }),
    );
    expectIssue(screenOnly, "section.empty", { kind: "section", sectionKey: "extra" });
  });

  it("with the same ID", () => {
    const issues = validateDraft(
      edit((d) => {
        section(d, "gaming").key = "phones";
      }),
    );
    expectIssue(issues, "section.key_duplicate", { kind: "section", sectionKey: "phones", field: "key" });
    expectIssue(issues, "gate.section_keys_duplicate", { kind: "survey" });
  });
});

describe("inserted answers", () => {
  it("a placeholder nothing fills, and an insertion whose placeholder is gone", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "kss.q1").stem.text = "Hi {first_name}, how sleepy are you?";
        item(d, "ybm_gaming.game_time_1").stem.text = "How many hours do you play it?";
      }),
    );
    expectIssue(issues, "pipe.unresolved", { itemKey: "kss.q1", field: "stem" });
    expectIssue(issues, "gate.placeholder_unresolved", { itemKey: "kss.q1" });
    expectIssue(issues, "pipe.unused", { itemKey: "ybm_gaming.game_time_1", field: "stem" });
  });

  it("in a consent statement and on the finishing screen", () => {
    const issues = validateDraft(
      edit((d) => {
        const statement = item(d, "ybm_intro_consent.consent").statements[2];
        statement.text.pipes = {};
        d.composition.screens["finish"]!.body = { text: "Bye {nickname}" };
      }),
    );
    expectIssue(issues, "pipe.unresolved", { itemKey: "ybm_intro_consent.consent", field: "statements" });
    expectIssue(issues, "pipe.unresolved", { kind: "completion", field: "screens.finish.body" });
  });
});

describe("start and finishing screens", () => {
  it("no participant code", () => {
    const issues = validateDraft(edit((d) => delete d.composition.participantCode));
    expectIssue(issues, "welcome.code_missing", { kind: "welcome", field: "participantCode" });
  });

  it("a code format that is not a pattern, and an empty label and hint", () => {
    const issues = validateDraft(
      edit((d) => {
        d.composition.participantCode = { ...d.composition.participantCode!, pattern: "^[A-Z{3}$", label: "", hint: " " };
      }),
    );
    expectIssue(issues, "welcome.code_pattern_invalid", { kind: "welcome", field: "participantCode.pattern" });
    expectIssue(issues, "welcome.code_label_missing", { kind: "welcome", field: "participantCode.label" });
    expectIssue(issues, "welcome.code_hint_missing", { kind: "welcome", field: "participantCode.hint" });
  });

  it("no finishing screen, or one with nothing to say", () => {
    expectIssue(
      validateDraft(edit((d) => delete d.composition.screens["finish"])),
      "completion.finish_missing",
      { kind: "completion", field: "screens.finish" },
    );
    expectIssue(
      validateDraft(edit((d) => (d.composition.screens["finish"]!.body = { text: "" }))),
      "completion.body_missing",
      { kind: "completion", field: "screens.finish.body" },
    );
  });
});

describe("licensed, protected and identifying content", () => {
  it("rewording a validated instrument's question", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "sdq25_s.q3").stem.text = "I get a lot of headaches or stomach aches";
      }),
      { baseline: live },
    );
    expectIssue(issues, "locked.question", { kind: "question", itemKey: "sdq25_s.q3", sectionKey: "wellbeing" });
  });

  it("but not making it optional, adding help or changing its layout", () => {
    const issues = validateDraft(
      edit((d) => {
        const q = item(d, "sdq25_s.q3");
        q.required = "optional";
        q.hint = "Think about the last six months.";
        q.presentation = "compact";
      }),
      { baseline: live },
    );
    expect(errors(issues)).toEqual([]);
  });

  it("relabelling a validated instrument's options", () => {
    const issues = validateDraft(
      edit((d) => {
        d.scales["scale.sdq_3pt"]!.options[2]!.label = "Clearly True";
      }),
      { baseline: live },
    );
    expectIssue(issues, "locked.scale", { itemKey: "sdq25_s.q1" });
  });

  it("splitting or reordering a validated instrument", () => {
    const issues = validateDraft(
      edit((d) => {
        section(d, "sleep").components[0].items = ["q1"];
        section(d, "hands_and_ladders").components[1].items = ["self", "family"];
      }),
    );
    expectIssue(issues, "locked.order_changed", { kind: "block", sectionKey: "hands_and_ladders", field: "items" });
  });

  it("rewording a validated instrument after declaring the draft's copy modifiable", () => {
    // Review fix: the draft's own licence used to decide whether it was locked.
    const issues = validateDraft(
      edit((d) => {
        instrument(d, "sdq25_s").licence.modifiable = "yes";
        item(d, "sdq25_s.q3").stem.text = "I get headaches";
      }),
      { baseline: live },
    );
    expectIssue(issues, "locked.question", { kind: "question", itemKey: "sdq25_s.q3" });
    expectIssue(issues, "locked.definition", { kind: "block", refKey: "sdq25_s@1.0/en-GB/self/standard" });
  });

  it("splitting a validated instrument across sections", () => {
    const split = (d: StudioDraft) => {
      const sdq = section(d, "wellbeing").components[1];
      const keys = (instrument(d, "sdq25_s").forms[0].items as Loose[]).map((i) => i.key as string);
      sdq.items = keys.slice(0, 10);
      section(d, "sleep").components.push({ ...structuredClone(sdq), items: keys.slice(10) });
    };
    expectIssue(validateDraft(edit(split)), "locked.split", { kind: "block", sectionKey: "wellbeing", field: "items" });
    // Re-licensing the draft's copy does not get round it once there is a published version.
    const relicensed = edit((d) => {
      split(d);
      instrument(d, "sdq25_s").licence.modifiable = "yes";
    });
    expectIssue(validateDraft(relicensed, { baseline: live }), "locked.split", { kind: "block", field: "items" });
  });

  it("a questionnaire in a survey never published is never refused for its licence", () => {
    const locked = Object.fromEntries(Object.entries(live.instruments).filter(([, def]) => def.licence.modifiable !== "yes"));
    const library: ValidationContext = { reference: locked, referenceScales: live.scales, referenceScoring: live.scoring };
    expect(errors(validateDraft(live, library))).toEqual([]);
    const reworded = edit((d) => (item(d, "sdq25_s.q3").stem.text = "I get headaches"));
    expect(errors(validateDraft(reworded, library)).filter((i) => i.code.startsWith("locked."))).toEqual([]);
    const relabelled = edit((d) => (d.scales["scale.sdq_3pt"]!.options[2]!.label = "Clearly True"));
    expect(errors(validateDraft(relabelled, library)).filter((i) => i.code.startsWith("locked."))).toEqual([]);
  });

  it("changing the consent wording needs no unlock (D-61), but taking the consent out can't be published", () => {
    const reworded = edit((d) => {
      item(d, "ybm_intro_consent.consent").statements[5].text.text = "I agree to take part";
    });
    expect(errors(validateDraft(reworded, { baseline: live }))).toEqual([]);
    const removed = edit((d) => {
      for (const [refKey, def] of Object.entries(d.instruments)) if (def.instrument === "ybm_intro_consent") delete d.instruments[refKey];
    });
    expectIssue(validateDraft(removed, { baseline: live }), "consent.removed", { kind: "survey" });
  });
});

describe("the consent, whatever the draft started from", () => {
  const withoutConsent = (d: StudioDraft) => {
    for (const [refKey, def] of Object.entries(d.instruments)) if (def.instrument === "ybm_intro_consent") delete d.instruments[refKey];
    d.composition.sections = d.composition.sections.filter((s) => s.key !== "welcome");
  };
  const consentCodes = (issues: Issue[]) => errors(issues).filter((i) => i.code.startsWith("consent."));

  it("is checked in the live survey and found in order", () => {
    expect(consentCodes(validateDraft(live))).toEqual([]);
    expect(consentCodes(validateDraft(live, fullContext))).toEqual([]);
    expect(validateDraft(live).filter((i) => i.code === "consent.none")).toEqual([]);
  });

  it("can't be moved after other questions, even with no baseline to compare with", () => {
    const last = edit((d) => {
      const welcome = d.composition.sections.shift()!;
      d.composition.sections.push(welcome);
    });
    expectIssue(validateDraft(last), "consent.not_first", { kind: "block", sectionKey: "welcome" });
    expectIssue(validateDraft(last, fullContext), "consent.not_first", { kind: "block", sectionKey: "welcome" });
    // Another block put in front of it in its own section is the same thing.
    const before = edit((d) => {
      const identity = section(d, "about_you").components.shift();
      section(d, "welcome").components.unshift(identity);
    });
    expectIssue(validateDraft(before), "consent.not_first", { kind: "block", sectionKey: "welcome" });
  });

  it("must still ask participants to agree", () => {
    const noAgreement = edit((d) => {
      const form = instrument(d, "ybm_intro_consent").forms[0];
      form.items = (form.items as Loose[]).filter((i) => i.responseType !== "checkbox_set");
    });
    expectIssue(validateDraft(noAgreement), "consent.agreement_missing", { kind: "block", sectionKey: "welcome" });
    expectIssue(validateDraft(noAgreement, fullContext), "consent.agreement_missing", { kind: "block", sectionKey: "welcome" });
  });

  it("is kept by the baseline of a copy that has never been published, so the copy can't drop it", () => {
    const copy = edit(withoutConsent);
    const base = lockBaseline(live, copy);
    expect(Object.values(base.instruments).map((d) => d.instrument)).toContain("ybm_intro_consent");
    expectIssue(validateDraft(copy, { baseline: base }), "consent.removed", { kind: "survey" });
    // Unplaced is as good as removed: the participant never sees it.
    const unplaced = edit((d) => (d.composition.sections = d.composition.sections.filter((s) => s.key !== "welcome")));
    expectIssue(validateDraft(unplaced, { baseline: base }), "consent.removed", { kind: "survey" });
    // An unchanged copy is fine.
    expect(consentCodes(validateDraft(live, { baseline: lockBaseline(live, live) }))).toEqual([]);
  });

  it("is only warned about in a survey that never had one", () => {
    const blank = emptyDraft({ surveyId: "s_new", study: "newstudy", title: "A new study" });
    const issues = validateDraft(blank, { baseline: lockBaseline(null, blank) });
    expect(consentCodes(issues)).toEqual([]);
    expectIssue(issues, "consent.none", { kind: "survey" }, "warning");
    const noConsent = edit(withoutConsent);
    expectIssue(validateDraft(noConsent), "consent.none", { kind: "survey" }, "warning");
    expect(consentCodes(validateDraft(noConsent))).toEqual([]);
  });

  it("changing the identity wording without unlocking it", () => {
    const reword = (d: StudioDraft) => {
      item(d, "ybm_identity.first_name").stem.text = "Your given name";
    };
    expectIssue(validateDraft(edit(reword), { baseline: live }), "protected.question", { itemKey: "ybm_identity.first_name" });
    // An unlock entry with nothing in it records no acknowledgement, so it unlocks nothing.
    const hollow = edit((d) => {
      reword(d);
      (d.unlocked as Loose)["ybm_identity"] = null;
    });
    expectIssue(validateDraft(hollow, { baseline: live }), "protected.question", { itemKey: "ybm_identity.first_name" });
    const unlocked = edit((d) => {
      reword(d);
      d.unlocked["ybm_identity"] = { instrument: "ybm_identity", by: "a@b.c", at: "2026-09-28T00:00:00Z", reason: "Wording only; linkage unaffected" };
    });
    expect(errors(validateDraft(unlocked, { baseline: live }))).toEqual([]);
  });

  it("removing a linkage question, even once unlocked", () => {
    const issues = validateDraft(
      edit((d) => {
        const items = instrument(d, "ybm_identity").forms[0].items as Loose[];
        const [removed] = items.splice(
          items.findIndex((i) => i.key === "ps_house_digit"),
          1,
        );
        d.archived.push({ itemKey: "ybm_identity.ps_house_digit", refKey: "x", item: removed as never, sectionKey: "about_you", archivedAt: "", archivedBy: "" });
        d.unlocked["ybm_identity"] = { instrument: "ybm_identity", by: "a@b.c", at: "2026-09-28T00:00:00Z", reason: "tidy" };
      }),
      { baseline: live },
    );
    expectIssue(issues, "linkage.removed", { itemKey: "ybm_identity.ps_house_digit" });
  });

  it("changing a linkage question's type or reporting label", () => {
    const issues = validateDraft(
      edit((d) => {
        d.unlocked["ybm_identity"] = { instrument: "ybm_identity", by: "a@b.c", at: "2026-09-28T00:00:00Z", reason: "tidy" };
        Object.assign(item(d, "ybm_identity.ps_postcode_letters"), { responseType: "text_long" });
        item(d, "ybm_identity.ps_mother_initials").variable = "ps_mum";
      }),
      { baseline: live },
    );
    expectIssue(issues, "linkage.type_changed", { itemKey: "ybm_identity.ps_postcode_letters", field: "responseType" });
    expectIssue(issues, "linkage.variable_changed", { itemKey: "ybm_identity.ps_mother_initials", field: "variable" });
  });

  it("recoding the birth-month options, once unlocked, warns that participant codes will change", () => {
    // Ingest builds the code from the option *code*, so this breaks linkage as
    // surely as a change to the question — docs/16 R5: any other change warns.
    const issues = validateDraft(
      edit((d) => {
        d.unlocked["ybm_identity"] = { instrument: "ybm_identity", by: "a@b.c", at: "2026-09-28T00:00:00Z", reason: "tidy" };
        const scale = item(d, "ybm_identity.ps_birth_month").scale as string;
        for (const option of d.scales[scale]!.options) option.code += 100;
      }),
      { baseline: live },
    );
    expectIssue(issues, "linkage.changed", { itemKey: "ybm_identity.ps_birth_month" }, "warning");
  });

  it("a name or date of birth not marked identifying", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_identity.first_name").identifying = false;
      }),
    );
    expectIssue(issues, "identity.not_identifying", { itemKey: "ybm_identity.first_name", field: "identifying" });
  });
});

describe("the publish gate and the schema", () => {
  it("reports every gate refusal, located", () => {
    const draft = edit((d) => {
      delete d.scoring["score.sdq25_s"];
    });
    const issues = validateDraft(draft);
    const gate = issues.filter((i) => i.code.startsWith("gate."));
    expect(gate).toHaveLength(previewRelease(draft).failures.length);
    expectIssue(issues, "gate.scoring_missing", { kind: "block", refKey: "sdq25_s@1.0/en-GB/self/standard" });
  });

  it("says plainly when scoring rules name a question the questionnaire doesn't have", () => {
    // r7.1.0's SWEMWBS scoring, fixed in r7.2.0 (D-49), scores questions the form never had.
    const old = extractDraft(read("ybm_nd2026_standard_r7.1.0.manifest.json"));
    const issues = validateDraft(
      edit((d) => {
        d.scoring["score.swemwbs"] = structuredClone(old.scoring["score.swemwbs"]!);
      }),
    );
    expectIssue(issues, "gate.scoring_reference", { kind: "block", refKey: "swemwbs@1.0/en-GB/self/standard" });
    expect(issues.some((i) => i.code === "gate.scoring_missing")).toBe(false);
  });

  it("locates what the schema rejects", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "kss.q1").revision = 0;
      }),
    );
    expectIssue(issues, "schema.invalid", { kind: "question", itemKey: "kss.q1", field: "revision" });
  });
});

describe("warnings", () => {
  it("unlabelled sliders and ladders, long questions, must-answer information blocks", () => {
    const issues = validateDraft(
      edit((d) => {
        delete item(d, "macarthur_ssy.self").topLabel;
        item(d, "kss.q1").stem.text = "Sleepy? ".repeat(80);
        item(d, "ybm_intro_consent.why_it_matters").required = "hard";
      }),
    );
    expectIssue(issues, "question.slider_labels_missing", { itemKey: "ybm_gaming.social_pct" }, "warning");
    expectIssue(issues, "question.ladder_labels_missing", { itemKey: "macarthur_ssy.self", field: "topLabel" }, "warning");
    expectIssue(issues, "question.stem_long", { itemKey: "kss.q1" }, "warning");
    expectIssue(issues, "question.info_required", { itemKey: "ybm_intro_consent.why_it_matters" }, "warning");
  });

  it("free text that may identify, and a question that depends on an optional one", () => {
    const issues = validateDraft(
      edit((d) => {
        item(d, "ybm_smartphone.own").required = "optional";
      }),
    );
    expectIssue(issues, "question.free_text_identifying", { itemKey: "ybm_future_self.message" }, "warning");
    expectIssue(issues, "logic.depends_on_optional", { itemKey: "ybm_smartphone.age_smartphone" }, "warning");
  });

  it("two sections with one title", () => {
    const issues = validateDraft(edit((d) => (section(d, "gaming").title = "Sleep")));
    expectIssue(issues, "section.title_duplicate", { sectionKey: "gaming" }, "warning");
  });

  it("options added, relabelled or removed on a scale participants have answered", () => {
    const issues = validateDraft(
      edit((d) => {
        const options = d.scales["scale.gaming_hours_6pt"]!.options;
        options[1]!.label = "Under 5 hours";
        options.pop();
        options.push({ code: 7, label: "More than 30 hours" });
      }),
      fullContext,
    );
    expectIssue(issues, "options.relabelled", { kind: "option", itemKey: "ybm_gaming.hours_week", optionCode: 2 }, "warning");
    expectIssue(issues, "options.removed", { kind: "option", itemKey: "ybm_gaming.hours_week", optionCode: 6 }, "warning");
    expectIssue(issues, "options.added", { kind: "option", itemKey: "ybm_gaming.hours_week", optionCode: 7 }, "warning");
  });

  it("a must-answer identifying question", () => {
    expectIssue(validateDraft(live), "question.identifying_required", { itemKey: "ybm_identity.dob" }, "warning");
  });
});

describe("never throws", () => {
  const broken: [string, (d: Loose) => void][] = [
    ["no sections", (d) => (d.composition.sections = null)],
    ["a section that is not an object", (d) => d.composition.sections.push(42)],
    ["a section without components", (d) => delete d.composition.sections[3].components],
    ["a question that is null", (d) => (instrument(d as StudioDraft, "kss").forms[0].items[0] = null)],
    ["an instrument without forms", (d) => delete instrument(d as StudioDraft, "kss").forms],
    ["a scale that is a string", (d) => (d.scales["scale.kss_9pt"] = "nine points")],
    ["a condition that is not a condition", (d) => (item(d as StudioDraft, "ybm_smartphone.age_smartphone").displayIf = { op: "maybe" })],
    ["no screens", (d) => (d.composition.screens = undefined)],
  ];
  for (const [name, breakIt] of broken) {
    it(name, () => {
      const draft = edit((d) => breakIt(d as unknown as Loose));
      let issues: Issue[] = [];
      expect(() => (issues = validateDraft(draft, fullContext))).not.toThrow();
      expect(hasBlockingIssues(issues)).toBe(true);
    });
  }

  it("not even on something that is not a draft", () => {
    expect(validateDraft({} as StudioDraft)[0]?.code).toBe("draft.malformed");
    expect(validateDraft(null as unknown as StudioDraft)[0]?.code).toBe("draft.malformed");
  });
});

describe("r8.0.0: age conditions, the home address and linkage by name (D-51, D-52)", () => {
  const r8 = extractDraft(read("ybm_nd2026_standard_r8.0.0.manifest.json"));

  it("opens the live survey with no errors — its age-judged SDQ blocks included", () => {
    expect(errors(validateDraft(r8, { baseline: r8 }))).toEqual([]);
  });

  it("links sittings on first name, last name and date of birth, so their labels are held", () => {
    const draft = structuredClone(r8);
    item(draft, "ybm_identity.dob").variable = "birth_date";
    const issue = expectIssue(validateDraft(draft, { baseline: r8 }), "linkage.variable_changed", { itemKey: "ybm_identity.dob" });
    expect(issue.hint).toMatch(/first name, last name and date of birth/);
  });

  it("still links on the four-part code in a survey that asks for it", () => {
    const draft = edit((d) => {
      item(d, "ybm_identity.dob").variable = "birth_date";
    });
    // dob is an identity question there, not a linkage one: its own check, not linkage's.
    const codes = validateDraft(draft, { baseline: live }).map((i) => i.code);
    expect(codes).not.toContain("linkage.variable_changed");
  });
});
