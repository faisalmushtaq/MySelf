import Dexie, { type EntityTable } from "dexie";
import type { DeviceSession, IdentityRow } from "@myself/store";

/**
 * The database behind the researcher view.
 *
 * What is stored is the raw device event log, one record per sitting, exactly
 * as it arrived. The dataset — participants, sessions, responses, scores — is
 * derived from those logs on every load and never persisted. That costs a
 * second at start-up and buys the thing that matters: a scoring correction, a
 * new derived variable or a fix in the reader can be applied to the whole
 * study by shipping a new build, with no migration and no possibility of two
 * versions of the truth sitting side by side in one file.
 *
 * Imports are keyed on `sessionId`, so the same export file dropped in twice —
 * which will happen, on a day with three iPads and one laptop — adds nothing.
 */

export interface StoredSession extends DeviceSession {
  /** When this sitting was imported, and from which file. */
  importedAt: string;
  source: string;
}

/**
 * A person, in the only place this tool holds one.
 *
 * Names are needed — to repair a code somebody mistyped, and to join to the
 * UPN a school provides — so they are kept, deliberately, in their own table.
 * Not mixed into the sittings, not reachable from the table or any export, and
 * every lookup recorded in `identityAccess` so there is an account of who
 * looked at what.
 */
export interface PersonRecord {
  participantCode: string;
  study: string;
  givenName: string | null;
  familyName: string | null;
  dateOfBirth: string | null;
  upn: string | null;
  upnSource: string | null;
  /** Every code this person has typed, right or wrong, wave by wave. */
  claims: { sessionId: string; claimedCode: string; givenName: string | null; familyName: string | null; recordedAt: string }[];
}

export interface CodeCorrection {
  id: string;
  wrongCode: string;
  rightCode: string;
  reason: string;
  madeAt: string;
  withdrawnAt: string | null;
}

/** A sitting assigned to a specific participant — how twins are split. */
export interface Assignment {
  sessionId: string;
  participantCode: string;
  reason: string;
  madeAt: string;
}

/** Parent and child, or twin and twin. Held with the names, not the answers. */
export interface Relationship {
  id: string;
  participantCode: string;
  relatedCode: string;
  kind: "parent_of" | "child_of" | "sibling_of" | "twin_of";
  note: string;
  recordedAt: string;
}

export interface AccessRecord {
  id: string;
  at: string;
  action: string;
  participant: string;
  justification: string;
}

class ResearcherDb extends Dexie {
  sessions!: EntityTable<StoredSession, "sessionId">;
  people!: EntityTable<PersonRecord, "participantCode">;
  corrections!: EntityTable<CodeCorrection, "id">;
  assignments!: EntityTable<Assignment, "sessionId">;
  relationships!: EntityTable<Relationship, "id">;
  identityAccess!: EntityTable<AccessRecord, "id">;

  constructor() {
    super("myself-researcher");
    this.version(1).stores({
      sessions: "sessionId, startedAt, studyCode, importedAt",
    });
    this.version(2).stores({
      sessions: "sessionId, startedAt, studyCode, importedAt",
      people: "participantCode, study, familyName, upn",
      corrections: "id, wrongCode, withdrawnAt",
      identityAccess: "id, at",
    });
    this.version(3).stores({
      sessions: "sessionId, startedAt, studyCode, importedAt",
      people: "participantCode, study, familyName, upn",
      corrections: "id, wrongCode, withdrawnAt",
      assignments: "sessionId, participantCode",
      relationships: "id, participantCode, relatedCode",
      identityAccess: "id, at",
    });
  }
}

export const db = new ResearcherDb();

export interface ImportReport {
  file: string;
  added: number;
  duplicates: number;
  errors: string[];
}

interface RawExport {
  format?: string;
  sessions?: unknown;
}

/** Read one device export file into the database. */
export async function importExportFile(name: string, text: string): Promise<ImportReport> {
  const report: ImportReport = { file: name, added: 0, duplicates: 0, errors: [] };
  let parsed: RawExport;
  try {
    parsed = JSON.parse(text) as RawExport;
  } catch {
    report.errors.push("not a readable JSON file");
    return report;
  }
  if (!Array.isArray(parsed.sessions)) {
    report.errors.push("no sessions in this file — is it a MySelf device export?");
    return report;
  }

  const importedAt = new Date().toISOString();
  for (const raw of parsed.sessions as DeviceSession[]) {
    if (!raw?.sessionId || !Array.isArray(raw.events)) {
      report.errors.push("a session in this file has no identifier or no events");
      continue;
    }
    const existing = await db.sessions.get(raw.sessionId);
    if (existing) {
      report.duplicates += 1;
      continue;
    }
    await db.sessions.add({ ...raw, importedAt, source: name });
    report.added += 1;
  }
  return report;
}

export async function storedSessions(): Promise<StoredSession[]> {
  const all = await db.sessions.toArray();
  return all.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function addSessions(sessions: DeviceSession[], source: string): Promise<number> {
  const importedAt = new Date().toISOString();
  let added = 0;
  for (const s of sessions) {
    if (await db.sessions.get(s.sessionId)) continue;
    await db.sessions.add({ ...s, importedAt, source });
    added += 1;
  }
  return added;
}

/** Remove everything. Used for clearing demonstration data before fieldwork. */
export async function clearAll(): Promise<void> {
  await db.sessions.clear();
}

export async function clearSource(source: string): Promise<number> {
  const rows = await db.sessions.where("sessionId").notEqual("").toArray();
  const doomed = rows.filter((r) => r.source === source).map((r) => r.sessionId);
  await db.sessions.bulkDelete(doomed);
  return doomed.length;
}

// ── Identity: kept apart, and only ever written on purpose ────────────────

/** File the identity partition ingest returned, keyed by participant code. */
export async function storeIdentity(rows: IdentityRow[]): Promise<number> {
  const bySession = new Map<string, { participantId: string; study: string; recordedAt: string; values: Record<string, string> }>();
  for (const row of rows) {
    const entry = bySession.get(row.sessionId) ?? {
      participantId: row.participantId,
      study: row.study,
      recordedAt: row.recordedAt,
      values: {},
    };
    entry.values[row.variable] = row.value;
    bySession.set(row.sessionId, entry);
  }

  let written = 0;
  for (const [sessionId, entry] of bySession) {
    const given = entry.values["first_name"] ?? null;
    const family = entry.values["last_name"] ?? null;
    const dob = entry.values["dob"] ?? null;
    const existing = await db.people.get(entry.participantId);
    const claim = { sessionId, claimedCode: entry.participantId, givenName: given, familyName: family, recordedAt: entry.recordedAt };
    if (existing) {
      // The name first given stands. A later wave spelling it differently is
      // evidence to look at, not a reason to overwrite the record quietly.
      const claims = existing.claims.filter((c) => c.sessionId !== sessionId);
      await db.people.put({
        ...existing,
        givenName: existing.givenName ?? given,
        familyName: existing.familyName ?? family,
        dateOfBirth: existing.dateOfBirth ?? dob,
        claims: [...claims, claim].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
      });
    } else {
      await db.people.put({
        participantCode: entry.participantId,
        study: entry.study,
        givenName: given,
        familyName: family,
        dateOfBirth: dob,
        upn: null,
        upnSource: null,
        claims: [claim],
      });
    }
    written += 1;
  }
  return written;
}

const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Record that somebody looked. Written before the answer is shown. */
export async function noteAccess(action: string, participant: string, justification: string): Promise<void> {
  await db.identityAccess.put({ id: id(), at: new Date().toISOString(), action, participant, justification });
}

export async function lookupByCode(code: string, justification: string): Promise<PersonRecord | undefined> {
  await noteAccess("lookup", code, justification);
  return db.people.get(code);
}

/** Find every code a name has ever been filed under — how a mistype is caught. */
export async function searchPeople(
  query: { givenName?: string; familyName?: string; upn?: string },
  justification: string,
): Promise<PersonRecord[]> {
  await noteAccess("search", query.upn ?? `${query.givenName ?? ""} ${query.familyName ?? ""}`.trim(), justification);
  const all = await db.people.toArray();
  const like = (value: string | null, want: string | undefined) =>
    want === undefined || want === "" || (value ?? "").toLowerCase().includes(want.trim().toLowerCase());
  return all.filter((p) => {
    if (query.upn) return (p.upn ?? "") === query.upn.trim();
    const onRecord = like(p.givenName, query.givenName) && like(p.familyName, query.familyName);
    const onAClaim = p.claims.some((c) => like(c.givenName, query.givenName) && like(c.familyName, query.familyName));
    return onRecord || onAClaim;
  });
}

export async function setUpn(code: string, upn: string, source: string, justification: string): Promise<{ ok: boolean; conflict?: string }> {
  await noteAccess("link_upn", code, justification);
  const clash = await db.people.filter((p) => p.upn === upn && p.participantCode !== code).first();
  // One UPN, one pupil. Caught here rather than in an analysis.
  if (clash) return { ok: false, conflict: `that UPN is already linked to ${clash.participantCode}` };
  const person = await db.people.get(code);
  if (!person) return { ok: false, conflict: "no record for that code" };
  await db.people.put({ ...person, upn, upnSource: source });
  return { ok: true };
}

export async function recordCorrection(wrongCode: string, rightCode: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  if (wrongCode === rightCode) return { ok: false, error: "those are the same code" };
  const onward = await db.corrections.filter((c) => c.withdrawnAt === null && c.wrongCode === rightCode).first();
  if (onward) return { ok: false, error: `${rightCode} is itself corrected to ${onward.rightCode} — correct to that instead` };
  const live = await db.corrections.filter((c) => c.withdrawnAt === null && c.wrongCode === wrongCode).first();
  if (live) return { ok: false, error: `${wrongCode} is already corrected to ${live.rightCode}` };
  await db.corrections.put({
    id: id(),
    wrongCode,
    rightCode,
    reason,
    madeAt: new Date().toISOString(),
    withdrawnAt: null,
  });
  return { ok: true };
}

export async function withdrawCorrection(correctionId: string): Promise<void> {
  const row = await db.corrections.get(correctionId);
  if (row) await db.corrections.put({ ...row, withdrawnAt: new Date().toISOString() });
}

export async function corrections(): Promise<CodeCorrection[]> {
  return (await db.corrections.toArray()).sort((a, b) => b.madeAt.localeCompare(a.madeAt));
}

/** Live corrections, in the shape `ingest` takes them. */
export async function aliases(): Promise<Record<string, string>> {
  const rows = await db.corrections.filter((c) => c.withdrawnAt === null).toArray();
  return Object.fromEntries(rows.map((r) => [r.wrongCode, r.rightCode]));
}

export async function accessLog(): Promise<AccessRecord[]> {
  return (await db.identityAccess.orderBy("at").reverse().limit(200).toArray());
}

// ── Twins, and who belongs to whom ────────────────────────────────────────

/**
 * Assign a sitting to a participant, overriding the code it derived to.
 *
 * This is how twins are separated. Their secret codes are identical — same
 * mother, same house, same birth month, same postcode — so nothing but a name
 * distinguishes them, and the split has to be stated by somebody who can see
 * those names.
 */
export async function assignSession(sessionId: string, participantCode: string, reason: string): Promise<void> {
  await db.assignments.put({ sessionId, participantCode, reason, madeAt: new Date().toISOString() });
  await noteAccess("assign_sitting", participantCode, reason);
}

export async function clearAssignment(sessionId: string): Promise<void> {
  await db.assignments.delete(sessionId);
}

export async function assignments(): Promise<Record<string, string>> {
  const rows = await db.assignments.toArray();
  return Object.fromEntries(rows.map((r) => [r.sessionId, r.participantCode]));
}

export async function assignmentList(): Promise<Assignment[]> {
  return (await db.assignments.toArray()).sort((a, b) => b.madeAt.localeCompare(a.madeAt));
}

export async function recordRelationship(
  participantCode: string,
  relatedCode: string,
  kind: Relationship["kind"],
  note: string,
): Promise<{ ok: boolean; error?: string }> {
  if (participantCode === relatedCode) return { ok: false, error: "a person cannot be related to themselves" };
  const at = new Date().toISOString();
  await db.relationships.put({ id: id(), participantCode, relatedCode, kind, note, recordedAt: at });
  // Both directions are stored, so looking up either end finds the other. A
  // relationship recorded once and readable one way only is a relationship
  // somebody will miss.
  const inverse: Record<Relationship["kind"], Relationship["kind"]> = {
    parent_of: "child_of",
    child_of: "parent_of",
    sibling_of: "sibling_of",
    twin_of: "twin_of",
  };
  await db.relationships.put({
    id: id(),
    participantCode: relatedCode,
    relatedCode: participantCode,
    kind: inverse[kind],
    note,
    recordedAt: at,
  });
  await noteAccess("record_relationship", `${participantCode} ${kind} ${relatedCode}`, note);
  return { ok: true };
}

export async function relationshipsFor(participantCode: string): Promise<Relationship[]> {
  return db.relationships.where("participantCode").equals(participantCode).toArray();
}

export async function allRelationships(): Promise<Relationship[]> {
  return (await db.relationships.toArray()).sort((a, b) => a.participantCode.localeCompare(b.participantCode));
}
