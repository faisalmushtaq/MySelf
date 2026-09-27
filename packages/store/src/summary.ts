import type { Dataset, ScoreRow } from "./dataset.js";

/**
 * Global summary measures for the researcher view.
 *
 * These describe the dataset, not the participants: how many people, how many
 * waves, how complete, how fast. Anything here is recomputed from the rows on
 * every read — nothing is cached, because a stale count on a monitoring screen
 * is worse than a slow one.
 */

export interface NumericSummary {
  n: number;
  missing: number;
  mean: number | null;
  sd: number | null;
  min: number | null;
  median: number | null;
  max: number | null;
}

export function summariseNumbers(values: (number | null | undefined)[]): NumericSummary {
  const present = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const missing = values.length - present.length;
  if (present.length === 0) {
    return { n: 0, missing, mean: null, sd: null, min: null, median: null, max: null };
  }
  const sorted = [...present].sort((a, b) => a - b);
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  // Sample SD (n-1): these are samples of participants, not populations.
  const sd =
    present.length > 1
      ? Math.sqrt(present.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (present.length - 1))
      : null;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
  return {
    n: present.length,
    missing,
    mean,
    sd,
    min: sorted[0]!,
    median,
    max: sorted[sorted.length - 1]!,
  };
}

export interface DatasetSummary {
  participants: number;
  sessions: number;
  completeSessions: number;
  /** Participants with more than one wave — the longitudinal sample. */
  returning: number;
  maxWave: number;
  sites: { site: string; participants: number; sessions: number }[];
  /** Median minutes to complete, and the completion rate. */
  durationMinutes: NumericSummary;
  completionRate: number;
  /** Share of answered items flagged as implausibly fast. */
  tooFastRate: number;
  /** Share of presented items left blank. */
  skipRate: number;
  releaseHashes: string[];
  scores: { key: string; instrument: string; output: string; summary: NumericSummary }[];
}

export function summarise(data: Dataset): DatasetSummary {
  const sessions = data.sessions;
  const complete = sessions.filter((s) => s.complete);
  const answered = sessions.reduce((n, s) => n + s.answeredCount, 0);
  const skipped = sessions.reduce((n, s) => n + s.skippedCount, 0);
  const tooFast = sessions.reduce((n, s) => n + s.tooFastCount, 0);

  const bySite = new Map<string, { participants: Set<string>; sessions: number }>();
  for (const s of sessions) {
    const site = s.site ?? "unknown";
    const entry = bySite.get(site) ?? { participants: new Set<string>(), sessions: 0 };
    entry.participants.add(s.participantId);
    entry.sessions += 1;
    bySite.set(site, entry);
  }

  // Only numeric outputs get a distribution; a band label is a category.
  // A score that could not be computed — too few valid items — is kept in its
  // group with a null value, so `missing` counts it. Dropping those rows here
  // would report every measure as complete however much of it was skipped.
  const byOutput = new Map<string, ScoreRow[]>();
  for (const s of data.scores) {
    if (typeof s.value === "string") continue;
    const key = `${s.instrument}_${s.output}`;
    const list = byOutput.get(key);
    if (list) list.push(s);
    else byOutput.set(key, [s]);
  }
  const numericScores = new Map(
    [...byOutput.entries()].filter(([, rows]) => rows.some((r) => typeof r.value === "number")),
  );

  return {
    participants: data.participants.length,
    sessions: sessions.length,
    completeSessions: complete.length,
    returning: data.participants.filter((p) => p.sessionCount > 1).length,
    maxWave: sessions.reduce((m, s) => Math.max(m, s.wave), 0),
    sites: [...bySite.entries()]
      .map(([site, v]) => ({ site, participants: v.participants.size, sessions: v.sessions }))
      .sort((a, b) => b.sessions - a.sessions),
    durationMinutes: summariseNumbers(
      sessions.map((s) => (s.durationMs === undefined ? null : s.durationMs / 60_000)),
    ),
    completionRate: sessions.length === 0 ? 0 : complete.length / sessions.length,
    tooFastRate: answered === 0 ? 0 : tooFast / answered,
    skipRate: answered + skipped === 0 ? 0 : skipped / (answered + skipped),
    releaseHashes: data.releaseHashes,
    scores: [...numericScores.entries()]
      .map(([key, rows]) => ({
        key,
        instrument: rows[0]!.instrument,
        output: rows[0]!.output,
        summary: summariseNumbers(rows.map((r) => (typeof r.value === "number" ? r.value : null))),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * The wide table the researcher view filters: one row per session, with every
 * variable as a column. Built once and filtered in memory — at study sizes
 * this is thousands of rows, not millions, and an in-memory table filters
 * instantly where a round trip would not.
 */
export interface WideTable {
  columns: { key: string; label: string; kind: "text" | "number" | "category" }[];
  rows: Record<string, string | number | null>[];
}

export function wideTable(data: Dataset): WideTable {
  const rows = new Map<string, Record<string, string | number | null>>();

  for (const s of data.sessions) {
    rows.set(s.sessionId, {
      participant_id: s.participantId,
      session_id: s.sessionId,
      wave: s.wave,
      site: s.site ?? null,
      informant: s.informant ?? null,
      started: s.startedAt.slice(0, 10),
      minutes: s.durationMs === undefined ? null : Math.round(s.durationMs / 6000) / 10,
      // Beside `minutes`, because the two differ exactly when a sitting was interrupted
      // and an analysis screening on time needs to be able to see that rather than
      // silently drop the sittings a school day produces.
      elapsed_minutes: s.wallClockMs === undefined ? null : Math.round(s.wallClockMs / 6000) / 10,
      resumed: s.resumedCount,
      answered: s.answeredCount,
      skipped: s.skippedCount,
      too_fast: s.tooFastCount,
      complete: s.complete ? "yes" : "no",
    });
  }

  const variableKinds = new Map<string, "text" | "number" | "category">();
  for (const r of data.responses) {
    const row = rows.get(r.sessionId);
    if (!row) continue;
    if (r.label !== null) {
      row[r.variable] = r.label;
      variableKinds.set(r.variable, "category");
    } else if (r.value !== null) {
      row[r.variable] = r.value;
      if (!variableKinds.has(r.variable)) variableKinds.set(r.variable, "number");
    } else if (r.text !== null) {
      row[r.variable] = r.text;
      variableKinds.set(r.variable, "text");
    } else {
      row[r.variable] = null;
      if (!variableKinds.has(r.variable)) variableKinds.set(r.variable, "category");
    }
  }

  for (const s of data.scores) {
    const row = rows.get(s.sessionId);
    if (!row) continue;
    const key = `${s.instrument}_${s.output}`;
    row[key] = s.value;
    variableKinds.set(key, typeof s.value === "number" ? "number" : "category");
  }

  const fixed: WideTable["columns"] = [
    { key: "participant_id", label: "Participant", kind: "text" },
    { key: "wave", label: "Wave", kind: "number" },
    { key: "site", label: "Site", kind: "category" },
    { key: "informant", label: "Answered by", kind: "category" },
    { key: "started", label: "Date", kind: "text" },
    { key: "minutes", label: "Minutes on task", kind: "number" },
    { key: "elapsed_minutes", label: "Minutes elapsed", kind: "number" },
    { key: "resumed", label: "Times resumed", kind: "number" },
    { key: "answered", label: "Answered", kind: "number" },
    { key: "skipped", label: "Skipped", kind: "number" },
    { key: "too_fast", label: "Too fast", kind: "number" },
    { key: "complete", label: "Complete", kind: "category" },
  ];
  const variables = [...variableKinds.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, kind]) => ({ key, label: key, kind }));

  return {
    columns: [...fixed, ...variables],
    rows: [...rows.values()].sort((a, b) =>
      `${a["participant_id"]}${String(a["wave"]).padStart(3, "0")}`.localeCompare(
        `${b["participant_id"]}${String(b["wave"]).padStart(3, "0")}`,
      ),
    ),
  };
}
