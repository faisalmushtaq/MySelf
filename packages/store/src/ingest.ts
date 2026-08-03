import type { ReleaseManifest, ResponseScale, ScoringDefinition } from "@myself/schema";
import { executeScoring } from "@myself/scoring";
import type { Dataset, IdentityRow, ResponseRow, ScoreRow, SessionRow } from "./dataset.js";
import { deriveParticipantCode } from "./identity.js";

/**
 * Turning a device's session into rows.
 *
 * The device sends its append-only event log, unedited. This is where it
 * becomes a dataset — and the direction matters: the log is the record, these
 * rows are a projection of it. Re-running ingest on the same log must produce
 * the same rows, because that is what makes a rebuild safe after a scoring fix
 * or a bug in this file.
 */

/** A session as the device hands it over: metadata plus its whole event log. */
export interface DeviceSession {
  sessionId: string;
  /** Researcher-issued code entered at the start of the sitting. */
  studyCode: string;
  releaseKey: string;
  releaseHash: string;
  startedAt: string;
  completedAt?: string;
  complete: boolean;
  events: DeviceEvent[];
}

export interface DeviceEvent {
  seq: number;
  type: string;
  /** "<instrument>.<item>" for item-scoped events. */
  itemKey?: string;
  payload?: Record<string, unknown>;
  tWall: string;
  tMono: number;
}

export interface IngestOptions {
  /** The release these sessions were collected under. */
  manifest: ReleaseManifest;
  /** Study the sessions belong to. */
  study: string;
  /** Sessions already in the dataset, so waves continue rather than restart. */
  existing?: Dataset;
  /**
   * Corrections to derived participant codes: wrong code -> the right one.
   *
   * People mistype their code, most often at a later wave — a different first
   * letter of a mother's name, a house they have moved from. The repair is a
   * mapping applied here, at derivation, and never an edit to the event log:
   * the log records what the participant actually typed, which is the only
   * honest account of the sitting, and the correction is a separate, audited
   * fact about it. Re-deriving with the mapping removed puts everything back.
   */
  aliases?: Record<string, string>;
  /**
   * Per-sitting overrides: session id -> the participant it really belongs to.
   *
   * The case this exists for is twins. The secret code is built from the
   * mother's initials, a house digit, a birth month and postcode letters —
   * every one of which two siblings born on the same day share. Their code is
   * therefore identical, and without an override their answers would merge
   * into one person silently, which is the single worst thing this platform
   * could do. The only thing that tells them apart is their names, which live
   * in the identity partition, so the split is made by a human who can see
   * those and recorded here.
   *
   * An assignment wins over an alias: it is the more specific statement.
   */
  assignments?: Record<string, string>;
}

export interface IngestResult {
  dataset: Dataset;
  /**
   * Names, dates of birth and secret-code components, held apart.
   *
   * Returned rather than folded into the dataset so that storing them is an
   * explicit act by the caller — the identity schema, a separate project, or
   * nowhere at all. Nothing in `dataset` depends on them.
   */
  identity: IdentityRow[];
  /** Sessions that could not be attached to a participant, and why. */
  rejected: { sessionId: string; reason: string }[];
  /**
   * One code, more than one person — almost always twins.
   *
   * Reported rather than resolved: the rows are still here so nothing is lost
   * and a human can look, but any analysis of a dataset with an unresolved
   * collision in it is wrong, and saying so loudly is the only useful
   * behaviour. Resolve by assigning one of them a distinct code.
   */
  collisions: {
    participantId: string;
    names: string[];
    sessions: string[];
  }[];
  warnings: string[];
}

/** Item-level facts assembled from the events of one session. */
interface ItemState {
  instrument: string;
  item: string;
  status: ResponseRow["status"];
  value: unknown;
  dwellMs: number | null;
  visits: number | null;
  tooFast: boolean;
  changed: boolean;
}

const site = (studyCode: string): string | undefined => {
  // The letters a study code opens with are the site; the digits that follow
  // are the cohort. No cap on the letters — a four-letter limit would silently
  // merge two sites whose codes share a prefix.
  const m = /^([A-Za-z]{2,})/.exec(studyCode);
  return m ? m[1]!.toUpperCase() : undefined;
};

/** Flatten the manifest's frozen instruments into item and scale lookups. */
function indexManifest(manifest: ReleaseManifest) {
  const items = new Map<string, { variable: string; scaleKey?: string; identifying: boolean }>();
  const instrumentOf = new Map<string, string>();
  const informants = new Set<string>();
  for (const def of Object.values(manifest.instruments)) {
    const inst = def as { instrument: string; forms: { informant?: string; items: Record<string, unknown>[] }[] };
    for (const form of inst.forms) {
      if (form.informant) informants.add(form.informant);
      for (const raw of form.items) {
        const it = raw as { key: string; variable: string; scale?: string; identifying?: boolean };
        items.set(`${inst.instrument}.${it.key}`, {
          variable: it.variable,
          ...(it.scale ? { scaleKey: it.scale } : {}),
          identifying: it.identifying === true,
        });
        instrumentOf.set(`${inst.instrument}.${it.key}`, inst.instrument);
      }
    }
  }
  const scales = new Map<string, ResponseScale>(
    Object.entries(manifest.scales).map(([k, v]) => [k, v as ResponseScale]),
  );
  const scoring = new Map<string, ScoringDefinition>(
    Object.entries(manifest.scoring).map(([k, v]) => [k, v as ScoringDefinition]),
  );
  // A release is normally answered by one kind of respondent throughout. If it
  // mixes them, say so rather than picking one and being quietly wrong.
  const informant = informants.size === 1 ? [...informants][0]! : informants.size > 1 ? "mixed" : undefined;
  return { items, scales, scoring, informant };
}

/** Reduce one session's events to per-item state plus session-level counts. */
function replay(session: DeviceSession) {
  const items = new Map<string, ItemState>();
  let reviewEdits = 0;
  let durationMs: number | undefined;
  let foregroundMs: number | undefined;
  const secret: Record<string, string> = {};

  const at = (key: string): ItemState => {
    const existing = items.get(key);
    if (existing) return existing;
    const [instrument = "", item = ""] = key.split(".");
    const fresh: ItemState = {
      instrument,
      item,
      status: "not_reached_ended",
      value: null,
      dwellMs: null,
      visits: null,
      tooFast: false,
      changed: false,
    };
    items.set(key, fresh);
    return fresh;
  };

  // Events are replayed in sequence: the last statement about an item wins,
  // which is exactly how the participant experienced it.
  for (const e of [...session.events].sort((a, b) => a.seq - b.seq)) {
    const p = e.payload ?? {};
    switch (e.type) {
      case "response.recorded":
      case "response.changed": {
        if (!e.itemKey) break;
        const st = at(e.itemKey);
        st.status = "answered";
        st.value = (p as { value?: unknown }).value ?? null;
        if (e.type === "response.changed") st.changed = true;
        const t = (p as { timing?: { tooFast?: boolean } }).timing;
        if (t?.tooFast) st.tooFast = true;
        break;
      }
      case "item.skipped":
        if (e.itemKey) at(e.itemKey).status = "skipped";
        break;
      case "item.declined":
        if (e.itemKey) at(e.itemKey).status = "declined";
        break;
      case "item.left": {
        if (!e.itemKey) break;
        const st = at(e.itemKey);
        const total = (p as { totalDwellMs?: number }).totalDwellMs;
        const visit = (p as { visit?: number }).visit;
        if (typeof total === "number") st.dwellMs = total;
        if (typeof visit === "number") st.visits = visit;
        break;
      }
      case "response.too_fast":
        if (e.itemKey) at(e.itemKey).tooFast = true;
        break;
      case "review.edited":
        reviewEdits += 1;
        break;
      case "session.started": {
        const code = (p as Record<string, unknown>)["val_id"];
        if (typeof code === "string") secret["val_id"] = code;
        break;
      }
      case "session.completed": {
        const total = (p as { totalMs?: number; foregroundMs?: number }).totalMs;
        const fg = (p as { foregroundMs?: number }).foregroundMs;
        if (typeof total === "number") durationMs = total;
        if (typeof fg === "number") foregroundMs = fg;
        break;
      }
    }
  }
  return { items, reviewEdits, durationMs, foregroundMs, secret };
}

/** The four components of the secret code, as answered in this session. */
function secretParts(items: Map<string, ItemState>) {
  const text = (key: string): string | undefined => {
    const v = items.get(key)?.value as { kind?: string; value?: string } | null;
    return v && v.kind === "text" ? v.value : undefined;
  };
  const choice = (key: string): number | undefined => {
    const v = items.get(key)?.value as { kind?: string; code?: number } | null;
    return v && v.kind === "choice" ? v.code : undefined;
  };
  return {
    motherInitials: text("ybm_identity.ps_mother_initials") ?? "",
    houseDigit: text("ybm_identity.ps_house_digit") ?? "",
    birthMonth: choice("ybm_identity.ps_birth_month") ?? "",
    postcodeLetters: text("ybm_identity.ps_postcode_letters") ?? "",
  };
}

/**
 * Whole years between a date of birth and a reference date.
 *
 * Whole years, not a fraction: a decimal age is a date of birth wearing a hat,
 * and reconstructing the date from it is arithmetic.
 */
function ageAt(dobIso: string, atIso: string): number | null {
  const dob = new Date(dobIso);
  const at = new Date(atIso);
  if (Number.isNaN(dob.getTime()) || Number.isNaN(at.getTime())) return null;
  let years = at.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dob.getUTCDate())) years -= 1;
  return years >= 0 && years <= 120 ? years : null;
}

/** Render an answer for the readable columns of an export. */
function present(value: unknown, scale: ResponseScale | undefined) {
  const v = value as
    | { kind: "choice"; code: number }
    | { kind: "multi"; codes: number[] }
    | { kind: "number"; value: number }
    | { kind: "text"; value: string }
    | { kind: "date"; iso: string }
    | { kind: "fields"; values: Record<string, string> }
    | { kind: "checkboxes"; checked: string[] }
    | { kind: "group_rank"; assignments: Record<number, { group: string; rank?: number }> }
    | null;
  if (!v) return { value: null, text: null, label: null };
  switch (v.kind) {
    case "choice": {
      const opt = scale?.options.find((o) => o.code === v.code);
      return { value: v.code, text: null, label: opt?.label ?? null };
    }
    case "number":
      return { value: v.value, text: null, label: null };
    case "text":
      return { value: null, text: v.value, label: null };
    case "date":
      return { value: null, text: v.iso, label: null };
    case "multi": {
      const labels = v.codes.map((c) => scale?.options.find((o) => o.code === c)?.label ?? String(c));
      return { value: null, text: v.codes.join(","), label: labels.join(" | ") || null };
    }
    case "fields":
      return { value: null, text: JSON.stringify(v.values), label: null };
    case "checkboxes":
      return { value: v.checked.length, text: v.checked.join(","), label: null };
    case "group_rank":
      return { value: null, text: JSON.stringify(v.assignments), label: null };
  }
}

export function ingest(sessions: DeviceSession[], options: IngestOptions): IngestResult {
  const { manifest, study } = options;
  const { items: itemIndex, scales, scoring, informant } = indexManifest(manifest);
  const rejected: IngestResult["rejected"] = [];
  const warnings: string[] = [];

  const existing = options.existing;
  const identityRows: IdentityRow[] = [];
  // First names seen under each code, and the sittings they came from. Two
  // different names under one code is the twin signature.
  const namesByParticipant = new Map<string, Map<string, Set<string>>>();
  const sessionRows: SessionRow[] = existing ? [...existing.sessions] : [];
  const responseRows: ResponseRow[] = existing ? [...existing.responses] : [];
  const scoreRows: ScoreRow[] = existing ? [...existing.scores] : [];
  const seenSessions = new Set(sessionRows.map((s) => s.sessionId));

  for (const session of sessions) {
    if (seenSessions.has(session.sessionId)) {
      // Ingest is idempotent: the same session arriving twice — a retried sync,
      // a re-import of an old export — must not double a participant's data.
      warnings.push(`session '${session.sessionId}' already ingested; skipped`);
      continue;
    }

    const { items, reviewEdits, durationMs, foregroundMs } = replay(session);
    const derived = deriveParticipantCode(secretParts(items));
    // An assignment is a statement about this exact sitting and outranks a
    // correction, which is a statement about a code.
    const assigned = options.assignments?.[session.sessionId];
    // A correction resolves through as many hops as it takes, so fixing A->B
    // and later B->C does not leave A pointing at a code nobody uses.
    const participantId =
      assigned ?? (derived === null ? null : resolveAlias(derived, options.aliases));
    if (!participantId) {
      // Without a complete code there is no key to file this under, and
      // guessing one would join it to the wrong person. Held back, not dropped.
      rejected.push({
        sessionId: session.sessionId,
        reason: "secret code incomplete — cannot be linked to a participant",
      });
      continue;
    }

    const priorWaves = sessionRows.filter((s) => s.participantId === participantId).length;
    let answered = 0;
    let skipped = 0;
    let tooFast = 0;
    let revisited = 0;

    for (const [key, st] of items) {
      const meta = itemIndex.get(key);
      if (!meta) continue; // an item not in this release: nothing to file it as
      const scale = meta.scaleKey ? scales.get(meta.scaleKey) : undefined;
      const shown = present(st.value, scale);

      if (meta.identifying) {
        // Names, dates of birth and the secret-code components never become a
        // response row. They divert here, into a partition the caller has to
        // handle deliberately, so no export, table or view downstream has to
        // remember to leave them out — they are simply not in the data.
        const rendered = shown.text ?? (shown.value === null ? null : String(shown.value));
        if (st.status === "answered" && rendered !== null) {
          identityRows.push({
            participantId,
            sessionId: session.sessionId,
            study,
            variable: meta.variable,
            value: rendered,
            recordedAt: session.startedAt,
          });
          // The age is the part of a date of birth that the research actually
          // needs. Derived here, at a known reference date, so analysts are not
          // tempted to ask for the date itself later.
          if (meta.variable === "first_name") {
            const seen = namesByParticipant.get(participantId) ?? new Map<string, Set<string>>();
            const key = rendered.trim().toLowerCase();
            const sessions = seen.get(key) ?? new Set<string>();
            sessions.add(session.sessionId);
            seen.set(key, sessions);
            namesByParticipant.set(participantId, seen);
          }
          if (meta.variable === "dob") {
            const age = ageAt(rendered, session.startedAt);
            if (age !== null) {
              responseRows.push({
                sessionId: session.sessionId,
                participantId,
                // Filed as a demographic, not under the identity instrument:
                // it is an ordinary analysis variable, and leaving it there
                // would create a phenotype file named for a set of columns
                // that no longer exist.
                instrument: "ybm_demographics",
                item: "age_years",
                variable: "age_years",
                status: "answered",
                value: age,
                text: null,
                label: null,
                dwellMs: st.dwellMs,
                visits: st.visits,
                tooFast: st.tooFast,
                changed: st.changed,
              });
            }
          }
        }
        if (st.status === "answered") answered += 1;
        if (st.status === "skipped" || st.status === "declined") skipped += 1;
        continue;
      }

      if (st.status === "answered") answered += 1;
      if (st.status === "skipped" || st.status === "declined") skipped += 1;
      if (st.tooFast) tooFast += 1;
      if ((st.visits ?? 1) > 1) revisited += 1;
      responseRows.push({
        sessionId: session.sessionId,
        participantId,
        instrument: st.instrument,
        item: st.item,
        variable: meta.variable,
        status: st.status,
        value: shown.value,
        text: shown.text,
        label: shown.label,
        dwellMs: st.dwellMs,
        visits: st.visits,
        tooFast: st.tooFast,
        changed: st.changed,
      });
    }

    sessionRows.push({
      sessionId: session.sessionId,
      participantId,
      study,
      wave: priorWaves + 1,
      studyCode: session.studyCode,
      ...(site(session.studyCode) ? { site: site(session.studyCode)! } : {}),
      releaseKey: session.releaseKey,
      ...(informant ? { informant } : {}),
      releaseHash: session.releaseHash,
      startedAt: session.startedAt,
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(foregroundMs !== undefined ? { foregroundMs } : {}),
      answeredCount: answered,
      skippedCount: skipped,
      tooFastCount: tooFast,
      revisitedCount: revisited,
      reviewEdits,
      complete: session.complete,
    });
    seenSessions.add(session.sessionId);

    scoreRows.push(...scoreSession(session.sessionId, participantId, items, itemIndex, scoring));
  }

  return {
    dataset: {
      generatedAt: new Date().toISOString(),
      releaseHashes: [...new Set(sessionRows.map((s) => s.releaseHash))].sort(),
      participants: summariseParticipants(sessionRows),
      sessions: sessionRows,
      responses: responseRows,
      scores: scoreRows,
    },
    identity: identityRows,
    rejected,
    collisions: [...namesByParticipant.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([participantId, names]) => ({
        participantId,
        names: [...names.keys()].sort(),
        sessions: [...new Set([...names.values()].flatMap((s) => [...s]))].sort(),
      })),
    warnings,
  };
}

/** Run every scoring definition the release carries over one session. */
function scoreSession(
  sessionId: string,
  participantId: string,
  items: Map<string, ItemState>,
  itemIndex: Map<string, { variable: string; scaleKey?: string }>,
  scoring: Map<string, ScoringDefinition>,
): ScoreRow[] {
  void itemIndex;
  const rows: ScoreRow[] = [];
  for (const [key, def] of scoring) {
    const values: Record<string, number | null> = {};
    for (const step of def.steps) {
      const stepItems = "items" in step ? step.items : [];
      for (const item of stepItems) {
        if (item in values) continue;
        const st = items.get(`${def.instrument}.${item}`);
        const v = st?.value as { kind?: string; code?: number; value?: number } | null;
        values[item] =
          st?.status === "answered" && v
            ? v.kind === "choice"
              ? (v.code ?? null)
              : v.kind === "number"
                ? (v.value ?? null)
                : null
            : null;
      }
    }
    const result = executeScoring(def, values);
    for (const [output, value] of Object.entries(result.outputs)) {
      rows.push({
        sessionId,
        participantId,
        instrument: def.instrument,
        scoringKey: key,
        scoringVersion: def.version,
        output,
        value,
        validCount: result.validCounts[output] ?? null,
        warnings: result.warnings,
      });
    }
  }
  return rows;
}

/**
 * Follow a chain of corrections to the code actually in use.
 *
 * Loops are possible if somebody records A->B and B->A; the walk is bounded
 * and returns where it got to rather than hanging, because a monitoring screen
 * that never renders is worse than one showing an odd code.
 */
export function resolveAlias(code: string, aliases: Record<string, string> | undefined): string {
  if (!aliases) return code;
  const seen = new Set<string>([code]);
  let current = code;
  for (let hops = 0; hops < 16; hops += 1) {
    const next = aliases[current];
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
}

/** One row per person, summarising every wave they have taken part in. */
function summariseParticipants(sessions: SessionRow[]): Dataset["participants"] {
  const byParticipant = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const list = byParticipant.get(s.participantId);
    if (list) list.push(s);
    else byParticipant.set(s.participantId, [s]);
  }
  return [...byParticipant.entries()]
    .map(([participantId, rows]) => {
      const ordered = [...rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return {
        participantId,
        study: ordered[0]!.study,
        firstSeen: ordered[0]!.startedAt,
        lastSeen: ordered[ordered.length - 1]!.startedAt,
        sessionCount: ordered.length,
        sites: [...new Set(ordered.map((s) => s.site).filter((s): s is string => s !== undefined))],
      };
    })
    .sort((a, b) => a.participantId.localeCompare(b.participantId));
}
