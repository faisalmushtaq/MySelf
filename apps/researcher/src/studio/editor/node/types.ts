import { QUESTION_TYPES, type QuestionTypeId } from "@myself/studio";
import type { IconName } from "../../ui/icons.js";

/** The icon each question type is drawn with, wherever a type is named. */
export const TYPE_ICONS: Record<QuestionTypeId, IconName> = {
  short_text: "type-short",
  long_text: "type-long",
  single_choice: "type-single",
  dropdown: "type-dropdown",
  yes_no: "type-yesno",
  rating: "type-rating",
  slider: "type-slider",
  multiple_choice: "type-multi",
  number: "type-number",
  date: "type-date",
  info: "type-info",
  consent: "type-consent",
  ladder: "type-ladder",
  form_fields: "type-fields",
  rank_group: "type-rank",
  time_grid: "type-time",
};

export function typeLabel(id: QuestionTypeId): string {
  return QUESTION_TYPES.find((t) => t.id === id)?.label ?? id;
}

export function typeDescription(id: QuestionTypeId): string {
  return QUESTION_TYPES.find((t) => t.id === id)?.description ?? "";
}

/** Single-choice layouts, in the researcher's words. "wheel" is listed only for questions that already use it. */
export const PRESENTATIONS = [
  { value: "cards", label: "Cards", description: "One tappable card per option, stacked. The clearest layout for most lists." },
  { value: "compact", label: "Compact", description: "Short options (ages, months) as chips that wrap, so a long list is answered in one look." },
  { value: "grid", label: "Picture grid", description: "Illustrated tiles, for options chosen by how they look. Each option needs a drawing." },
  { value: "spectrum", label: "Spectrum", description: "Options laid out left to right, where the order itself carries the meaning (Always left … Always right)." },
  { value: "dropdown", label: "Dropdown", description: "A menu. It hides the options and costs an extra tap, so use it only for lists too long to lay out." },
  { value: "wheel", label: "Wheel", description: "A scrolling picker, shown like a dropdown. Kept for questions that already use it." },
] as const;
