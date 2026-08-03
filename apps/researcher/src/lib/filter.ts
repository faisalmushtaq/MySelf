import type { WideTable } from "@myself/store";

/**
 * Filtering the table.
 *
 * Every column is filterable, whatever it holds — that is the requirement, and
 * it rules out the usual shortcut of hard-coding filters for the columns
 * someone thought of first. A column's filter is derived from its kind:
 * numbers get a range, categories get a list of the values actually present,
 * free text gets a substring match.
 *
 * Missing values are their own case. A blank is not zero and not the empty
 * string, and a range filter that silently drops blanks would quietly change
 * the denominator of anything a researcher counted off the screen. So a range
 * filter states what it does with them, and the count of what is showing is
 * always visible.
 */

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface RangeFilter {
  kind: "range";
  min?: number;
  max?: number;
  /** Keep rows with no value for this column. Off by default. */
  includeBlank?: boolean;
}

export interface TextFilter {
  kind: "text";
  contains: string;
}

export interface SetFilter {
  kind: "set";
  /** Selected values; a row matches if its value is one of them. */
  values: string[];
}

export type ColumnFilter = RangeFilter | TextFilter | SetFilter;
export type Filters = Record<string, ColumnFilter>;

const asText = (value: Cell): string => (value === null ? "" : String(value));

export function matches(row: Row, key: string, filter: ColumnFilter): boolean {
  const value = row[key] ?? null;
  switch (filter.kind) {
    case "text": {
      const needle = filter.contains.trim().toLowerCase();
      if (needle === "") return true;
      return asText(value).toLowerCase().includes(needle);
    }
    case "set": {
      if (filter.values.length === 0) return true;
      // Blank is selectable like any other value, under an explicit name.
      const label = value === null ? BLANK : String(value);
      return filter.values.includes(label);
    }
    case "range": {
      if (value === null || value === "") return filter.includeBlank === true;
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return filter.includeBlank === true;
      if (filter.min !== undefined && n < filter.min) return false;
      if (filter.max !== undefined && n > filter.max) return false;
      return true;
    }
  }
}

export const BLANK = "(no answer)";

export function applyFilters(rows: Row[], filters: Filters, search = ""): Row[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => {
    for (const [key, filter] of Object.entries(filters)) {
      if (!matches(row, key, filter)) return false;
    }
    if (needle === "") return true;
    // The free-text box searches the whole row, so a participant code or a
    // site can be found without first deciding which column it lives in.
    return Object.values(row).some((v) => asText(v).toLowerCase().includes(needle));
  });
}

/** The values a category column actually takes, most common first. */
export function distinctValues(rows: Row[], key: string): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row[key] ?? null;
    const label = value === null || value === "" ? BLANK : String(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface Sort {
  key: string;
  direction: "asc" | "desc";
}

export function sortRows(rows: Row[], sort: Sort | null): Row[] {
  if (!sort) return rows;
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort.key] ?? null;
    const y = b[sort.key] ?? null;
    // Blanks sort last in both directions: a column sorted descending should
    // start with its largest value, not with everything nobody answered.
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * factor;
    return String(x).localeCompare(String(y)) * factor;
  });
}

/** A CSV of exactly what is on screen — same rows, same columns, same order. */
export function toCsv(columns: { key: string; label: string }[], rows: Row[]): string {
  const escape = (value: Cell): string => {
    if (value === null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((c) => escape(c.key)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c.key] ?? null)).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * Which columns to show first. A release of this size has around 170
 * variables; opening on all of them is a wall of numbers nobody reads. Open on
 * the session columns and the derived scores — the things a monitoring visit
 * is actually about — and let everything else be switched on per column.
 */
export function defaultColumns(table: WideTable): string[] {
  const fixed = [
    "participant_id",
    "wave",
    "site",
    "started",
    "minutes",
    "answered",
    "skipped",
    "too_fast",
    "complete",
  ];
  const scores = table.columns
    .map((c) => c.key)
    .filter((key) => !fixed.includes(key) && /_(lq|raw|total|score|anxiety|depression|band)$/.test(key));
  return [...fixed, ...scores];
}
