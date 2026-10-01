/**
 * Response controls. One component per response type, all sharing the same
 * contract: current value in, complete value out via onAnswer. Visual and
 * behavioural consistency across the survey is a design principle — these are
 * the ONLY renderings of each response type.
 *
 * One file per control, named for the component it holds; the props contract
 * they all take, `ControlProps`, is in `shared.ts`. Import from here rather
 * than from the files themselves, so a control can move without its callers
 * noticing.
 */

export { daysInWords, type ControlProps } from "./shared.js";
export { SingleChoice } from "./SingleChoice.js";
export { MultiChoice } from "./MultiChoice.js";
export { SliderControl } from "./SliderControl.js";
export { LadderControl } from "./LadderControl.js";
export { NumericControl } from "./NumericControl.js";
export { DateControl } from "./DateControl.js";
export { TextControl } from "./TextControl.js";
export { FormFieldsControl } from "./FormFieldsControl.js";
export { RankGroupControl } from "./RankGroupControl.js";
export { CheckboxSetControl } from "./CheckboxSetControl.js";
