import Dexie, { type EntityTable } from "dexie";
import {
  defuseFormula,
  formatHomeAddress,
  isEncryptedEnvelope,
  openExport,
  parseHomeAddress,
  type DeviceSession,
  type IdentityRow,
} from "@myself/store";
import {
  createVault,
  openVault,
  openWith,
  sealWith,
  type Sealed,
  type VaultRecord,
} from "./vault.js";

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
  /**
   * Which iPad collected it, where the file said.
   *
   * Absent for a sitting pulled from the study — the server holds that on its own record
   * — and for handover files written before the format carried it.
   */
  deviceId?: string;
  /**
   * When the study last received this sitting (server clock), set by a pull.
   *
   * Present means the study's database holds the sitting, so the dashboard sees it too;
   * absent means it has only ever arrived here in a file. It also decides whether an
   * unfinished sitting is in progress or abandoned, exactly as the dashboard decides it.
   */
  receivedAt?: string;
}

/**
 * What the last pull from the study found.
 *
 * Kept because the pull's own report scrolls away, and the Overview has to say, every
 * time it is opened, how old the data are and how many sittings the study was holding
 * back — quarantined, or too torn to reassemble — that are therefore not counted here.
 */
export interface PullRecord {
  id: "last";
  at: string;
  /** Sittings the study returned and this browser now holds from it. */
  sittings: number;
  quarantined: number;
  unreadable: string[];
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
  /** Collected in the survey under explicit approval, or given by a parent. */
  nhsNumber: string | null;
  nhsSource: string | null;
  /**
   * The home address from the most recent sitting that gave one (r8.0.0 on,
   * D-52), as "house street, postcode". Absent from records sealed before it
   * existed.
   */
  homeAddress?: string | null;
  /** Every code this person has typed, right or wrong, wave by wave. */
  claims: {
    sessionId: string;
    claimedCode: string;
    givenName: string | null;
    familyName: string | null;
    homeAddress?: string | null;
    recordedAt: string;
  }[];
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

/**
 * A person as actually written to disk.
 *
 * The participant code stays in the clear as the key — it is already the join
 * used in the sittings, the export and the filenames, so pretending it is a
 * secret here would be theatre. Everything that names a child is in `sealed`.
 */
export interface StoredPerson {
  participantCode: string;
  study: string;
  sealed: Sealed;
}

/** A relationship, with the two codes it joins sealed together. */
export interface StoredRelationship {
  id: string;
  sealed: Sealed;
}

class ResearcherDb extends Dexie {
  sessions!: EntityTable<StoredSession, "sessionId">;
  people!: EntityTable<StoredPerson, "participantCode">;
  corrections!: EntityTable<CodeCorrection, "id">;
  assignments!: EntityTable<Assignment, "sessionId">;
  relationships!: EntityTable<StoredRelationship, "id">;
  identityAccess!: EntityTable<AccessRecord, "id">;
  vault!: EntityTable<VaultRecord, "id">;
  pulls!: EntityTable<PullRecord, "id">;

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
    /**
     * Version 4: the identity tables are sealed.
     *
     * The `familyName` and `upn` indexes go, and nothing is lost by it — they
     * were declared and never used, because every lookup in this file is either
     * `get(code)` or a full scan filtered in memory. That is the only reason
     * sealing these fields is a small change rather than a rewrite of the
     * linkage tab.
     *
     * EXISTING ROWS ARE DELETED, NOT MIGRATED. A migration cannot run here: the
     * passphrase does not exist yet, and there is nowhere to hold a key while
     * Dexie upgrades. Nothing is lost that cannot be rebuilt — every person
     * record is derived from the sittings on each load by `storeIdentity`, so
     * the names come straight back the first time the vault is unlocked.
     *
     * What does NOT come back is a hand-entered UPN or NHS number, or a recorded
     * relationship, because those were typed rather than derived. On a study that
     * has not been fielded yet there are none. On one that has, they must be
     * re-entered — which is the honest cost of having stored them in the clear,
     * and cheaper than leaving them there.
     */
    this.version(4)
      .stores({
        sessions: "sessionId, startedAt, studyCode, importedAt",
        people: "participantCode, study",
        corrections: "id, wrongCode, withdrawnAt",
        assignments: "sessionId, participantCode",
        relationships: "id",
        identityAccess: "id, at",
        vault: "id",
      })
      .upgrade(async (tx) => {
        await tx.table("people").clear();
        await tx.table("relationships").clear();
      });
    /** Version 5: the last pull is remembered, so the Overview can say how fresh it is. */
    this.version(5).stores({
      sessions: "sessionId, startedAt, studyCode, importedAt",
      people: "participantCode, study",
      corrections: "id, wrongCode, withdrawnAt",
      assignments: "sessionId, participantCode",
      relationships: "id",
      identityAccess: "id, at",
      vault: "id",
      pulls: "id",
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
  /**
   * Which iPad wrote the file.
   *
   * Carried so a sitting imported from a handover file and the same sitting arriving later
   * over wifi are recognised as one sitting from one device. Older files have none; they
   * still import, and the sitting simply has no device recorded against it.
   */
  deviceId?: unknown;
}

/**
 * Read one device export file into the database.
 *
 * Handover files are encrypted under the study passphrase, so importing one needs
 * it. Files written before that change are plaintext and still read — refusing
 * them would strand data that has already been collected, and the way to stop
 * plaintext files existing is to stop writing them, which the participant app now
 * does.
 */
export async function importExportFile(name: string, text: string, passphrase = ""): Promise<ImportReport> {
  const report: ImportReport = { file: name, added: 0, duplicates: 0, errors: [] };
  let parsed: RawExport;
  try {
    const raw: unknown = JSON.parse(text);
    if (isEncryptedEnvelope(raw)) {
      if (passphrase === "") {
        report.errors.push("this file is encrypted — type the study passphrase above and import it again");
        return report;
      }
      parsed = (await openExport(raw, passphrase)) as RawExport;
    } else {
      parsed = raw as RawExport;
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : "not a readable JSON file");
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
    await db.sessions.add({
      ...raw,
      importedAt,
      source: name,
      ...(typeof parsed.deviceId === "string" ? { deviceId: parsed.deviceId } : {}),
    });
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

export interface MergeReport {
  added: number;
  /** Local copies replaced by a longer one from the study. */
  superseded: number;
  unchanged: number;
}

/**
 * Take in sittings pulled from the study, superseding shorter local copies.
 *
 * NOT `addSessions`, and the difference matters. A file import treats a sitting
 * it already has as a duplicate and adds nothing, which is right: two exports of
 * the same finished sitting are the same sitting.
 *
 * A pull is not that. Devices now upload a sitting WHILE IT IS STILL BEING
 * ANSWERED, so the study's copy grows — pulled at four hundred events on Tuesday
 * and complete at nine hundred on Wednesday. Skipping it as a duplicate would
 * leave a partial sitting in the analysis for the rest of the study, and nothing
 * on screen would say so.
 *
 * So the longer log wins, which is the same rule the server applies to uploads.
 * A local copy is never replaced by a shorter one — that would be the truncation
 * the write path refuses, arriving by the other road.
 */
export async function mergeFromStudy(
  sessions: (DeviceSession & { receivedAt?: string })[],
  source: string,
): Promise<MergeReport> {
  const importedAt = new Date().toISOString();
  const report: MergeReport = { added: 0, superseded: 0, unchanged: 0 };

  for (const incoming of sessions) {
    const existing = await db.sessions.get(incoming.sessionId);
    if (!existing) {
      await db.sessions.add({ ...incoming, importedAt, source });
      report.added += 1;
      continue;
    }
    if (supersedes(incoming, existing)) {
      await db.sessions.put({ ...incoming, importedAt, source });
      report.superseded += 1;
      continue;
    }
    // The same log, but the study may have heard from the device since — and a copy
    // that arrived by file first learns here that the study holds it too.
    if (incoming.receivedAt && incoming.receivedAt !== existing.receivedAt) {
      await db.sessions.update(incoming.sessionId, { receivedAt: incoming.receivedAt });
    }
    report.unchanged += 1;
  }
  return report;
}

export async function recordPull(record: Omit<PullRecord, "id">): Promise<void> {
  await db.pulls.put({ id: "last", ...record });
}

export async function lastPull(): Promise<PullRecord | null> {
  return (await db.pulls.get("last")) ?? null;
}

export type SittingSource = "study" | "file" | "demonstration";

/**
 * Where a stored sitting came from, as far as the dashboard is concerned: a sitting the
 * study's database holds is one the dashboard counts too; one that only ever arrived
 * here in a file is not, and a count that includes it will not match the dashboard's.
 */
export function sourceOf(sitting: Pick<StoredSession, "source" | "receivedAt">): SittingSource {
  if (sitting.source === DEMONSTRATION) return "demonstration";
  return sitting.source === "study" || sitting.receivedAt !== undefined ? "study" : "file";
}

/** The source recorded against made-up sittings. */
export const DEMONSTRATION = "demonstration data";

/**
 * Should the copy just pulled replace the copy already here?
 *
 * Only if it is longer. Pure and named so the rule can be tested without a
 * database, because getting it wrong in either direction is a quiet analysis
 * error rather than a crash: too eager and a complete sitting is replaced by a
 * checkpoint of itself, too shy and a partial sitting stays in the analysis for
 * the rest of the study with nothing on screen to say so.
 */
export function supersedes(incoming: { events: unknown[] }, existing: { events: unknown[] }): boolean {
  return incoming.events.length > existing.events.length;
}

/** Remove everything. Used for clearing demonstration data before fieldwork. */
export async function clearAll(): Promise<void> {
  await db.sessions.clear();
  // The record of the last pull describes sittings that are no longer here.
  await db.pulls.clear();
}

export async function clearSource(source: string): Promise<number> {
  const rows = await db.sessions.where("sessionId").notEqual("").toArray();
  const doomed = rows.filter((r) => r.source === source).map((r) => r.sessionId);
  await db.sessions.bulkDelete(doomed);
  return doomed.length;
}

// ── Identity: kept apart, sealed, and only ever written on purpose ────────

/**
 * The key, while somebody is sitting at the laptop.
 *
 * In memory only. It goes when the tab does, which is the point: a closed laptop
 * holds names it cannot read, and the passphrase that opens them is not written
 * anywhere on the machine.
 */
let identityKey: CryptoKey | null = null;

export function identityIsUnlocked(): boolean {
  return identityKey !== null;
}

export async function identityVaultExists(): Promise<boolean> {
  return (await db.vault.get("vault")) !== undefined;
}

/** Set the passphrase for a study whose vault has not been created yet. */
export async function createIdentityVault(passphrase: string): Promise<void> {
  if (await identityVaultExists()) throw new Error("this laptop already has a vault — unlock it instead");
  const { record, key } = await createVault(passphrase);
  await db.vault.put(record);
  identityKey = key;
}

export async function unlockIdentity(passphrase: string): Promise<void> {
  const record = await db.vault.get("vault");
  if (!record) throw new Error("there is no vault on this laptop yet");
  identityKey = await openVault(record, passphrase);
}

/**
 * Lock it again.
 *
 * Called on request and when the tab has been hidden for a while. A laptop left
 * open on a staffroom table is the ordinary case, not the paranoid one.
 */
export function lockIdentity(): void {
  identityKey = null;
}

/**
 * The key, or a refusal that names what to do about it.
 *
 * Every identity read and write goes through here, so there is no path to the
 * names that forgets to check — the check is the only way to get the key.
 */
function requireKey(): CryptoKey {
  if (!identityKey) throw new Error("the identity vault is locked — unlock it to see or change any of this");
  return identityKey;
}

/** The identifying half of a person record, which is what actually gets sealed. */
interface PersonSecrets {
  givenName: string | null;
  familyName: string | null;
  dateOfBirth: string | null;
  upn: string | null;
  upnSource: string | null;
  nhsNumber: string | null;
  nhsSource: string | null;
  homeAddress?: string | null;
  claims: PersonRecord["claims"];
}

async function sealPerson(person: PersonRecord): Promise<StoredPerson> {
  const secrets: PersonSecrets = {
    givenName: person.givenName,
    familyName: person.familyName,
    dateOfBirth: person.dateOfBirth,
    upn: person.upn,
    upnSource: person.upnSource,
    nhsNumber: person.nhsNumber,
    nhsSource: person.nhsSource,
    homeAddress: person.homeAddress ?? null,
    claims: person.claims,
  };
  return {
    participantCode: person.participantCode,
    study: person.study,
    sealed: await sealWith(requireKey(), secrets),
  };
}

async function openPerson(row: StoredPerson): Promise<PersonRecord> {
  const secrets = await openWith<PersonSecrets>(requireKey(), row.sealed);
  return { participantCode: row.participantCode, study: row.study, ...secrets };
}

/** Every person, opened. Used by the searches, which all scan in memory anyway. */
async function allPeople(): Promise<PersonRecord[]> {
  const key = requireKey();
  void key;
  const rows = await db.people.toArray();
  return Promise.all(rows.map(openPerson));
}


/**
 * File the identity partition ingest returned, keyed by participant code.
 *
 * SILENT WHEN LOCKED, and that is safe rather than lossy. This runs on every load
 * as part of deriving the dataset, long before anybody has typed a passphrase, and
 * throwing here would stop the whole view — overview, table and export included —
 * on a screen nobody needs the names for.
 *
 * Nothing is lost by skipping: these rows are DERIVED from the sittings every
 * time, so unlocking the vault and re-deriving brings them all back. That is also
 * why a forgotten passphrase costs the typed-in fields and not the names.
 */
/**
 * The address a person's claims say is current: the one from the most recent
 * sitting that gave one, judged by when the sitting happened rather than when
 * it was loaded, so a sitting imported late does not replace a newer address.
 */
function currentAddress(claims: PersonRecord["claims"]): string | null {
  const latest = [...claims]
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .reverse()
    .find((c) => c.homeAddress);
  return latest?.homeAddress ?? null;
}

export async function storeIdentity(rows: IdentityRow[]): Promise<number> {
  if (!identityIsUnlocked()) return 0;
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
    const address = formatHomeAddress(parseHomeAddress(entry.values["home_address"]));
    const row = await db.people.get(entry.participantId);
    const existing = row ? await openPerson(row) : undefined;
    const claim = {
      sessionId,
      claimedCode: entry.participantId,
      givenName: given,
      familyName: family,
      homeAddress: address,
      recordedAt: entry.recordedAt,
    };
    if (existing) {
      // The name first given stands. A later wave spelling it differently is
      // evidence to look at, not a reason to overwrite the record quietly.
      const claims = [...existing.claims.filter((c) => c.sessionId !== sessionId), claim].sort((a, b) =>
        a.recordedAt.localeCompare(b.recordedAt),
      );
      await db.people.put(
        await sealPerson({
          ...existing,
          givenName: existing.givenName ?? given,
          familyName: existing.familyName ?? family,
          dateOfBirth: existing.dateOfBirth ?? dob,
          // Unlike a name, an address is expected to change: keep the one from
          // the most recent sitting, whichever order the sittings arrived in.
          homeAddress: currentAddress(claims) ?? existing.homeAddress ?? null,
          claims,
        }),
      );
    } else {
      await db.people.put(
        await sealPerson({
          participantCode: entry.participantId,
          study: entry.study,
          givenName: given,
          familyName: family,
          dateOfBirth: dob,
          upn: null,
          upnSource: null,
          nhsNumber: null,
          nhsSource: null,
          homeAddress: address,
          claims: [claim],
        }),
      );
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
  const row = await db.people.get(code);
  return row ? openPerson(row) : undefined;
}

/** Find every code a name has ever been filed under — how a mistype is caught. */
export async function searchPeople(
  query: { givenName?: string; familyName?: string; upn?: string },
  justification: string,
): Promise<PersonRecord[]> {
  await noteAccess("search", query.upn ?? `${query.givenName ?? ""} ${query.familyName ?? ""}`.trim(), justification);
  const all = await allPeople();
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
  // One UPN, one pupil. Caught here rather than in an analysis. The scan happens
  // in memory because the UPN is sealed — the Dexie index it used to use was
  // never actually used as an index, so nothing is slower than it was.
  const clash = (await allPeople()).find((p) => p.upn === upn && p.participantCode !== code);
  if (clash) return { ok: false, conflict: `that UPN is already linked to ${clash.participantCode}` };
  const row = await db.people.get(code);
  if (!row) return { ok: false, conflict: "no record for that code" };
  const person = await openPerson(row);
  await db.people.put(await sealPerson({ ...person, upn, upnSource: source }));
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
  const seal = async (row: Relationship) => ({ id: row.id, sealed: await sealWith(requireKey(), row) });
  await db.relationships.put(await seal({ id: id(), participantCode, relatedCode, kind, note, recordedAt: at }));
  // Both directions are stored, so looking up either end finds the other. A
  // relationship recorded once and readable one way only is a relationship
  // somebody will miss.
  const inverse: Record<Relationship["kind"], Relationship["kind"]> = {
    parent_of: "child_of",
    child_of: "parent_of",
    sibling_of: "sibling_of",
    twin_of: "twin_of",
  };
  await db.relationships.put(
    await seal({
      id: id(),
      participantCode: relatedCode,
      relatedCode: participantCode,
      kind: inverse[kind],
      note,
      recordedAt: at,
    }),
  );
  await noteAccess("record_relationship", `${participantCode} ${kind} ${relatedCode}`, note);
  return { ok: true };
}

/**
 * Relationships are sealed whole, both codes included.
 *
 * A relationship between two participant codes is itself identifying — "these two
 * are twins" narrows a pair of children considerably — so unlike a person record,
 * where the code stays in the clear as the key, nothing here is readable without
 * the vault. That costs the `participantCode` index, and since the only queries
 * are "for this person" and "all of them", scanning in memory is no slower on a
 * study-sized table.
 */
export async function relationshipsFor(participantCode: string): Promise<Relationship[]> {
  return (await allRelationships()).filter((r) => r.participantCode === participantCode);
}

export async function allRelationships(): Promise<Relationship[]> {
  const key = requireKey();
  const rows = await db.relationships.toArray();
  const opened = await Promise.all(rows.map((row) => openWith<Relationship>(key, row.sealed)));
  return opened.sort((a, b) => a.participantCode.localeCompare(b.participantCode));
}

/**
 * The identifier file: participant code beside the identifiers, and nothing
 * else.
 *
 * This is the file you join to the phenotype tables on `participant_id`, and
 * the file a linkage service is sent. It is generated here, from the identity
 * table alone, and deliberately carries no answers: a file that had both would
 * be the one thing this platform is arranged to avoid producing by accident.
 *
 * Getting it requires a reason, which is stored — the same as any other look
 * at a name.
 */
export async function identifierFile(justification: string): Promise<string> {
  await noteAccess("identifier_file", "all participants", justification);
  const people = (await allPeople()).sort((a, b) => a.participantCode.localeCompare(b.participantCode));
  const escape = (raw: string | null) => {
    if (raw === null || raw === "") return "";
    // Anything a participant typed is opened in a spreadsheet here: a leading
    // =, +, - or @ would run as a formula, so it is made plain text.
    const value = defuseFormula(raw);
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const header = "participant_id,given_name,family_name,date_of_birth,home_address,upn,nhs_number,n_sittings";
  const rows = people.map((p) =>
    [
      p.participantCode,
      escape(p.givenName),
      escape(p.familyName),
      escape(p.dateOfBirth),
      escape(p.homeAddress ?? null),
      escape(p.upn),
      escape(p.nhsNumber),
      String(p.claims.length),
    ].join(","),
  );
  return `${[header, ...rows].join("\n")}\n`;
}

export async function setNhsNumber(
  code: string,
  nhsNumber: string,
  source: string,
  justification: string,
): Promise<{ ok: boolean; conflict?: string }> {
  await noteAccess("link_nhs_number", code, justification);
  const clash = (await allPeople()).find((p) => p.nhsNumber === nhsNumber && p.participantCode !== code);
  if (clash) return { ok: false, conflict: `that NHS number is already linked to ${clash.participantCode}` };
  const row = await db.people.get(code);
  if (!row) return { ok: false, conflict: "no record for that code" };
  const person = await openPerson(row);
  await db.people.put(await sealPerson({ ...person, nhsNumber, nhsSource: source }));
  return { ok: true };
}
