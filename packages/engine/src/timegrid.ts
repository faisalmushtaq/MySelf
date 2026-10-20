import type { ItemDefinition, LogicExpr, TimeGridSource } from "@myself/schema";
import type { AnswerValue } from "./answers.js";

/**
 * The time grid: hours and minutes for each option a participant chose at an
 * earlier question, on one screen.
 *
 * Everything that decides which rows there are, whether the grid is shown at
 * all, what a row's entry means and what is stored lives here, once. The
 * device, ingest and the completeness rules all read it, so "which apps was
 * this person asked about" has one answer wherever it is asked.
 */

/** A whole day: the ceiling on one row when the item sets none. */
export const TIME_GRID_DEFAULT_MAX_MINUTES = 24 * 60;

/** The parts of a scale option the rows are made from. */
export interface GridOption {
  code: number;
  label: string;
  kind?: string | undefined;
  position?: number | undefined;
}

/** The parts of the source question the rows depend on. */
export interface GridSourceItem {
  responseType: string;
  groups?: readonly { key: string }[] | undefined;
}

export interface TimeGridRow {
  code: number;
  label: string;
}

/**
 * Option kinds that can be a row. "Prefer not to say", "Don't know" and
 * "None of these" are answers about the question, not things with a duration.
 */
const ROW_KINDS = new Set(["substantive", "other_specify"]);

/** Options in the order the source question showed them. */
function ordered(options: readonly GridOption[]): GridOption[] {
  return options
    .map((o, i) => ({ o, at: o.position ?? i + 1, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(({ o }) => o);
}

/** Source types a grid can take its rows from. */
export const TIME_GRID_SOURCE_TYPES: readonly string[] = ["rank_group", "multi_choice"];

/** The options that could become rows, whatever the participant chooses. */
export function timeGridCandidates(options: readonly GridOption[]): GridOption[] {
  return ordered(options).filter((o) => ROW_KINDS.has(o.kind ?? "substantive"));
}

/**
 * The rows for this answer to the source question, in the source's order.
 * Empty when the source was not answered, or nothing qualifying was chosen.
 */
export function timeGridRows(
  from: TimeGridSource,
  source: GridSourceItem,
  options: readonly GridOption[],
  answer: AnswerValue | undefined,
): TimeGridRow[] {
  if (!answer) return [];
  const chosen = (code: number): boolean => {
    if (source.responseType === "rank_group" && answer.kind === "group_rank") {
      return from.group !== undefined && answer.assignments[code]?.group === from.group;
    }
    if (source.responseType === "multi_choice" && answer.kind === "multi") return answer.codes.includes(code);
    return false;
  };
  return timeGridCandidates(options)
    .filter((o) => chosen(o.code))
    .map((o) => ({ code: o.code, label: o.label }));
}

/**
 * "This grid has at least one row", as a display condition over the source
 * answer. Conjoined onto the grid's own condition when the walk is built, so a
 * grid with nothing to ask about is hidden by branching exactly as any other
 * question is — and a grid whose source question was itself hidden goes with it.
 *
 * Written in the ordinary logic vocabulary, so every reader that evaluates
 * conditions (the walker, ingest, the completeness rules) needs nothing new.
 */
export function timeGridCondition(
  from: TimeGridSource,
  source: GridSourceItem,
  options: readonly GridOption[],
): LogicExpr {
  const target = { item: { instrument: from.instrument, item: from.item, revision: from.revision } };
  const args: LogicExpr[] = timeGridCandidates(options).map((o) =>
    source.responseType === "rank_group"
      ? { op: "in_group", target, group: from.group ?? "", code: o.code }
      : { op: "selected", target, code: o.code },
  );
  const usable =
    (source.responseType === "rank_group" && from.group !== undefined) || source.responseType === "multi_choice";
  if (args.length > 0 && usable) return args.length === 1 ? args[0]! : { op: "any", args };
  // Nothing could ever be a row: never shown. "Answered and not answered".
  return { op: "all", args: [{ op: "answered", target }, { op: "not", arg: { op: "answered", target } }] };
}

/** The variable one row is stored under: `app_minutes_3` for option 3. */
export const timeGridVariable = (variable: string, code: number): string => `${variable}_${code}`;

/** The item's own ceiling, or a whole day. */
export const timeGridMax = (item: { maxMinutesPerRow?: number | undefined }): number =>
  item.maxMinutesPerRow ?? TIME_GRID_DEFAULT_MAX_MINUTES;

/** "1 h 25 min", "45 min", "3 h", "0 min" — how a total is read back. */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export interface TimeEntry {
  /** Total minutes, or null when both boxes are empty. */
  minutes: number | null;
  /** What is wrong with the entry, in words a participant can act on. */
  error?: string;
}

const WHOLE = /^\d+$/;

/**
 * One row's two boxes, read. Both empty is no answer for the row; one empty is
 * zero of that unit, since "2" hours and nothing in minutes means two hours.
 */
export function readTimeEntry(hours: string, minutes: string, maxMinutes: number): TimeEntry {
  const h = hours.trim();
  const m = minutes.trim();
  if (h === "" && m === "") return { minutes: null };
  if ((h !== "" && !WHOLE.test(h)) || (m !== "" && !WHOLE.test(m))) {
    return { minutes: null, error: "Please use whole numbers" };
  }
  const hn = h === "" ? 0 : Number(h);
  const mn = m === "" ? 0 : Number(m);
  if (hn > 24) return { minutes: null, error: "Hours must be between 0 and 24" };
  if (mn > 59) return { minutes: null, error: "Minutes must be between 0 and 59" };
  const total = hn * 60 + mn;
  if (total > maxMinutes) return { minutes: null, error: `Please enter no more than ${formatMinutes(maxMinutes)} in total` };
  return { minutes: total };
}

/** A stored total back in the two boxes. */
export function splitMinutes(total: number | null | undefined): { hours: string; minutes: string } {
  if (total === null || total === undefined) return { hours: "", minutes: "" };
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

export interface TimeGridCheck {
  /** Every value is a whole number of minutes within the row's ceiling, for a row that was shown. */
  ok: boolean;
  /** Every shown row has a value. What a hard-required grid needs. */
  complete: boolean;
  /** No shown row has a value. */
  empty: boolean;
  reason?: string;
}

/** A recorded grid answer judged against the rows the participant was shown. */
export function checkTimeGrid(
  item: { maxMinutesPerRow?: number | undefined },
  rows: readonly { code: number }[],
  value: unknown,
): TimeGridCheck {
  const fail = (reason: string): TimeGridCheck => ({ ok: false, complete: false, empty: false, reason });
  const v = value as { kind?: unknown; minutes?: unknown } | null | undefined;
  if (!v || v.kind !== "time_grid" || typeof v.minutes !== "object" || v.minutes === null) {
    return fail("expected minutes for each row");
  }
  const minutes = v.minutes as Record<string, unknown>;
  const max = timeGridMax(item);
  const shown = new Set(rows.map((r) => String(r.code)));
  for (const [code, n] of Object.entries(minutes)) {
    if (!shown.has(code)) return fail(`row ${code} was not shown`);
    if (n === null) continue;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return fail(`row ${code} is not a whole number of minutes`);
    if (n > max) return fail(`row ${code} is more than ${max} minutes`);
  }
  const filled = rows.filter((r) => typeof minutes[String(r.code)] === "number").length;
  return { ok: true, complete: rows.length > 0 && filled === rows.length, empty: filled === 0 };
}

/**
 * The stored variables for one grid answer: `${variable}_${code}` -> total
 * minutes, for every row shown. A shown row left empty is null.
 */
export function timeGridValues(
  variable: string,
  rows: readonly { code: number }[],
  value: AnswerValue | undefined,
): Record<string, number | null> {
  const minutes = value?.kind === "time_grid" ? value.minutes : {};
  const out: Record<string, number | null> = {};
  for (const r of rows) {
    const n = minutes[String(r.code)];
    out[timeGridVariable(variable, r.code)] = typeof n === "number" ? n : null;
  }
  return out;
}

/** The parts of a time-grid item this module reads. */
export type TimeGridItem = Extract<ItemDefinition, { responseType: "time_grid" }>;
