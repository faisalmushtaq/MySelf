import type { DocumentReference, DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import { compareVersions } from "@myself/release/gate";
import { hashHex, sha256, type ReleaseManifest } from "@myself/schema";
import {
  editTier,
  extractDraft,
  type DraftDoc,
  type Issue,
  type PublishedPointerDoc,
  type StudioDraft,
  type SurveyDoc,
  type VersionDoc,
} from "@myself/studio";
import { readStoredRelease } from "../releases.js";
import { problem, refuse } from "./errors.js";

/**
 * Reading a survey's published history inside a transaction.
 *
 * Publishing, restoring and rolling back all decide from the same facts — the
 * draft, the survey, the live pointer, every version and every release those
 * versions froze — and all of them read those facts inside the transaction
 * that acts on them, so a decision is never made on a history another publish
 * has just changed.
 *
 * A release is believed only once its hash has been recomputed over the stored
 * JSON (`readStoredRelease`, the same check every reader makes). One that is
 * missing or fails that check stops the operation: what IDs are reserved and
 * what the live version says are exactly what a corrupted store would get
 * wrong, and a publish decided on a wrong baseline is the failure this whole
 * design exists to prevent.
 */

export interface SurveyRefs {
  survey: DocumentReference;
  draft: DocumentReference;
  pointer: DocumentReference;
  versions: FirebaseFirestore.CollectionReference;
  version: (version: string) => DocumentReference;
  release: (hash: string) => DocumentReference;
}

export function surveyRefs(db: Firestore, study: string, surveyId: string): SurveyRefs {
  return {
    survey: db.doc(paths.studioSurvey(study, surveyId)),
    draft: db.doc(paths.studioDraft(study, surveyId)),
    pointer: db.doc(paths.publishedPointer(study, surveyId)),
    versions: db.collection(paths.studioVersions(study, surveyId)),
    version: (version) => db.doc(paths.studioVersion(study, surveyId, version)),
    release: (hash) => db.doc(paths.publicRelease(study, hashHex(hash))),
  };
}

/** A release from the store, verified: the raw JSON (what was hashed) and the parsed manifest. */
export interface VerifiedRelease {
  hash: string;
  raw: Record<string, unknown>;
  manifest: ReleaseManifest;
}

/** A stored release document, verified against the hash it is filed under, or the reason it cannot be used. */
export async function verifiedRelease(snapshot: DocumentSnapshot, hash: string): Promise<VerifiedRelease | { refused: string }> {
  if (!snapshot.exists) return { refused: "it is not in the release store" };
  const read = await readStoredRelease(snapshot.data(), hash);
  if ("refused" in read) return read;
  // Verified above over exactly this string, so parsing it again cannot fail.
  const raw = JSON.parse(snapshot.get("manifest") as string) as Record<string, unknown>;
  return { hash, raw, manifest: read.manifest };
}

/** Every release named, verified, in one round trip; refuses the operation if any is missing or wrong. */
export async function readReleases(tx: Transaction, refs: SurveyRefs, hashes: Iterable<string>): Promise<Map<string, VerifiedRelease>> {
  const unique = [...new Set(hashes)];
  const out = new Map<string, VerifiedRelease>();
  if (unique.length === 0) return out;
  for (const hash of unique) {
    // A hash that is not one cannot be a document ID; it can only be a corrupted record.
    if (!sha256.safeParse(hash).success) throw storeRefusal(hash, "it is not a release hash");
  }
  const snapshots = await tx.getAll(...unique.map((h) => refs.release(h)));
  for (const [i, hash] of unique.entries()) {
    const release = await verifiedRelease(snapshots[i]!, hash);
    if ("refused" in release) throw storeRefusal(hash, release.refused);
    out.set(hash, release);
  }
  return out;
}

function storeRefusal(hash: string, why: string) {
  return refuse.invalid(
    `A published version's release (${hash.slice(0, 19)}…) can't be used: ${why}. Nothing was changed. Tell the study's technical lead — the published history needs checking before anything else is published.`,
    [problem("store.release_unreadable", `The release ${hash} can't be used: ${why}.`)],
  );
}

/** The survey, its draft, its live pointer and every version, read in the transaction. */
export interface SurveyState {
  survey: SurveyDoc | null;
  draft: DraftDoc | null;
  pointer: PublishedPointerDoc | null;
  /** Keyed by document ID, which is the version number. */
  versions: Map<string, VersionDoc>;
}

export async function readSurveyState(tx: Transaction, refs: SurveyRefs): Promise<SurveyState> {
  const [survey, draft, pointer] = await tx.getAll(refs.survey, refs.draft, refs.pointer);
  const versions = await tx.get(refs.versions);
  return {
    survey: survey!.exists ? (survey!.data() as SurveyDoc) : null,
    draft: draft!.exists ? (draft!.data() as DraftDoc) : null,
    pointer: pointer!.exists ? (pointer!.data() as PublishedPointerDoc) : null,
    versions: new Map(versions.docs.map((d) => [d.id, d.data() as VersionDoc])),
  };
}

/**
 * The highest version ever published: the survey's own record or the highest
 * version document, whichever is higher. Versions are what reserve a number,
 * so a survey document that had somehow fallen behind cannot let one be reused.
 */
export function highestVersion(survey: SurveyDoc | null, versions: Iterable<string>): string | null {
  let latest: string | null = survey?.latestVersion ?? null;
  for (const v of versions) if (latest === null || compareVersions(v, latest) > 0) latest = v;
  return latest;
}

/** The hashes a survey's history is made of: every version, and whatever is live. */
export function historyHashes(state: SurveyState): string[] {
  const hashes = [...state.versions.values()].map((v) => v.hash);
  if (state.survey?.active) hashes.push(state.survey.active.hash);
  return hashes;
}

// ---------------------------------------------------------------------------
// What a draft is checked against
// ---------------------------------------------------------------------------

/**
 * The baseline licensed and protected content is checked against, for a
 * survey that has never been published.
 *
 * Studio validation compares locked instruments and protected modules with
 * "the published version this draft started from" and, with no such version,
 * checks nothing — so a survey that had never been published could carry a
 * reworded SDQ into its first release. The server closes that. Its baseline is
 * the release the survey was created from (the draft's `basedOn`, which only
 * functions write) reduced to just its locked and protected instruments, the
 * answer options and scoring they use, and no sections — so the lock and
 * protection checks bite exactly as they would against a live version, while
 * the checks that are about THIS survey's own publishing history (reporting
 * labels, linkage items) have nothing to compare with, which is true: it has
 * none. A survey started blank gets the same shape with no instruments, so a
 * licensed instrument in it is reported as introduced without provenance.
 */
export function lockBaseline(origin: StudioDraft | null, draft: StudioDraft): StudioDraft {
  const base: StudioDraft = {
    ...draft,
    composition: { ...(origin ?? draft).composition, sections: [] },
    instruments: {},
    scales: {},
    scoring: {},
    archived: [],
    retiredCodes: {},
    unlocked: {},
    notes: {},
  };
  if (!origin) return base;
  for (const [refKey, def] of Object.entries(origin.instruments)) {
    if (editTier(origin, def.instrument) === "editable") continue;
    base.instruments[refKey] = def;
    for (const form of def.forms) {
      for (const item of form.items) {
        const scale = (item as { scale?: unknown }).scale;
        if (typeof scale === "string" && origin.scales[scale]) base.scales[scale] = origin.scales[scale]!;
      }
    }
    const scoringKey = (def as { scoringKey?: unknown }).scoringKey;
    if (typeof scoringKey === "string" && origin.scoring[scoringKey]) base.scoring[scoringKey] = origin.scoring[scoringKey]!;
  }
  return base;
}

/**
 * Licensed instruments whose licence the draft now says may be modified.
 *
 * Studio validation decides whether an instrument is locked from the DRAFT's
 * own copy of its licence, so an editor who set `licence.modifiable` to "yes"
 * on the SDQ would find every lock check skipped. A licence is not the
 * editor's to change. Any instrument that a published or originating release
 * froze as locked must still be locked in the draft, whatever it now says
 * about itself; this is checked here, on the server, for every publish.
 */
export function licenceEscapes(draft: StudioDraft, published: Iterable<StudioDraft | Record<string, unknown>>): Issue[] {
  const lockedKeys = new Set<string>();
  for (const source of published) {
    const instruments = (source as { instruments?: unknown }).instruments;
    if (!instruments || typeof instruments !== "object") continue;
    for (const def of Object.values(instruments as Record<string, unknown>)) {
      const d = def as { instrument?: unknown; licence?: { modifiable?: unknown } } | null;
      if (d && typeof d.instrument === "string" && d.licence?.modifiable !== "yes") lockedKeys.add(d.instrument);
    }
  }
  const issues: Issue[] = [];
  for (const [refKey, def] of Object.entries(draft.instruments ?? {})) {
    const d = def as { instrument?: unknown; name?: unknown; licence?: { modifiable?: unknown } } | null;
    if (!d || typeof d.instrument !== "string" || !lockedKeys.has(d.instrument)) continue;
    if (d.licence?.modifiable !== "yes") continue;
    const name = typeof d.name === "string" && d.name ? d.name : d.instrument;
    issues.push(
      problem(
        "locked.licence_changed",
        `${name} is a licensed, validated instrument, and its licence in this draft has been changed to say it may be modified. A licence isn't something the Studio can change. Restore the draft from a published version, or remove the instrument.`,
        { kind: "block", refKey },
      ),
    );
  }
  return issues;
}

/**
 * The problems that make a draft the wrong survey rather than a wrong one: a
 * draft claiming to be another survey, or another study's. The release key and
 * the study a manifest carries come from the composition, so publishing such a
 * draft would put another survey's name on this survey's live release.
 */
export function identityIssues(draft: StudioDraft, surveyId: string, study: string): Issue[] {
  const issues: Issue[] = [];
  const composition = draft.composition as { key?: unknown; study?: unknown };
  if (draft.surveyId !== surveyId || composition.key !== surveyId) {
    issues.push(
      problem(
        "survey.key_mismatch",
        `This draft says it is the survey “${String(composition.key ?? draft.surveyId)}”, but it is saved as “${surveyId}”. Restore the draft from a published version of this survey.`,
      ),
    );
  }
  if (composition.study !== study) {
    issues.push(
      problem(
        "survey.study_mismatch",
        `This draft says it belongs to the study “${String(composition.study)}”, but this Studio publishes for “${study}”. Restore the draft from a published version of this survey.`,
      ),
    );
  }
  return issues;
}

/** A draft from a verified release. */
export function draftOf(release: VerifiedRelease): StudioDraft {
  return extractDraft(release.raw);
}
