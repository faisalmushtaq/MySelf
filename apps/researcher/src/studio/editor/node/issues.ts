import type { Issue, IssueLocation } from "@myself/studio";

/**
 * Validation issues, sorted to the field each one is about.
 *
 * Validation locates every issue precisely (docs/16 §5.1): a question and a
 * field, an option code, a section and a field. The editor puts each message
 * beside the input it is about, and a jump from the validation panel focuses
 * that same input — both through the `data-field` names below, which are the
 * validation's own field names, so the two can never drift apart.
 */

/** Where issues with no particular field go: the top of the node's editor. */
export const GENERAL = "_";

export interface FieldIssues {
  /** Field name → its issues, errors first. */
  byField: Map<string, Issue[]>;
  /** Option code → its issues, errors first. */
  byOption: Map<number, Issue[]>;
  /** Issues about the node as a whole. */
  general: Issue[];
  all: Issue[];
}

const bySeverity = (a: Issue, b: Issue) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1);

function group(issues: Issue[], fieldOf: (location: IssueLocation) => string): FieldIssues {
  const byField = new Map<string, Issue[]>();
  const byOption = new Map<number, Issue[]>();
  const general: Issue[] = [];
  const all = [...issues].sort(bySeverity);
  for (const issue of all) {
    const { optionCode } = issue.location;
    if (issue.location.kind === "option" && typeof optionCode === "number") {
      byOption.set(optionCode, [...(byOption.get(optionCode) ?? []), issue]);
      continue;
    }
    const field = fieldOf(issue.location);
    if (field === GENERAL) general.push(issue);
    else byField.set(field, [...(byField.get(field) ?? []), issue]);
  }
  return { byField, byOption, general, all };
}

/**
 * A question field as its input is named: the first part of a dotted field
 * ("fields.game_1" is the form's field list), and an option issue with no
 * code is about the option list as a whole.
 */
export function questionField(location: IssueLocation): string {
  if (location.kind === "option") return "options";
  const field = location.field;
  if (!field) return GENERAL;
  return field.split(".")[0] || GENERAL;
}

/**
 * The issues of one question.
 *
 * Problems with an option list are reported once, at the first question that
 * uses the list (so a list shared by 25 questions is not reported 25 times).
 * `scaleUsers` — every question using this question's list — lets the other 24
 * show those problems too, since editing the list here fixes them there.
 */
export function questionIssues(issues: Issue[], itemKey: string, scaleUsers: readonly string[] = []): FieldIssues {
  const users = new Set(scaleUsers);
  const mine = issues.filter((i) => {
    if (i.location.itemKey === itemKey) return true;
    if (!i.location.itemKey || !users.has(i.location.itemKey)) return false;
    return i.location.kind === "option" || i.location.field === "options";
  });
  return group(mine, questionField);
}

/** The issues of a section: its title, its condition, whether it has anything in it. */
export function sectionIssues(issues: Issue[], sectionKey: string): FieldIssues {
  return group(
    issues.filter((i) => i.location.kind === "section" && i.location.sectionKey === sectionKey),
    (l) => (l.field ? l.field.split(".")[0] || GENERAL : GENERAL),
  );
}

/**
 * The issues of one block. Located by section and instrument reference, which
 * is what validation knows; a block that is placed nowhere (no section) still
 * matches by reference.
 */
export function blockIssues(issues: Issue[], sectionKey: string, refKey: string): FieldIssues {
  return group(
    issues.filter(
      (i) =>
        i.location.kind === "block" &&
        i.location.refKey === refKey &&
        (i.location.sectionKey === undefined || i.location.sectionKey === sectionKey),
    ),
    (l) => (l.field ? l.field.split(".")[0] || GENERAL : GENERAL),
  );
}

/**
 * Start-screen and completion-screen issues keep their whole dotted field
 * ("participantCode.pattern", "screens.finish.body"), which is exactly what
 * those editors name their inputs.
 */
export function screenIssues(issues: Issue[], kind: "welcome" | "completion" | "survey"): FieldIssues {
  return group(
    issues.filter((i) => i.location.kind === kind),
    (l) => l.field ?? GENERAL,
  );
}

const SHARED_FIELDS = [
  "stem",
  "lede",
  "moreInfo",
  "hint",
  "responseType",
  "displayIf",
  "key",
  "variable",
  "reportingCategory",
  "identifying",
  "researcherNote",
  "a11yNote",
];

const FIELDS_BY_TYPE: Record<string, readonly string[]> = {
  info: [],
  single_choice: ["required", "allowDecline", "options", "scale", "presentation", "autoAdvance", "spectrumReverse"],
  multi_choice: ["required", "allowDecline", "options", "scale", "maxSelections"],
  rank_group: ["required", "allowDecline", "options", "scale", "groups"],
  checkbox_set: ["required", "allowDecline", "statements"],
  form_fields: ["required", "allowDecline", "fields"],
  slider: ["required", "allowDecline", "min", "max", "step", "showValue", "minLabel", "maxLabel"],
  ladder: ["required", "allowDecline", "rungs", "lowestValue", "topLabel", "bottomLabel"],
  numeric: ["required", "allowDecline", "min", "max", "integerOnly", "unitLabel"],
  date: ["required", "allowDecline", "minAgeYears", "maxAgeYears"],
  text_short: ["required", "allowDecline", "maxChars", "pattern", "patternHint"],
  text_long: ["required", "allowDecline", "maxChars"],
};

/**
 * The fields the editor shows a box for, for a type of question (in the centre
 * or the settings panel). An issue about any other field — an answer check,
 * an option limit, a year bound the Studio doesn't offer — has nowhere of its
 * own to appear, so it is shown with the question's general messages instead
 * of being lost.
 */
export function fieldsShownFor(responseType: string): ReadonlySet<string> {
  return new Set([...SHARED_FIELDS, ...(FIELDS_BY_TYPE[responseType] ?? [])]);
}

/** Issues about the whole question, plus those about a field that has no box on screen. */
export function unplacedIssues(fields: FieldIssues, shown: ReadonlySet<string>): Issue[] {
  const out = [...fields.general];
  for (const [field, list] of fields.byField) if (!shown.has(field)) out.push(...list);
  return out.sort(bySeverity);
}

/** The issues for one field, trying the whole dotted name and then each shorter prefix. */
export function issuesAt(fields: FieldIssues, field: string): Issue[] {
  const exact = fields.byField.get(field);
  if (exact) return exact;
  // "screens.finish" (the screen is missing) belongs with its body field.
  const out: Issue[] = [];
  for (const [name, list] of fields.byField) if (field.startsWith(`${name}.`)) out.push(...list);
  return out;
}

/** The message a field shows first: its first error, else its first warning. */
export function leadIssue(list: readonly Issue[] | undefined): Issue | null {
  return list && list.length > 0 ? list[0]! : null;
}

/**
 * The CSS selectors to try, in order, to find the input a field names — the
 * field itself, then each shorter prefix of a dotted name, so a jump to
 * "participantCode" lands on the first participant-code input, and an option
 * named "options:3" (or "option.3") lands on that option's row.
 */
export function focusSelectors(field: string): string[] {
  const out: string[] = [];
  const option = /^options?[:.](-?\d+)$/.exec(field);
  if (option) out.push(`[data-option-code="${option[1]}"]`);
  const parts = field.split(".");
  for (let n = parts.length; n >= 1; n--) out.push(`[data-field="${cssString(parts.slice(0, n).join("."))}"]`);
  // "fields.game_1", "statements.agree": a row of a list, then the list.
  if (parts.length > 1) out.splice(1, 0, `[data-field="${cssString(parts[0]!)}"] [data-row-key="${cssString(parts.slice(1).join("."))}"]`);
  return [...new Set(out)];
}

function cssString(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
