import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { buildRelease, PublishGateError } from "@myself/release";
import { requiredEngineVersion } from "@myself/release/gate";
import { verifyRawManifestHash, type ReleaseManifest } from "@myself/schema";
import {
  checkChosenVersion,
  compileDraft,
  describeError,
  diffDrafts,
  importedReleases,
  importsForVersion,
  lockVouchers,
  manifestIndex,
  MAX_IMPORTED_RELEASES,
  parseDraft,
  publishedProtocols,
  publishedScaleCodes,
  reservedFrom,
  suggestBump,
  validateDraft,
  type Bump,
  type Issue,
  type PublicReleaseDoc,
  type PublishResponse,
  type StudioDraft,
  type VersionDoc,
} from "@myself/studio";
import { bundledManifests } from "../releases.js";
import { lookupStudy } from "../studies.js";
import { auditRow, newAuditRef, type AuditActor } from "./audit.js";
import { problem, refuse } from "./errors.js";
import {
  draftOf,
  highestVersion,
  historyHashes,
  identityIssues,
  assetEscapes,
  licenceEscapes,
  lockBaseline,
  readReleases,
  readReleasesAt,
  readSurveyState,
  releaseAtKey,
  surveyRefs,
  type ReleaseAt,
  type VerifiedRelease,
} from "./store.js";

/**
 * Publishing a draft as a new version of a live children's survey (docs/16 §5.5).
 *
 * This is the one place a survey participants will see can change, so it is
 * written to be boring: every check the editor showed is run again here, on
 * the server, against the history as it stands inside the transaction, and
 * then everything is written together or not at all.
 *
 * ONE TRANSACTION. The draft revision the publisher reviewed, the version
 * number, validation, the publish gate, the frozen release, the version record,
 * the live pointer, the survey summary, the draft's provenance and the audit
 * row. A publish that fails at any point leaves nothing behind; two publishes
 * racing from the same draft resolve to one, because the loser's transaction
 * re-reads a history in which the winner's version is live and finds nothing
 * left to publish.
 *
 * NOTHING THE CALLER SAYS ABOUT THEMSELVES IS USED. Who published is the
 * verified caller; when is the server's clock (and, inside the release, this
 * function's clock — never the browser's). The release names the publisher by
 * uid only (`studio:<uid>`): the manifest is public, and an email address in it
 * would be published to every device.
 *
 * RETRIES ARE SAFE. A version that already exists for the same draft revision
 * is returned as `alreadyPublished` rather than refused, so a publisher whose
 * connection dropped after the commit can simply press Publish again.
 */

/** Firestore's document limit is 1 MiB; this leaves room for the rest of the document. */
export const MAX_MANIFEST_BYTES = 900_000;

export interface PublishArgs {
  study: string;
  surveyId: string;
  expectedRevision: number;
  version: string;
  releaseNote: string;
  actor: AuditActor;
  /** The function's clock, for the release's `publishedAt`. */
  now?: () => Date;
}

function stripR(version: string): string {
  return version.startsWith("r") ? version.slice(1) : version;
}

/** Which part of the number the chosen version actually moves. */
export function bumpTaken(latest: string | null, chosen: string, required: Bump): Bump {
  if (latest === null) return required;
  const [a1 = 0, b1 = 0] = stripR(latest).split(".").map(Number);
  const [a2 = 0, b2 = 0] = chosen.split(".").map(Number);
  if (a2 > a1) return "major";
  if (a2 === a1 && b2 > b1) return "minor";
  return "patch";
}

/**
 * Who wrote the draft being published: everyone the draft trigger has added
 * since the last publish, and the person who saved this very revision.
 *
 * The trigger runs a moment after each save, and it deliberately adds nobody
 * for a save a published version already includes (so they are not credited
 * with the NEXT version). A publish pressed within that moment of the last
 * save would otherwise credit neither version with it. The draft document
 * names that saver itself — `updatedByEmail`, which the rules force to be the
 * saver's own list key — so it is read from there. Keyed as the trigger keys
 * editors: the address, or `uid:` for a saver without one.
 */
export function authorsOf(draftEditors: unknown, draft: { updatedBy?: unknown; updatedByEmail?: unknown }): string[] {
  const authors = Array.isArray(draftEditors) ? draftEditors.filter((e): e is string => typeof e === "string") : [];
  const saver =
    typeof draft.updatedByEmail === "string" && draft.updatedByEmail
      ? draft.updatedByEmail
      : typeof draft.updatedBy === "string" && draft.updatedBy
        ? `uid:${draft.updatedBy}`
        : null;
  if (saver && !authors.includes(saver)) authors.push(saver);
  return authors;
}

/**
 * Where an issue is, in a few words: the question's ID, else its block or its
 * section, else the screen. Validation's messages don't name the place ("Add
 * the question text") — the editor shows each under its place — but the
 * refusal is one sentence on its own, so it says where.
 */
export function placeOfIssue(issue: Issue, draft?: StudioDraft): string | null {
  const at = issue.location;
  if (at.itemKey) return at.itemKey;
  if (at.kind === "block" && at.refKey) {
    const name = (draft?.instruments[at.refKey] as { name?: unknown } | undefined)?.name;
    return `block “${typeof name === "string" && name ? name : at.refKey}”`;
  }
  if (at.kind === "mystory") return "MyStory";
  if (at.sectionKey) {
    const title = draft?.composition.sections.find((s) => s.key === at.sectionKey)?.title;
    return title ? `section “${title}”` : `section ${at.sectionKey}`;
  }
  if (at.kind === "welcome") return "start screen";
  if (at.kind === "completion") return "completion screen";
  return null;
}

export function describeRefusedDraft(issues: Issue[], draft?: StudioDraft): string {
  const errors = issues.filter((i) => i.severity === "error");
  const firstIssue = errors[0];
  const place = firstIssue ? placeOfIssue(firstIssue, draft) : null;
  const first = `${firstIssue?.message ?? ""}${place ? ` (${place})` : ""}`;
  return errors.length === 1
    ? `This draft can't be published: ${first}`
    : `This draft can't be published: there are ${errors.length} problems to fix first, starting with: ${first}`;
}

export async function publish(db: Firestore, args: PublishArgs): Promise<PublishResponse> {
  const { study, surveyId, expectedRevision, version, releaseNote, actor } = args;
  const now = args.now ?? (() => new Date());
  const refs = surveyRefs(db, study, surveyId);

  return db.runTransaction(async (tx) => {
    const state = await readSurveyState(tx, refs);
    if (!state.draft) throw refuse.notFound(`draft:${surveyId}`, `There is no draft of the survey “${surveyId}” to publish.`);
    if (!state.survey) throw refuse.notFound(`survey:${surveyId}`, `There is no survey “${surveyId}”.`);

    // A retry of a publish that already landed: the same version, from the
    // same draft revision, through the Studio. Checked before the revision so
    // that a retry still succeeds after somebody has saved again since.
    const existing = state.versions.get(version);
    if (existing && existing.source === "studio" && existing.draftRevision === expectedRevision) {
      // The pointer's generation as it stands. If somebody has rolled back
      // since, it no longer names this hash, and the Studio's read-back of
      // the pointer (which reports success only on seeing the hash) says so.
      return {
        surveyId,
        version,
        hash: existing.hash,
        releaseKey: existing.releaseKey,
        generation: state.pointer?.generation ?? 0,
        alreadyPublished: true,
      };
    }
    if (state.draft.revision !== expectedRevision) throw refuse.conflict(state.draft.revision);
    if (existing) throw refuse.versionTaken(version);

    // Every release this survey has published, verified, plus the one a
    // never-published survey was created from — in its own study's store,
    // which for a copy from another study space is that study's (D-57).
    const releases = await readReleases(tx, refs, historyHashes(state));
    const activeRelease: VerifiedRelease | null = state.survey.active ? releases.get(state.survey.active.hash) ?? null : null;
    const basedOnAt: ReleaseAt | null = state.draft.basedOn ? { study: state.draft.basedOn.study ?? study, hash: state.draft.basedOn.hash } : null;
    let origin: VerifiedRelease | null = null;
    if (!activeRelease && basedOnAt) origin = await readOrigin(tx, db, refs, study, basedOnAt);

    let draft: StudioDraft;
    try {
      draft = parseDraft(state.draft.content);
    } catch (error) {
      throw refuse.invalid(`The saved draft can't be read, so it can't be published: ${describeError(error)}`, [
        problem("draft.unreadable", `The saved draft can't be read: ${describeError(error)}. Restore it from a published version.`),
      ]);
    }

    // The releases the draft says it copied from (docs/16 §12.4), each read
    // from its own study's store and verified against its hash. Naming one
    // proves nothing by itself: it vouches only for content that matches
    // what it froze, exactly, and only once it has been read and verified.
    const known = new Map<string, VerifiedRelease>();
    for (const r of releases.values()) known.set(releaseAtKey({ study, hash: r.hash }), r);
    if (origin && basedOnAt) known.set(releaseAtKey(basedOnAt), origin);
    const imported = await readImported(tx, db, study, draft, known);
    const vouching = imported.map((i) => i.release);
    const vouchingDrafts = vouching.flatMap((r) => {
      // A release too old for today's schema (docs/16 R12) is not one the
      // Studio could have copied from, and so vouches for nothing.
      try {
        return [draftOf(r)];
      } catch {
        return [];
      }
    });

    // The same validation the editor runs, with the same context — the live
    // version as the baseline, every ID, code and MyStory protocol ever
    // published, and the same vouchers for copied questionnaires (the
    // instrument library and the releases above) — plus the checks only the
    // server can be trusted with.
    const baseline = activeRelease ? draftOf(activeRelease) : null;
    const versions = [...state.versions.values()];
    const published = [...releases.values()].map((r) => r.raw);
    const copiedFrom = vouching.map((r) => r.raw);
    const issues: Issue[] = [
      ...identityIssues(draft, surveyId, study),
      // A licence is the library's and the releases', never the draft's.
      ...licenceEscapes(draft, [...published, ...(origin ? [origin.raw] : []), ...copiedFrom, { instruments: LIBRARY.reference }]),
      ...validateDraft(draft, {
        reserved: reservedFrom(versions),
        baseline: baseline ?? lockBaseline(origin ? draftOf(origin) : null, draft),
        publishedScaleCodes: publishedScaleCodes(published),
        // A survey copied from another's version may republish the protocol
        // that version froze, exactly as it froze it.
        publishedProtocols: publishedProtocols(origin ? [origin.raw, ...published] : published),
        ...lockVouchers({ releases: vouchingDrafts, library: true, draft }),
      }),
    ];
    if (issues.some((i) => i.severity === "error")) throw refuse.invalid(describeRefusedDraft(issues, draft), issues);

    const summary = diffDrafts(baseline, draft);
    const required = suggestBump(summary);
    if (!required) {
      throw refuse.invalid(
        `Nothing has changed since the live version${state.survey.active ? ` (${state.survey.active.version})` : ""}, so there is nothing to publish.`,
        [problem("publish.no_changes", "The draft is the same as the live version. Make a change before publishing a new version.")],
      );
    }

    const latest = highestVersion(state.survey, state.versions.keys());
    const check = checkChosenVersion(latest, version, required);
    if (!check.ok) {
      if (check.reason === "not_semver") {
        throw refuse.invalid(`“${version}” is not a version number such as 8.0.0.`, [problem("version.not_semver", `“${version}” is not a version number.`, { kind: "survey", field: "version" })], [], "invalid-argument");
      }
      throw refuse.bumpTooSmall(
        required,
        check.minimum,
        check.reason === "not_greater"
          ? `Version ${version} is not above the latest version, ${latest}. Version numbers are never reused; the lowest you can choose is ${check.minimum}.`
          : `These changes need at least a ${required} version, so the lowest you can choose is ${check.minimum}.`,
      );
    }

    // Freeze. The gate has already run inside validation; if it still refuses
    // (it is the last word), its refusals are returned verbatim.
    let manifest: ReleaseManifest;
    try {
      const { composition, registries } = compileDraft(draft);
      manifest = buildRelease(composition, registries, {
        version,
        publishedAt: now().toISOString(),
        publishedBy: `studio:${actor.uid}`,
        engineVersion: requiredEngineVersion(composition as Parameters<typeof requiredEngineVersion>[0], registries),
      });
    } catch (error) {
      if (error instanceof PublishGateError) {
        throw refuse.invalid(`The publish check refused this draft: ${error.failures[0] ?? ""}`, [], error.failures);
      }
      throw refuse.invalid(`This draft is not in a form the survey app can use: ${describeError(error)}`, [
        problem("schema.invalid", `Part of the survey is not in a form the survey app can use: ${describeError(error)}`),
      ]);
    }

    // The files the release pins must be ones a release already pinned (D-52):
    // this survey's history, the version it was copied from, or a release in
    // the repository.
    const basedOn = basedOnAt ? (origin ?? (await readOrigin(tx, db, refs, study, basedOnAt))) : null;
    const pinIssues = assetEscapes(manifest.assets, [
      ...published,
      ...(basedOn ? [basedOn.raw] : []),
      ...copiedFrom,
      ...bundledManifests.map((b) => b.raw as Record<string, unknown>),
    ]);
    if (pinIssues.length > 0) throw refuse.invalid(describeRefusedDraft(pinIssues, draft), pinIssues);

    const hash = manifest.hash;
    const json = JSON.stringify(manifest);
    const bytes = Buffer.byteLength(json, "utf8");
    if (!hash || !(await verifyRawManifestHash(JSON.parse(json)))) {
      // Never expected: buildRelease hashes what it returns. Refusing is the
      // only safe response to a release whose stored bytes would not verify.
      const message = "The release was built but did not verify against its own hash, so it was not published.";
      throw refuse.invalid(message, [problem("publish.hash_mismatch", message)], [], "internal");
    }
    if (bytes > MAX_MANIFEST_BYTES) {
      throw refuse.invalid(
        `This survey is too large to publish (${Math.round(bytes / 1000)} kB; the limit is ${MAX_MANIFEST_BYTES / 1000} kB).`,
        [problem("publish.too_large", "The published survey would be too large to store. Remove questions or shorten long text.")],
      );
    }

    // Content-addressed and immutable: if exactly this release is already
    // stored, it is this release, and is left as it is.
    const releaseRef = refs.release(hash);
    const storedRelease = await tx.get(releaseRef);

    const releaseKey = manifest.release.key;
    const engineVersion = manifest.release.engineVersion;
    const generation = (state.pointer?.generation ?? 0) + 1;
    const index = manifestIndex(JSON.parse(json));
    const taken = bumpTaken(latest, version, required);
    // Provenance for the questions this version asks (docs/16 §12.5).
    const imports = importsForVersion(draft);

    // ── Writes: all of them, or (if anything above threw) none ────────────
    if (!storedRelease.exists) {
      const releaseDoc: Omit<PublicReleaseDoc, "publishedAt"> & { publishedAt: FieldValue } = {
        surveyId,
        study,
        hash,
        version,
        releaseKey,
        engineVersion,
        manifest: json,
        bytes,
        publishedAt: FieldValue.serverTimestamp(),
      };
      tx.create(releaseRef, releaseDoc);
    }
    const versionDoc: Omit<VersionDoc, "publishedAt"> & { publishedAt: FieldValue } = {
      surveyId,
      version,
      hash,
      releaseKey,
      engineVersion,
      releaseNote,
      changeSummary: summary,
      bump: taken,
      itemKeys: index.itemKeys,
      variables: index.variables,
      source: "studio",
      draftRevision: expectedRevision,
      basedOnVersion: state.draft.basedOn?.version ?? null,
      ...(imports.length > 0 ? { imports } : {}),
      authors: authorsOf(state.survey.draftEditors, state.draft),
      publishedAt: FieldValue.serverTimestamp(),
      publishedBy: actor.uid,
      publishedByEmail: actor.email,
      manifestPublishedAt: manifest.release.publishedAt,
    };
    tx.create(refs.version(version), versionDoc);
    tx.set(refs.pointer, {
      surveyId,
      study,
      hash,
      version,
      releaseKey,
      engineVersion,
      generation,
      publishedAt: FieldValue.serverTimestamp(),
    });
    tx.update(refs.survey, {
      active: {
        version,
        hash,
        releaseKey,
        generation,
        publishedAt: FieldValue.serverTimestamp(),
        publishedBy: actor.uid,
        publishedByEmail: actor.email,
      },
      latestVersion: version,
      versionCount: state.versions.size + 1,
      draftEditors: [],
    });
    // Provenance only. The content and revision are the editors'; touching
    // them here would turn every open editor's next save into a conflict.
    tx.update(refs.draft, { basedOn: { version, hash } });
    tx.create(
      newAuditRef(db, study),
      auditRow("version.published", actor, surveyId, version, {
        version,
        hash,
        releaseKey,
        releaseNote,
        bump: taken,
        required,
        counts: summary.counts,
        draftRevision: expectedRevision,
        generation,
        copiedFrom: imported.map((i) => i.at),
      }),
    );

    return { surveyId, version, hash, releaseKey, generation, alreadyPublished: false };
  });
}

// ---------------------------------------------------------------------------
// Releases from other study spaces (D-57, docs/16 §12.4, §12.7)
// ---------------------------------------------------------------------------

/** The instrument library as `freezeRelease` freezes it: what a licence is checked against beside the releases. */
const LIBRARY = lockVouchers({ releases: [], library: true });

/**
 * The release a draft was copied from: in this study's store, or — for a copy
 * from another study space — in that one's, once the study is shown to be one
 * this project runs. Verified against its hash either way.
 */
async function readOrigin(tx: Transaction, db: Firestore, refs: ReturnType<typeof surveyRefs>, study: string, at: ReleaseAt): Promise<VerifiedRelease | null> {
  if (at.study === study) return (await readReleases(tx, refs, [at.hash])).get(at.hash) ?? null;
  await requireStudy(db, at.study, "was copied from");
  const read = await readReleasesAt(tx, db, [at], (a, why) =>
    refuse.invalid(
      `This survey was copied from a published version in the study space “${a.study}” (${a.hash.slice(0, 19)}…), and that version can't be checked: ${why}. Nothing was published. Tell the study's technical lead.`,
      [problem("store.release_unreadable", `The release ${a.hash} in “${a.study}” can't be used: ${why}.`)],
    ),
  );
  return read.get(releaseAtKey(at)) ?? null;
}

/** A study space a draft names must be one this project runs; a request or a draft naming one makes nothing so. */
async function requireStudy(db: Firestore, other: string, what: string): Promise<void> {
  const found = await lookupStudy(db, other);
  if (found.kind === "registered") return;
  const why = found.kind === "malformed" ? "isn't a study id" : "doesn't exist";
  const message = `This draft says it ${what} the study space “${found.kind === "malformed" ? found.raw : found.study}”, which ${why}, so it can't be checked. Nothing was published. Remove what was copied from it, or copy it again from the library.`;
  throw refuse.invalid(message, [problem("imports.unknown_study", message)]);
}

/**
 * The releases the draft's provenance names (`importedReleases`), verified —
 * at most MAX_IMPORTED_RELEASES of them, read in one round trip, each from its
 * own study's store. A release already read for this publish is not read
 * again. Refuses the publish, saying which, if any is over the cap, names a
 * study this project does not run, or is missing or fails its hash: a voucher
 * that cannot be checked vouches for nothing, and the researcher needs to know
 * which copy to redo.
 */
async function readImported(
  tx: Transaction,
  db: Firestore,
  study: string,
  draft: StudioDraft,
  known: Map<string, VerifiedRelease>,
): Promise<{ at: ReleaseAt; release: VerifiedRelease }[]> {
  const { releases: named, overLimit } = importedReleases(draft);
  if (overLimit > 0) {
    const message =
      `This draft copies questions from ${named.length + overLimit} different published versions, and one publish can check at most ${MAX_IMPORTED_RELEASES}. ` +
      `Nothing was published. Copy the questions again from fewer versions, or publish part of the change first.`;
    throw refuse.invalid(message, [problem("imports.too_many", message)]);
  }
  for (const other of new Set(named.map((r) => r.study))) if (other !== study) await requireStudy(db, other, "copied questions from");
  const missing = named.filter((at) => !known.has(releaseAtKey(at)));
  const read = await readReleasesAt(tx, db, missing, (at, why) =>
    refuse.invalid(
      `This draft copied questions from a published version that can't be checked (study space “${at.study}”, release ${at.hash.slice(0, 19)}…): ${why}. ` +
        `Nothing was published. Remove what was copied from it, or copy it again from the library.`,
      [problem("imports.release_unreadable", `The release ${at.hash} in “${at.study}” can't be used: ${why}.`)],
    ),
  );
  return named.map((at) => ({ at, release: known.get(releaseAtKey(at)) ?? read.get(releaseAtKey(at))! }));
}
