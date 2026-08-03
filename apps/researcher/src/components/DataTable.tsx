import { useMemo, useState } from "react";
import type { WideTable } from "@myself/store";
import {
  BLANK,
  applyFilters,
  distinctValues,
  sortRows,
  toCsv,
  type ColumnFilter,
  type Filters,
  type Row,
  type Sort,
} from "../lib/filter.js";

/**
 * The table.
 *
 * One row per sitting, one column per variable, and a filter on every column —
 * including the ones added by a future release, because the columns come from
 * the data rather than a list maintained by hand.
 *
 * The row count under the toolbar always shows both numbers ("218 of 1,043"),
 * so a filter can never be left on by accident and mistaken for the whole
 * dataset. That has ruined more analyses than any statistical error.
 */

export interface DataTableProps {
  table: WideTable;
  visible: string[];
  onVisibleChange: (keys: string[]) => void;
  onSelectParticipant: (participantId: string) => void;
}

export function DataTable({ table, visible, onVisibleChange, onSelectParticipant }: DataTableProps) {
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort | null>(null);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [columnSearch, setColumnSearch] = useState("");

  const columns = useMemo(
    () => visible.map((key) => table.columns.find((c) => c.key === key)).filter((c): c is WideTable["columns"][number] => !!c),
    [table, visible],
  );

  const filtered = useMemo(() => sortRows(applyFilters(table.rows, filters, search), sort), [table, filters, search, sort]);

  const setFilter = (key: string, filter: ColumnFilter | null) => {
    setFilters((current) => {
      const next = { ...current };
      if (filter === null) delete next[key];
      else next[key] = filter;
      return next;
    });
  };

  const activeFilters = Object.keys(filters).length;

  return (
    <section className="table-section">
      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search every column…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="secondary" onClick={() => setPicker((v) => !v)}>
          Columns ({columns.length}/{table.columns.length})
        </button>
        <button
          type="button"
          className="secondary"
          disabled={activeFilters === 0 && search === ""}
          onClick={() => {
            setFilters({});
            setSearch("");
          }}
        >
          Clear {activeFilters > 0 ? `${activeFilters} filter${activeFilters === 1 ? "" : "s"}` : "filters"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => downloadCsv(toCsv(columns, filtered), "myself_filtered.csv")}
        >
          Download these rows (CSV)
        </button>
        <span className="count">
          <strong>{filtered.length.toLocaleString()}</strong> of {table.rows.length.toLocaleString()} sittings
        </span>
      </div>

      {picker && (
        <div className="picker">
          <input
            className="search"
            type="search"
            placeholder="Find a column…"
            value={columnSearch}
            onChange={(e) => setColumnSearch(e.target.value)}
          />
          <div className="picker-actions">
            <button type="button" className="link" onClick={() => onVisibleChange(table.columns.map((c) => c.key))}>
              Show all
            </button>
            <button
              type="button"
              className="link"
              onClick={() => onVisibleChange(["participant_id", "wave", "site", "started", "complete"])}
            >
              Minimal
            </button>
          </div>
          <div className="picker-list">
            {table.columns
              .filter((c) => c.key.toLowerCase().includes(columnSearch.trim().toLowerCase()))
              .map((c) => (
                <label key={c.key} className="picker-item">
                  <input
                    type="checkbox"
                    checked={visible.includes(c.key)}
                    onChange={(e) => {
                      if (e.target.checked) onVisibleChange([...visible, c.key]);
                      else onVisibleChange(visible.filter((k) => k !== c.key));
                    }}
                  />
                  <span>{c.label}</span>
                  <span className="dim">{c.kind}</span>
                </label>
              ))}
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              {columns.map((c) => {
                const active = filters[c.key] !== undefined;
                return (
                  <th
                    key={c.key}
                    className={[active ? "filtered" : "", c.kind === "number" ? "n" : ""]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      type="button"
                      className="th-sort"
                      onClick={() =>
                        setSort((s) =>
                          s?.key === c.key
                            ? s.direction === "asc"
                              ? { key: c.key, direction: "desc" }
                              : null
                            : { key: c.key, direction: "asc" },
                        )
                      }
                      title="Sort"
                    >
                      {c.label}
                      {sort?.key === c.key && <span className="arrow">{sort.direction === "asc" ? "▲" : "▼"}</span>}
                    </button>
                    <button
                      type="button"
                      className={`th-filter${active ? " on" : ""}`}
                      onClick={() => setOpenFilter((k) => (k === c.key ? null : c.key))}
                      title="Filter this column"
                      aria-label={`Filter ${c.label}`}
                    >
                      ▾
                    </button>
                    {openFilter === c.key && (
                      <FilterPopover
                        column={c}
                        rows={table.rows}
                        value={filters[c.key]}
                        onChange={(f) => setFilter(c.key, f)}
                        onClose={() => setOpenFilter(null)}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((row, i) => (
              <tr key={String(row["session_id"] ?? i)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.kind === "number" ? "n" : undefined}>
                    {c.key === "participant_id" ? (
                      <button type="button" className="link" onClick={() => onSelectParticipant(String(row[c.key]))}>
                        {String(row[c.key] ?? "")}
                      </button>
                    ) : (
                      formatCell(row[c.key] ?? null)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 500 && (
          <p className="note">
            Showing the first 500 of {filtered.length.toLocaleString()} matching sittings. Filter further, or
            download the CSV for all of them.
          </p>
        )}
        {filtered.length === 0 && <p className="note">No sittings match these filters.</p>}
      </div>
    </section>
  );
}

function formatCell(value: string | number | null): string {
  if (value === null) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return value;
}

interface PopoverProps {
  column: WideTable["columns"][number];
  rows: Row[];
  value: ColumnFilter | undefined;
  onChange: (filter: ColumnFilter | null) => void;
  onClose: () => void;
}

function FilterPopover({ column, rows, value, onChange, onClose }: PopoverProps) {
  const values = useMemo(
    () => (column.kind === "number" ? [] : distinctValues(rows, column.key).slice(0, 60)),
    [rows, column],
  );

  return (
    <div className="popover" role="dialog" aria-label={`Filter ${column.label}`}>
      <div className="popover-head">
        <strong>{column.label}</strong>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>

      {column.kind === "number" ? (
        <div className="range">
          <label>
            <span>From</span>
            <input
              type="number"
              value={value?.kind === "range" && value.min !== undefined ? value.min : ""}
              onChange={(e) => {
                const min = e.target.value === "" ? undefined : Number(e.target.value);
                const next = { kind: "range" as const, ...(value?.kind === "range" ? value : {}), ...(min === undefined ? {} : { min }) };
                if (min === undefined) delete (next as { min?: number }).min;
                onChange(next.min === undefined && next.max === undefined && !next.includeBlank ? null : next);
              }}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="number"
              value={value?.kind === "range" && value.max !== undefined ? value.max : ""}
              onChange={(e) => {
                const max = e.target.value === "" ? undefined : Number(e.target.value);
                const next = { kind: "range" as const, ...(value?.kind === "range" ? value : {}), ...(max === undefined ? {} : { max }) };
                if (max === undefined) delete (next as { max?: number }).max;
                onChange(next.min === undefined && next.max === undefined && !next.includeBlank ? null : next);
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={value?.kind === "range" ? value.includeBlank === true : false}
              onChange={(e) =>
                onChange({ kind: "range", ...(value?.kind === "range" ? value : {}), includeBlank: e.target.checked })
              }
            />
            <span>Keep sittings with no value</span>
          </label>
        </div>
      ) : column.kind === "category" ? (
        <div className="values">
          {values.map((v) => {
            const selected = value?.kind === "set" ? value.values.includes(v.value) : false;
            return (
              <label key={v.value} className="check">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(e) => {
                    const current = value?.kind === "set" ? value.values : [];
                    const next = e.target.checked ? [...current, v.value] : current.filter((x) => x !== v.value);
                    onChange(next.length === 0 ? null : { kind: "set", values: next });
                  }}
                />
                <span>{v.value === BLANK ? <em>{BLANK}</em> : v.value}</span>
                <span className="dim">{v.count}</span>
              </label>
            );
          })}
        </div>
      ) : (
        <input
          className="search"
          type="search"
          autoFocus
          placeholder="Contains…"
          value={value?.kind === "text" ? value.contains : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : { kind: "text", contains: e.target.value })}
        />
      )}

      <button type="button" className="link clear" onClick={() => onChange(null)}>
        Clear this filter
      </button>
    </div>
  );
}

export function downloadCsv(text: string, name: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
