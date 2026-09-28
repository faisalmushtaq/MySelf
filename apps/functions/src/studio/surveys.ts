import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { compareVersions } from "@myself/release/gate";
import { verifyRawManifestHash, type ReleaseManifest } from "@myself/schema";
import {
  emptyDraft,
  extractDraft,
  manifestIndex,
  MAX_DRAFT_CHARS,
  serialiseDraft,
  type CreateSurveyResponse,
  type ImportLiveResponse,
  type StudioDraft,
  type VersionDoc,
} from "@myself/studio";
import { bundledManifests } from "../releases.js";
import { auditRow, newAuditRef, type AuditActor } from "./audit.js";
import { problem, refuse } from "./errors.js";
import { readReleases, surveyRefs } from "./store.js";

/**
 * Bringing a survey into the Studio: from the live releases in the repository
 * (docs/16 §6), or new — blank or copied from a published version.
 */

export const REPOSITORY_RELEASE_NOTE = "Published from the repository before MySelf Studio";

// ---------------------------------------------------------------------------
// Set up from the live survey
// ---------------------------------------------------------------------------

export interface ImportLiveArgs {
  study: string;
  surveyId: string;
  actor: AuditActor;
  /** The releases to import from; the ones bundled into this build unless a test says otherwise. */
  bundled?: { raw: unknown; manifest: ReleaseManifest }[];
}

/**
 * "Set up from the live survey": the releases already in the repository become
 * the survey's first versions, the release that is live today becomes the
 * live pointer, and the draft starts from it.
 *
 * IDEMPOTENT, AND IT NEVER OVERWRITES. Each document is created only if it is
 * absent, so running it twice — or after the Studio has published since — adds
 * nothing and changes nothing: the pointer, the draft and the survey's live
 * version are only ever set the first time. What it does refuse is a store
 * that contradicts the repository: a version number already recorded with a
 * different release, or a live pointer with no survey behind it. Those need a
 * person, and writing around them would bury the evidence.
 *
 * Every release is verified against its own hash over the raw JSON before it
 * is written, and stored as that JSON, so the store holds exactly what the
 * repository froze and every reader can verify it again.
 *
 * Touches only the Studio's collections. No sitting is read, moved or changed.
 */
export async function importLive(db: Firestore, args: ImportLiveArgs): Promise<ImportLiveResponse> {
  const { study, surveyId, actor } = args;
  const candidates = (args.bundled ?? bundledManifests)
    .filter((b) => b.manifest.composition.key === surveyId)
    .sort((a, b) => compareVersions(a.manifest.release.version, b.manifest.release.version));
  if (candidates.length === 0) {
    throw refuse.notFound(`releases:${surveyId}`, `This build has no released versions of “${surveyId}” to set up from.`);
  }
  for (const c of candidates) {
    if (!(await verifyRawManifestHash(c.raw))) {
      // The build itself is wrong. Nothing is written from a bundle that does
      // not match its own hashes.
      throw new HttpsError("internal", `The bundled release ${c.manifest.release.version} does not match its own hash, so nothing was imported.`);
    }
  }
  const latest = candidates[candidates.length - 1]!;
  const refs = surveyRefs(db, study, surveyId);

  return db.runTransaction(async (tx) => {
    const [survey, pointer, draft] = await tx.getAll(refs.survey, refs.pointer, refs.draft);
    const versionSnaps = await tx.getAll(...candidates.map((c) => refs.version(c.manifest.release.version)));
    const releaseSnaps = await tx.getAll(...candidates.map((c) => refs.release(c.manifest.hash!)));
    const allVersions = await tx.get(refs.versions);

    for (const [i, c] of candidates.entries()) {
      const snap = versionSnaps[i]!;
      if (snap.exists && snap.get("hash") !== c.manifest.hash) {
        throw refuse.invalid(
          `Version ${c.manifest.release.version} of “${surveyId}” is already recorded with a different release, so nothing was imported. Tell the study's technical lead.`,
          [problem("import.version_conflict", `Version ${c.manifest.release.version} is recorded as ${String(snap.get("hash"))}, but the repository's release is ${c.manifest.hash}.`)],
        );
      }
    }
    if (!survey!.exists && pointer!.exists) {
      throw refuse.invalid(
        `“${surveyId}” has a live version but no survey record, so nothing was imported. Tell the study's technical lead.`,
        [problem("import.orphan_pointer", "The live pointer exists without its survey.")],
      );
    }
    if (survey!.exists && !versionSnaps.some((s) => s!.exists && s!.get("source") === "repository")) {
      // Made in the Studio under the same ID: its history is its own, and
      // grafting the repository's releases onto it would give one survey two.
      throw refuse.invalid(
        `A survey with the ID “${surveyId}” was created in the Studio, so it can't also be set up from the live survey.`,
        [problem("import.not_imported", `“${surveyId}” already exists and was not set up from the live survey.`)],
      );
    }

    const imported: string[] = [];
    for (const [i, c] of candidates.entries()) {
      const { release } = c.manifest;
      const hash = c.manifest.hash!;
      const publishedAt = Timestamp.fromDate(new Date(release.publishedAt));
      if (!releaseSnaps[i]!.exists) {
        const json = JSON.stringify(c.raw);
        tx.create(refs.release(hash), {
          surveyId,
          study,
          hash,
          version: release.version,
          releaseKey: release.key,
          engineVersion: release.engineVersion,
          manifest: json,
          bytes: Buffer.byteLength(json, "utf8"),
          publishedAt,
        });
      }
      if (!versionSnaps[i]!.exists) {
        const index = manifestIndex(c.raw);
        const versionDoc: VersionDoc = {
          surveyId,
          version: release.version,
          hash,
          releaseKey: release.key,
          engineVersion: release.engineVersion,
          releaseNote: REPOSITORY_RELEASE_NOTE,
          changeSummary: null,
          bump: null,
          itemKeys: index.itemKeys,
          variables: index.variables,
          source: "repository",
          draftRevision: null,
          basedOnVersion: null,
          authors: [],
          publishedAt: publishedAt as unknown as VersionDoc["publishedAt"],
          publishedBy: "repository",
          publishedByEmail: null,
          manifestPublishedAt: release.publishedAt,
        };
        tx.create(refs.version(release.version), versionDoc);
        imported.push(release.version);
      }
    }

    const liveRelease = latest.manifest.release;
    const liveHash = latest.manifest.hash!;
    const livePublishedAt = Timestamp.fromDate(new Date(liveRelease.publishedAt));
    let active: string;
    if (!survey!.exists) {
      tx.create(refs.pointer, {
        surveyId,
        study,
        hash: liveHash,
        version: liveRelease.version,
        releaseKey: liveRelease.key,
        engineVersion: liveRelease.engineVersion,
        generation: 1,
        publishedAt: livePublishedAt,
      });
      const versionCount = new Set([...allVersions.docs.map((d) => d.id), ...candidates.map((c) => c.manifest.release.version)]).size;
      tx.create(refs.survey, {
        surveyId,
        study,
        title: latest.manifest.composition.title,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: actor.uid,
        active: {
          version: liveRelease.version,
          hash: liveHash,
          releaseKey: liveRelease.key,
          generation: 1,
          publishedAt: livePublishedAt,
          publishedBy: "repository",
          publishedByEmail: null,
        },
        latestVersion: liveRelease.version,
        versionCount,
        draftEditors: [],
      });
      active = liveRelease.version;
    } else {
      // Set up before: its live version and its draft are the Studio's now.
      // Only the record of how many versions exist follows what was added.
      const existing = survey!.data() as { latestVersion?: string | null; active?: { version?: string } | null };
      active = existing.active?.version ?? "";
      if (imported.length > 0) {
        const versions = new Set([...allVersions.docs.map((d) => d.id), ...imported]);
        let highest = existing.latestVersion ?? null;
        for (const v of versions) if (highest === null || compareVersions(v, highest) > 0) highest = v;
        tx.update(refs.survey, { versionCount: versions.size, latestVersion: highest });
      }
    }

    if (!draft!.exists) {
      const content = serialiseDraft(extractDraft(latest.raw));
      tx.create(refs.draft, {
        surveyId,
        revision: 1,
        content,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actor.uid,
        updatedByEmail: actor.email ?? "",
        basedOn: { version: liveRelease.version, hash: liveHash },
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    const changed = imported.length > 0 || !survey!.exists || !draft!.exists;
    if (changed) {
      tx.create(
        newAuditRef(db, study),
        auditRow("survey.imported", actor, surveyId, surveyId, {
          imported,
          active,
          createdSurvey: !survey!.exists,
          createdDraft: !draft!.exists,
        }),
      );
    }
    return { surveyId, imported, active };
  });
}

// ---------------------------------------------------------------------------
// A new survey
// ---------------------------------------------------------------------------

export interface CreateSurveyArgs {
  study: string;
  surveyId: string;
  title: string;
  from?: { surveyId: string; version: string } | null;
  actor: AuditActor;
}

/**
 * A new survey, with a draft to edit and nothing published.
 *
 * Copied from a published version, the draft remembers where it came from
 * (`basedOn`): the first publish of the new survey checks its licensed and
 * protected content against that release, so a copy cannot be the way round
 * the locks (see `lockBaseline`).
 */
export async function createSurvey(db: Firestore, args: CreateSurveyArgs): Promise<CreateSurveyResponse> {
  const { study, surveyId, title, from, actor } = args;
  const refs = surveyRefs(db, study, surveyId);

  return db.runTransaction(async (tx) => {
    const [survey, draft, pointer] = await tx.getAll(refs.survey, refs.draft, refs.pointer);
    if (survey!.exists || draft!.exists || pointer!.exists) {
      throw refuse.invalid(`There is already a survey with the ID “${surveyId}”. Choose another ID.`, [
        problem("survey.exists", `The survey ID “${surveyId}” is taken.`, { kind: "survey", field: "surveyId" }),
      ], [], "already-exists");
    }

    let content: StudioDraft;
    let basedOn: { version: string; hash: string } | null = null;
    if (from) {
      const sourceRefs = surveyRefs(db, study, from.surveyId);
      const versionSnap = await tx.get(sourceRefs.version(from.version));
      if (!versionSnap.exists) {
        throw refuse.notFound(`version:${from.surveyId}@${from.version}`, `Version ${from.version} of “${from.surveyId}” has not been published, so it can't be copied.`);
      }
      const hash = versionSnap.get("hash") as string;
      const release = (await readReleases(tx, sourceRefs, [hash])).get(hash)!;
      content = extractDraft(release.raw);
      content.surveyId = surveyId;
      content.composition = { ...content.composition, key: surveyId, title };
      basedOn = { version: from.version, hash };
    } else {
      content = emptyDraft({ surveyId, study, title });
    }
    const json = serialiseDraft(content);
    if (json.length > MAX_DRAFT_CHARS) {
      throw refuse.invalid("That version is too large to copy into a draft.", [problem("draft.too_large", "The copied draft would be over the size limit.")]);
    }

    tx.create(refs.survey, {
      surveyId,
      study,
      title,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: actor.uid,
      active: null,
      latestVersion: null,
      versionCount: 0,
      draftEditors: [],
    });
    tx.create(refs.draft, {
      surveyId,
      revision: 1,
      content: json,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.uid,
      updatedByEmail: actor.email ?? "",
      basedOn,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(
      newAuditRef(db, study),
      auditRow("survey.created", actor, surveyId, surveyId, {
        title,
        from: from?.surveyId ?? null,
        fromVersion: from?.version ?? null,
        fromHash: basedOn?.hash ?? null,
      }),
    );
    return { surveyId };
  });
}
