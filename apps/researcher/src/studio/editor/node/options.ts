import {
  editTier,
  findQuestion,
  identityRoleOf,
  instrumentDef,
  instrumentName,
  isUnlocked,
  protectedModule,
  scaleUsage,
  shortText,
  splitItemKey,
  type ArchivedQuestion,
  type EditTier,
  type ScaleInput,
  type StudioDraft,
} from "@myself/studio";

/**
 * Option-list helpers for the options editor.
 *
 * `optionsAccess` asks the questions ops.ts asks before any option edit
 * (`optionTarget`), in the same order, so the editor offers exactly the edits
 * the model will carry out: a list that can't change is shown read-only with
 * the reason, never as inputs that fail when typed in. A test holds the two in
 * agreement for every question of the live survey.
 */

export type OptionKind = ScaleInput["options"][number]["kind"];
type ScaleOption = ScaleInput["options"][number];

/** The kinds of option a researcher can choose, in their words. */
export const OPTION_KINDS: readonly { value: NonNullable<OptionKind>; label: string; hint: string }[] = [
  { value: "substantive", label: "Normal", hint: "An ordinary answer." },
  { value: "decline", label: "Prefer not to say", hint: "Recorded as a decline, not as an answer, and left out of scores." },
  { value: "dont_know", label: "Don't know", hint: "Recorded as not knowing, and left out of scores." },
  { value: "not_applicable", label: "Not applicable", hint: "Recorded as not applying to this participant, and left out of scores." },
  {
    value: "other_specify",
    label: "Other (please specify)",
    hint: "Use “Add ‘Other (please specify)’” so the follow-up question that collects the text is added too.",
  },
];

export function kindLabel(kind: OptionKind): string {
  return OPTION_KINDS.find((k) => k.value === (kind ?? "substantive"))?.label ?? "Normal";
}

export type OptionsAccess =
  | { editable: true; scaleKey: string }
  | {
      editable: false;
      /** Why, in the researcher's words. */
      reason: string;
      why: "locked" | "protected" | "linkage" | "shared" | "missing";
      /** Giving the question its own copy of the list would make it editable. */
      canFork: boolean;
      scaleKey: string | null;
    };

/** The tier an archived question would be edited or restored under, as ops.ts decides it. */
export function archivedTierOf(draft: StudioDraft, record: ArchivedQuestion): EditTier {
  const { instrument } = splitItemKey(record.itemKey);
  if (instrumentDef(draft, instrument)) return editTier(draft, instrument);
  const shell = record.instrumentShell ?? draft.archived.find((a) => a.refKey === record.refKey && a.instrumentShell)?.instrumentShell;
  if (shell && shell.licence.modifiable !== "yes") return "locked";
  return protectedModule(instrument) && !isUnlocked(draft, instrument) ? "protected" : "editable";
}

/** Whether a question's options can be edited from it, and if not, why. */
export function optionsAccess(draft: StudioDraft, itemKey: string): OptionsAccess {
  const q = findQuestion(draft, itemKey);
  if (!q || !("scale" in q.item)) {
    return { editable: false, why: "missing", reason: "This question has no options.", canFork: false, scaleKey: null };
  }
  const scaleKey = q.item.scale;
  const tier = editTier(draft, q.instrument);
  if (tier === "locked") {
    return {
      editable: false,
      why: "locked",
      reason: `Options of “${instrumentName(draft, q.instrument)}” are fixed by its licence and by the evidence it was validated on.`,
      canFork: false,
      scaleKey,
    };
  }
  if (tier === "protected") {
    return {
      editable: false,
      why: "protected",
      reason: `“${instrumentName(draft, q.instrument)}” is protected. Unlock it to change these options.`,
      canFork: false,
      scaleKey,
    };
  }
  if (identityRoleOf(itemKey, q.item) === "linkage") {
    return {
      editable: false,
      why: "linkage",
      reason: "The participant code is built from this answer's values, so its options can never change.",
      canFork: false,
      scaleKey,
    };
  }
  if (!draft.scales[scaleKey]) {
    return { editable: false, why: "missing", reason: `The option list “${scaleKey}” is missing from this survey.`, canFork: false, scaleKey };
  }
  for (const user of scaleUsage(draft, scaleKey)) {
    if (user === itemKey) continue;
    const other = findQuestion(draft, user);
    if (!other) continue;
    const otherTier = editTier(draft, other.instrument);
    if (otherTier !== "editable" || identityRoleOf(user, other.item) === "linkage") {
      return {
        editable: false,
        why: "shared",
        reason: `These options are shared with “${shortText(other.item.stem.text, 50)}” in “${instrumentName(draft, other.instrument)}”, whose options can't change${otherTier === "protected" ? " while it is protected" : ""}.`,
        canFork: true,
        scaleKey,
      };
    }
  }
  for (const record of draft.archived) {
    if (!("scale" in record.item) || record.item.scale !== scaleKey) continue;
    const otherTier = archivedTierOf(draft, record);
    if (otherTier !== "editable" || identityRoleOf(record.itemKey, record.item) === "linkage") {
      return {
        editable: false,
        why: "shared",
        reason: `These options are shared with “${shortText(record.item.stem.text, 50)}” (archived), whose options can't change${otherTier === "protected" ? " while it is protected" : ""}.`,
        canFork: true,
        scaleKey,
      };
    }
  }
  return { editable: true, scaleKey };
}

/** The other questions using the same list — live, then archived. */
export function sharedWith(draft: StudioDraft, itemKey: string): { live: string[]; archived: string[] } {
  const q = findQuestion(draft, itemKey);
  if (!q || !("scale" in q.item)) return { live: [], archived: [] };
  const scaleKey = q.item.scale;
  return {
    live: scaleUsage(draft, scaleKey).filter((k) => k !== itemKey),
    archived: draft.archived.filter((a) => "scale" in a.item && a.item.scale === scaleKey).map((a) => a.itemKey),
  };
}

/**
 * Whether participants may already have answered with this list: any question
 * using it, live or archived, has been published. Removing an option then
 * retires its value, and the editor asks first.
 */
export function listPublished(draft: StudioDraft, itemKey: string, published: ReadonlySet<string>): boolean {
  if (published.has(itemKey)) return true;
  const { live, archived } = sharedWith(draft, itemKey);
  return [...live, ...archived].some((k) => published.has(k));
}

/** What a published value meant, when the option now says something else. */
export function relabelWarning(publishedCodes: ReadonlyMap<number, string> | undefined, option: Pick<ScaleOption, "code" | "label">): string | null {
  const was = publishedCodes?.get(option.code);
  if (was === undefined || was.trim() === option.label.trim()) return null;
  return `Answers already recorded as ${option.code} meant “${was}”. If the meaning has changed, add a new option instead, so old and new answers aren't mixed.`;
}

/** What removing an option does to answers already recorded with it. */
export function removalConsequence(option: Pick<ScaleOption, "code" | "label">, published: boolean, publishedLabel: string | undefined): string {
  if (!published) {
    return `Nobody has answered with this list yet, so “${option.label}” is simply removed. Its value, ${option.code}, stays free.`;
  }
  return (
    `Answers already recorded as ${option.code} meant “${publishedLabel ?? option.label}” and keep that meaning. ` +
    `The value ${option.code} is retired: no option added later can take it, so old answers can never be misread.`
  );
}

/** Why an option can't be removed, or null when it can. */
export function removeBlocked(scale: Pick<ScaleInput, "options">): string | null {
  return scale.options.length <= 2 ? "A choice question needs at least two options. Add another before removing this one." : null;
}

/** A label for a new option that doesn't repeat one already in the list. */
export function newOptionLabel(scale: Pick<ScaleInput, "options">): string {
  const taken = new Set(scale.options.map((o) => o.label.trim().toLowerCase()));
  for (let n = scale.options.length + 1; ; n++) {
    const label = `Option ${n}`;
    if (!taken.has(label.toLowerCase())) return label;
  }
}

/** Where a keyboard move lands, or null at either end of the list. */
export function moveIndex(index: number, delta: -1 | 1, length: number): number | null {
  const to = index + delta;
  return to < 0 || to >= length ? null : to;
}

/**
 * Where a dragged row lands, given the row it is over and whether it is over
 * that row's lower half. Indexes are positions in the list after the dragged
 * row is taken out, which is what `moveOption` expects.
 */
export function dropIndex(from: number, over: number, after: boolean): number {
  const target = after ? over + 1 : over;
  return target > from ? target - 1 : target;
}

/** Whether a question can take an "Other (please specify)" option, and if not, why. */
export function otherBlocked(draft: StudioDraft, itemKey: string): string | null {
  const q = findQuestion(draft, itemKey);
  if (!q) return "This question isn't in the draft.";
  if (q.item.responseType !== "single_choice" && q.item.responseType !== "multi_choice") {
    return "Only single- and multiple-choice questions can have an “Other” option.";
  }
  if (draft.scales[q.item.scale]?.options.some((o) => o.kind === "other_specify")) return "This question already has an “Other” option.";
  const tier = editTier(draft, q.instrument);
  if (tier !== "editable") return tier === "locked" ? "Options of a licensed questionnaire can't change." : "Unlock this module first.";
  if (identityRoleOf(itemKey, q.item) === "linkage") return "The participant code is built from this answer, so its options can't change.";
  return null;
}
