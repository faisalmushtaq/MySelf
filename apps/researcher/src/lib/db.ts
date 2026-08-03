import Dexie, { type EntityTable } from "dexie";
import type { DeviceSession } from "@myself/store";

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

class ResearcherDb extends Dexie {
  sessions!: EntityTable<StoredSession, "sessionId">;

  constructor() {
    super("myself-researcher");
    this.version(1).stores({
      sessions: "sessionId, startedAt, studyCode, importedAt",
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
