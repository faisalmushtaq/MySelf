import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { buildRelease, PublishGateError } from "@myself/release";
import { requiredEngineVersion } from "@myself/release/gate";
import { verifyRawManifestHash, type ReleaseManifest } from "@myself/schema";
import {
  checkChosenVersion,
  compileDraft,
  describeError,
  diffDrafts,
  manifestIndex,
  parseDraft,
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
import { auditRow, newAuditRef, type AuditActor } from "./audit.js";
import { problem, refuse } from "./errors.js";
import {
  draftOf,
  highestVersion,
  historyHashes,
  identityIssues,
  licenceEscapes,
  lockBaseline,
  readReleases,
  readSurveyState,
  surveyRefs,
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

function describeRefusedDraft(issues: Issue[]): string {
  const errors = issues.filter((i) => i.severity === "error");
  const first = errors[0]?.message ?? "";
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
    // never-published survey was created from.
    const releases = await readReleases(tx, refs, historyHashes(state));
    const activeRelease: VerifiedRelease | null = state.survey.active ? releases.get(state.survey.active.hash) ?? null : null;
    let origin: VerifiedRelease | null = null;
    if (!activeRelease && state.draft.basedOn) {
      origin = (await readReleases(tx, refs, [state.draft.basedOn.hash])).get(state.draft.basedOn.hash) ?? null;
    }

    let draft: StudioDraft;
    try {
      draft = parseDraft(state.draft.content);
    } catch (error) {
      throw refuse.invalid(`The saved draft can't be read, so it can't be published: ${describeError(error)}`, [
        problem("draft.unreadable", `The saved draft can't be read: ${describeError(error)}. Restore it from a published version.`),
      ]);
    }

    // The same validation the editor runs, with the same context — the live
    // version as the baseline, every ID and code ever published — plus the
    // checks only the server can be trusted with.
    const baseline = activeRelease ? draftOf(activeRelease) : null;
    const versions = [...state.versions.values()];
    const published = [...releases.values()].map((r) => r.raw);
    const issues: Issue[] = [
      ...identityIssues(draft, surveyId, study),
      ...licenceEscapes(draft, origin ? [...published, origin.raw] : published),
      ...validateDraft(draft, {
        reserved: reservedFrom(versions),
        baseline: baseline ?? lockBaseline(origin ? draftOf(origin) : null, draft),
        publishedScaleCodes: publishedScaleCodes(published),
      }),
    ];
    if (issues.some((i) => i.severity === "error")) throw refuse.invalid(describeRefusedDraft(issues), issues);

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
        engineVersion: requiredEngineVersion(composition as Parameters<typeof requiredEngineVersion>[0]),
      });
    } catch (error) {
      if (error instanceof PublishGateError) {
        throw refuse.invalid(`The publish check refused this draft: ${error.failures[0] ?? ""}`, [], error.failures);
      }
      throw refuse.invalid(`This draft is not in a form the survey app can use: ${describeError(error)}`, [
        problem("schema.invalid", `Part of the survey is not in a form the survey app can use: ${describeError(error)}`),
      ]);
    }

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
      }),
    );

    return { surveyId, version, hash, releaseKey, generation, alreadyPublished: false };
  });
}
