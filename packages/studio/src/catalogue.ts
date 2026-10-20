import type { ItemDefinition, TimeGridSource } from "@myself/schema";
import type { ScaleInput } from "./contract.js";
import { generateScaleKey } from "./keys.js";
import { StudioOpError } from "./model.js";

/**
 * The question types a researcher can choose from (docs/16 §4.3).
 *
 * A type is offered only when the participant app renders it, validates it,
 * stores it and reports it. Anything the renderer would silently ignore stays
 * off the menu and is listed in NOT_YET_SUPPORTED with the reason, so the
 * Studio never offers something that looks as if it works and then does not.
 */

export type QuestionTypeId =
  | "short_text"
  | "long_text"
  | "single_choice"
  | "dropdown"
  | "yes_no"
  | "rating"
  | "slider"
  | "multiple_choice"
  | "number"
  | "date"
  | "info"
  | "consent"
  | "ladder"
  | "form_fields"
  | "rank_group"
  | "time_grid";

export interface QuestionType {
  id: QuestionTypeId;
  label: string;
  description: string;
  responseType: ItemDefinition["responseType"];
  /** Offered for new questions. The rest are editable where they already exist. */
  canCreate: boolean;
  group: "text" | "choice" | "number" | "other";
}

export const QUESTION_TYPES: readonly QuestionType[] = [
  {
    id: "short_text",
    label: "Short text",
    description: "A word or a line of text, with an optional length limit and format rule.",
    responseType: "text_short",
    canCreate: true,
    group: "text",
  },
  {
    id: "long_text",
    label: "Long text",
    description: "A paragraph or more of free text.",
    responseType: "text_long",
    canCreate: true,
    group: "text",
  },
  {
    id: "single_choice",
    label: "Single choice",
    description: "Pick one option from a list shown as tappable cards.",
    responseType: "single_choice",
    canCreate: true,
    group: "choice",
  },
  {
    id: "dropdown",
    label: "Dropdown",
    description: "Pick one option from a menu. Use only for lists too long to lay out.",
    responseType: "single_choice",
    canCreate: true,
    group: "choice",
  },
  {
    id: "yes_no",
    label: "Yes / No",
    description: "Two options, Yes (coded 1) and No (coded 2).",
    responseType: "single_choice",
    canCreate: true,
    group: "choice",
  },
  {
    id: "rating",
    label: "Rating scale",
    description: "Five labelled points laid out from left to right.",
    responseType: "single_choice",
    canCreate: true,
    group: "choice",
  },
  {
    id: "slider",
    label: "Slider",
    description: "A number chosen by dragging along a range.",
    responseType: "slider",
    canCreate: true,
    group: "number",
  },
  {
    id: "multiple_choice",
    label: "Multiple choice",
    description: "Tick every option that applies.",
    responseType: "multi_choice",
    canCreate: true,
    group: "choice",
  },
  {
    id: "number",
    label: "Number",
    description: "A number typed in, with optional minimum, maximum and unit.",
    responseType: "numeric",
    canCreate: true,
    group: "number",
  },
  {
    id: "date",
    label: "Date",
    description: "A date, with optional bounds on the year or on the age it implies.",
    responseType: "date",
    canCreate: true,
    group: "other",
  },
  {
    id: "info",
    label: "Information",
    description: "Text for the participant to read. Nothing is answered.",
    responseType: "info",
    canCreate: true,
    group: "other",
  },
  {
    id: "consent",
    label: "Consent statements",
    description: "Statements the participant ticks to show they understand and agree.",
    responseType: "checkbox_set",
    canCreate: true,
    group: "other",
  },
  {
    id: "ladder",
    label: "Ladder",
    description: "A rung chosen on a picture of a ladder (MacArthur-style).",
    responseType: "ladder",
    canCreate: false,
    group: "number",
  },
  {
    id: "form_fields",
    label: "Form fields",
    description: "Several labelled boxes answered together.",
    responseType: "form_fields",
    canCreate: false,
    group: "text",
  },
  {
    id: "rank_group",
    label: "Sort into groups",
    description: "Options dragged into groups, and ranked within them.",
    responseType: "rank_group",
    canCreate: false,
    group: "choice",
  },
  {
    id: "time_grid",
    label: "Time for each chosen option",
    description:
      "Hours and minutes for each option chosen at an earlier sorting or multiple-choice question, on one screen — time on each app someone said they use.",
    responseType: "time_grid",
    canCreate: true,
    group: "number",
  },
];

/**
 * Asked for, and deliberately not offered yet: each needs engine and renderer
 * work before a participant would see what the researcher built.
 */
export const NOT_YET_SUPPORTED: readonly { id: string; label: string; reason: string }[] = [
  {
    id: "matrix",
    label: "Likert grid on one screen",
    reason:
      "The participant app shows one question per screen. Use a Likert set instead: several single-choice " +
      "questions sharing one option list, which participants answer one at a time.",
  },
  {
    id: "file_upload",
    label: "File upload",
    reason: "The participant app cannot take files, and uploads could carry identifying content the data pipeline is not built to handle.",
  },
  {
    id: "media",
    label: "Image, audio or video question",
    reason: "The participant app does not yet show media inside a question, so the question would appear without it.",
  },
  {
    id: "randomised_options",
    label: "Randomised option order",
    reason: "The participant app always shows options in the order listed, so randomisation would be silently ignored.",
  },
  {
    id: "randomised_blocks",
    label: "Randomised block order",
    reason: "The participant app always shows blocks in the order listed, so randomisation would be silently ignored.",
  },
  {
    id: "minimum_answers",
    label: "Minimum selections or minimum characters",
    reason: "The participant app does not enforce a minimum, so the rule would appear to be set but never apply.",
  },
  {
    id: "section_transition",
    label: "Text between sections",
    reason: "The participant app does not show section transition text yet. Add an information question at the start of the section instead.",
  },
];

/** A question type by id; throws if the id is not one. */
export function questionType(id: string): QuestionType {
  const type = QUESTION_TYPES.find((t) => t.id === id);
  if (!type) throw new StudioOpError(`“${id}” is not a question type the Studio knows.`, "invalid");
  return type;
}

/** Types whose answers are codes from an option list. */
export const CHOICE_TYPES: readonly QuestionTypeId[] = ["single_choice", "dropdown", "yes_no", "rating", "multiple_choice"];

/** Types whose options come with the type and are replaced when switching to it. */
export const PRESET_SCALE_TYPES: readonly QuestionTypeId[] = ["yes_no", "rating"];

/** The text a new question of a type starts with, until the researcher writes their own. */
export function defaultTextFor(typeId: QuestionTypeId): string {
  switch (typeId) {
    case "info":
      return "New information text";
    case "consent":
      return "Please read and tick each statement";
    default:
      return "New question";
  }
}

type Option = ScaleInput["options"][number];
const option = (code: number, label: string): Option => ({ code, label, kind: "substantive", textEntry: false });

/** The options each choice type starts with. Codes start at 1 and follow list order. */
function presetOptions(typeId: QuestionTypeId): { name: string; direction: ScaleInput["direction"]; options: Option[] } {
  switch (typeId) {
    case "yes_no":
      // Yes = 1, No = 2: the same coding as the library's scale.yes_no, so a
      // Studio Yes/No question and a library one can be analysed together.
      return { name: "Yes / No", direction: "unordered", options: [option(1, "Yes"), option(2, "No")] };
    case "rating":
      return {
        name: "5-point rating (1 = Not at all, 5 = Very much)",
        direction: "ascending",
        options: [
          option(1, "Not at all"),
          option(2, "A little"),
          option(3, "Somewhat"),
          option(4, "Quite a lot"),
          option(5, "Very much"),
        ],
      };
    default:
      return {
        name: "Options",
        direction: "unordered",
        options: [option(1, "Option 1"), option(2, "Option 2"), option(3, "Option 3")],
      };
  }
}

export interface TemplateOptions {
  key: string;
  variable: string;
  text: string;
  /** The instrument the question will belong to; names its option list. */
  instrument?: string;
  /** Key for a choice question's new option list. Defaults to `scale.<instrument>_<key>`. */
  scaleKey?: string;
  /**
   * Where a new time grid's rows come from. Without one it points at itself,
   * which validation reports as "choose the question", until one is chosen.
   */
  rowsFrom?: TimeGridSource;
}

/**
 * A new question of a type: valid for the schema as it stands, with the
 * type's defaults filled in. Choice types come with their own new option list,
 * which the caller adds to the draft.
 *
 * Every default is written out rather than left to the schema, so the draft
 * holds exactly what will be frozen and the editor shows real values.
 */
export function templateFor(typeId: QuestionTypeId, opts: TemplateOptions): { item: ItemDefinition; scale?: ScaleInput } {
  const type = questionType(typeId);
  if (!type.canCreate) {
    throw new StudioOpError(
      `New “${type.label}” questions can't be created in the Studio. Existing ones can still be edited.`,
      "invalid",
    );
  }
  const base = {
    key: opts.key,
    revision: 1,
    variable: opts.variable,
    stem: { text: opts.text },
    // Information has no answer to require.
    required: typeId === "info" ? ("optional" as const) : ("soft" as const),
    allowDecline: false,
    identifying: false,
  };
  const scaleKey = opts.scaleKey ?? generateScaleKey(opts.instrument ?? "studio", opts.key, new Set());
  const scaleFor = (): ScaleInput => {
    const preset = presetOptions(typeId);
    return { key: scaleKey, version: "1.0.0", name: preset.name, options: preset.options, direction: preset.direction };
  };

  switch (typeId) {
    case "short_text":
      return { item: { ...base, responseType: "text_short", minChars: 0, maxChars: 200 } };
    case "long_text":
      return { item: { ...base, responseType: "text_long", minChars: 0, maxChars: 5000 } };
    case "single_choice":
    case "dropdown":
    case "yes_no":
    case "rating": {
      const presentation = typeId === "dropdown" ? "dropdown" : typeId === "rating" ? "spectrum" : "cards";
      return {
        item: {
          ...base,
          responseType: "single_choice",
          scale: scaleKey,
          scaleVersion: "1.0.0",
          presentation,
          spectrumReverse: false,
          autoAdvance: true,
        },
        scale: scaleFor(),
      };
    }
    case "multiple_choice":
      return {
        item: { ...base, responseType: "multi_choice", scale: scaleKey, scaleVersion: "1.0.0", minSelections: 0 },
        scale: scaleFor(),
      };
    case "slider":
      return { item: { ...base, responseType: "slider", min: 0, max: 10, step: 1, showValue: true } };
    case "number":
      return { item: { ...base, responseType: "numeric", integerOnly: true } };
    case "date":
      return { item: { ...base, responseType: "date" } };
    case "info":
      return { item: { ...base, responseType: "info" } };
    case "consent":
      return {
        item: {
          ...base,
          responseType: "checkbox_set",
          statements: [{ key: "agree", text: { text: "I agree to take part in this study." }, required: true }],
        },
      };
    case "time_grid":
      return {
        item: {
          ...base,
          responseType: "time_grid",
          rowsFrom: opts.rowsFrom ?? { instrument: opts.instrument ?? "studio", item: opts.key, revision: 1 },
        },
      };
    case "ladder":
    case "form_fields":
    case "rank_group":
      // Unreachable: refused above because they cannot be created.
      throw new StudioOpError(`New “${type.label}” questions can't be created in the Studio.`, "invalid");
  }
}
