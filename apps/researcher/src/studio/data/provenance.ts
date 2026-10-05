import { compareVersions } from "@myself/release/gate";
import type { ActiveVersion, AuditDoc, Bump, StoredTime, VersionDoc } from "@myself/studio";
import { toMillis } from "../format.js";

/**
 * The provenance of a survey's versions, for download as CSV or JSON
 * (docs/16 §10.2): for each version, what it is, who made and published it,
 * what it was based on, what changed and how big a change that was, whether it
 * ran MyStory and which protocol, how many sittings it collected, and when it
 * was live.
 *
 * Nothing new is stored for this. It is read from what the Studio already
 * keeps — the version records, their releases, the audit trail and the
 * sitting counts — so it can be produced for any survey, from the first
 * version the Studio ever published. No participant data: sittings are
 * counts, and the notes and names are the research team's own.
 */

export interface LivePeriod {
  /** ISO time it became live. */
  from: string;
  /** ISO time it stopped being live, or null while it still is. */
  to: string | null;
  /** How it became live. */
  how: "published" | "made live again" | "set up from the live survey";
  /** Who did it (their Studio list address), when the trail says. */
  by: string | null;
}

export interface ProvenanceRow {
  version: string;
  releaseKey: string;
  hash: string;
  engineVersion: string;
  status: "live" | "previous";
  /** "repository" for versions published before the Studio, from the project's releases folder. */
  source: "studio" | "repository";
  /** Everyone who edited the draft it was published from. */
  authors: string[];
  publisher: string | null;
  /** ISO. */
  publishedAt: string | null;
  basedOn: string | null;
  /** The version restored into the draft before it was published, if one was. */
  restoredFrom: string | null;
  releaseNote: string;
  changeSummary: string[];
  /** The smallest bump the changes needed, and the one the version number took. */
  requiredBump: Bump | null;
  chosenBump: Bump | null;
  mystory: { on: boolean; protocol: string | null } | null;
  sittings: { complete: number; partial: number } | null;
  livePeriods: LivePeriod[];
}

export interface ProvenanceInput {
  versions: readonly VersionDoc[];
  live: Pick<ActiveVersion, "version" | "hash"> | null;
  /** The survey's audit trail, in any order. */
  audit: readonly AuditDoc[];
  /** Each version's release by hash (its manifest), when it could be read. */
  releases: ReadonlyMap<string, unknown>;
  /** Sittings by release hash, or null when they could not be counted. */
  sittings: Readonly<Record<string, { complete: number; partial: number }>> | null;
}

const iso = (t: StoredTime | null | undefined): string | null => {
  const ms = toMillis(t);
  return ms === null ? null : new Date(ms).toISOString();
};

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** MyStory as a release has it: on or off, and the protocol's `key@version`. */
export function releaseMyStory(manifest: unknown): { on: boolean; protocol: string | null } | null {
  const sections = (manifest as { composition?: { sections?: unknown } } | null)?.composition?.sections;
  if (!Array.isArray(sections)) return null;
  for (const section of sections) {
    const components = (section as { components?: unknown } | null)?.components;
    for (const c of Array.isArray(components) ? components : []) {
      const n = c as { kind?: unknown; protocol?: unknown; protocolVersion?: unknown };
      if (n?.kind === "narrative") return { on: true, protocol: `${String(n.protocol)}@${String(n.protocolVersion)}` };
    }
  }
  return { on: false, protocol: null };
}

interface TrailEvent {
  at: number;
  action: AuditDoc["action"];
  version: string | null;
  by: string | null;
}

/** The rows of the trail that say something about versions, oldest first. */
function trailOf(audit: readonly AuditDoc[]): TrailEvent[] {
  const out: TrailEvent[] = [];
  for (const row of audit) {
    const at = toMillis(row.at);
    if (at === null) continue;
    const detail = (row.detail ?? {}) as Record<string, unknown>;
    let version: string | null = null;
    if (row.action === "version.published" || row.action === "version.activated" || row.action === "draft.restored") {
      version = text(detail["version"]) ?? text(row.subject);
    } else if (row.action === "survey.imported") {
      // Only the set-up that created the survey pointed devices at a version.
      if (detail["createdSurvey"] !== true) continue;
      version = text(detail["active"]);
    } else continue;
    out.push({ at, action: row.action, version, by: row.actorEmail ?? null });
  }
  return out.sort((a, b) => a.at - b.at);
}

const HOW: Partial<Record<AuditDoc["action"], LivePeriod["how"]>> = {
  "version.published": "published",
  "version.activated": "made live again",
  "survey.imported": "set up from the live survey",
};

/** Every period each version was live, from each publish, each "make live again", and the set-up. */
export function livePeriods(audit: readonly AuditDoc[]): Map<string, LivePeriod[]> {
  const changes = trailOf(audit).filter((e) => HOW[e.action] && e.version);
  const out = new Map<string, LivePeriod[]>();
  changes.forEach((e, i) => {
    const next = changes[i + 1];
    const period: LivePeriod = {
      from: new Date(e.at).toISOString(),
      to: next ? new Date(next.at).toISOString() : null,
      how: HOW[e.action]!,
      by: e.by,
    };
    out.set(e.version!, [...(out.get(e.version!) ?? []), period]);
  });
  return out;
}

/**
 * The version restored into the draft that `version` was published from: the
 * last restore after the publish (or set-up) before it, if there was one.
 */
function restoredBefore(trail: TrailEvent[], version: string): string | null {
  const at = trail.findIndex((e) => e.action === "version.published" && e.version === version);
  if (at < 0) return null;
  for (let i = at - 1; i >= 0; i--) {
    const e = trail[i]!;
    if (e.action === "draft.restored") return e.version;
    if (e.action === "version.published" || e.action === "survey.imported") return null;
  }
  return null;
}

/** One row per version, newest first. */
export function provenanceRows(input: ProvenanceInput): ProvenanceRow[] {
  const trail = trailOf(input.audit);
  const periods = livePeriods(input.audit);
  return [...input.versions]
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((v) => ({
      version: v.version,
      releaseKey: v.releaseKey,
      hash: v.hash,
      engineVersion: v.engineVersion,
      status: input.live?.hash === v.hash ? "live" : "previous",
      source: v.source,
      authors: [...(v.authors ?? [])],
      publisher: v.publishedByEmail ?? (v.source === "repository" ? "repository" : null),
      publishedAt: iso(v.publishedAt) ?? (v.manifestPublishedAt || null),
      basedOn: v.basedOnVersion ?? null,
      restoredFrom: restoredBefore(trail, v.version),
      releaseNote: v.releaseNote ?? "",
      changeSummary: (v.changeSummary?.entries ?? []).map((e) => e.message),
      requiredBump: v.changeSummary?.bump ?? null,
      chosenBump: v.bump ?? null,
      mystory: input.releases.has(v.hash) ? releaseMyStory(input.releases.get(v.hash)) : null,
      sittings: input.sittings ? (input.sittings[v.hash] ?? { complete: 0, partial: 0 }) : null,
      livePeriods: periods.get(v.version) ?? [],
    }));
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const PROVENANCE_COLUMNS = [
  "version",
  "release_key",
  "hash",
  "engine_version",
  "status",
  "source",
  "authors",
  "publisher",
  "published_at",
  "based_on",
  "restored_from",
  "release_note",
  "change_summary",
  "required_bump",
  "chosen_bump",
  "mystory",
  "mystory_protocol",
  "sittings_complete",
  "sittings_partial",
  "live_periods",
] as const;

/**
 * A cell as a spreadsheet will take it.
 *
 * Text starting with = + - @, a tab or a carriage return is what a spreadsheet
 * reads as a formula, so a release note typed as "=HYPERLINK(…)" would run
 * when the file is opened. Such a cell is prefixed with an apostrophe: shown,
 * not run. Then quoted as RFC 4180 says, when it has to be.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function periodWords(p: LivePeriod): string {
  return `${p.from} to ${p.to ?? "now"} (${p.how})`;
}

/** The rows as CSV: UTF-8 with a byte-order mark, so spreadsheets read accents right, and CRLF lines. */
export function provenanceCsv(rows: readonly ProvenanceRow[]): string {
  const lines = [PROVENANCE_COLUMNS.join(",")];
  for (const r of rows) {
    const cells: (string | number | null)[] = [
      r.version,
      r.releaseKey,
      r.hash,
      r.engineVersion,
      r.status,
      r.source,
      r.authors.join("; "),
      r.publisher,
      r.publishedAt,
      r.basedOn,
      r.restoredFrom,
      r.releaseNote,
      r.changeSummary.join(" | "),
      r.requiredBump,
      r.chosenBump,
      r.mystory ? (r.mystory.on ? "on" : "off") : null,
      r.mystory?.protocol ?? null,
      r.sittings?.complete ?? null,
      r.sittings?.partial ?? null,
      r.livePeriods.map(periodWords).join("; "),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export interface ProvenanceDocument {
  format: "myself-studio-provenance";
  formatVersion: 1;
  study: string;
  surveyId: string;
  title: string | null;
  exportedAt: string;
  live: { version: string; hash: string } | null;
  /** What the live periods can and cannot say. */
  notes: string[];
  versions: ProvenanceRow[];
}

export function provenanceDocument(
  rows: ProvenanceRow[],
  meta: { study: string; surveyId: string; title: string | null; live: Pick<ActiveVersion, "version" | "hash"> | null; exportedAt: Date },
): ProvenanceDocument {
  return {
    format: "myself-studio-provenance",
    formatVersion: 1,
    study: meta.study,
    surveyId: meta.surveyId,
    title: meta.title,
    exportedAt: meta.exportedAt.toISOString(),
    live: meta.live ? { version: meta.live.version, hash: meta.live.hash } : null,
    notes: [
      "Live periods come from the Studio's audit trail: each publish, each “make live again”, and the set-up from the live survey. A version published before the Studio existed was live before the trail began, so those earlier periods are not listed.",
      "Sittings are counts of sittings recorded under each version's hash; no participant data is included.",
    ],
    versions: rows,
  };
}

export function provenanceFilename(surveyId: string, at: Date, ext: "csv" | "json"): string {
  return `${surveyId}-provenance-${at.toISOString().slice(0, 10)}.${ext}`;
}
