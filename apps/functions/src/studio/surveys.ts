import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { compareVersions } from "@myself/release/gate";
import { verifyRawManifestHash, type ReleaseManifest } from "@myself/schema";
import {
  emptyDraft,
  extractDraft,
  manifestIndex,
  MAX_DRAFT_CHARS,
  serialiseDraft,
  type CreateSurveyResponse,
  type DraftDoc,
  type ImportLiveResponse,
  type ImportRecord,
  type StudioDraft,
  type VersionDoc,
} from "@myself/studio";
import { bundledManifests } from "../releases.js";
import { lookupStudy } from "../studies.js";
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
      const message = `The bundled release ${c.manifest.release.version} does not match its own hash, so nothing was imported.`;
      throw refuse.invalid(message, [problem("import.bundle_hash_mismatch", message)], [], "internal");
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
  /** A published version to copy; `study` names another study space to copy from (D-57), absent this one. */
  from?: { surveyId: string; version: string; study?: string | undefined } | null;
  actor: AuditActor;
  /** The function's clock, for the copy's provenance record. */
  now?: () => Date;
}

/** `imp_` and 16 random letters and digits, as the Studio makes them. */
function newImportId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `imp_${Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join("")}`;
}

/**
 * A new survey, with a draft to edit and nothing published.
 *
 * Copied from a published version, the draft remembers where it came from
 * (`basedOn`): the first publish of the new survey checks its licensed and
 * protected content against that release, so a copy cannot be the way round
 * the locks (see `lockBaseline`).
 *
 * FROM ANOTHER STUDY SPACE (D-57, docs/16 §12.7) the source must be a study
 * this project runs and the version one published there; its release is read
 * from THAT study's store and verified, and `basedOn` names the study, so the
 * first publish reads it from there too. The copy is this study's survey (its
 * composition says so, or it could never be published here), and carries the
 * source's consent and identity modules unchanged and still protected: the new
 * study's approval must cover them, or they are unlocked with a reason.
 *
 * Either way the copy records, in its provenance (`imports`), which release
 * every question came from, so the version it publishes says so too.
 */
export async function createSurvey(db: Firestore, args: CreateSurveyArgs): Promise<CreateSurveyResponse> {
  const { study, surveyId, title, from, actor } = args;
  const now = args.now ?? (() => new Date());
  const refs = surveyRefs(db, study, surveyId);
  const sourceStudy = from?.study ?? study;
  if (from && sourceStudy !== study) {
    // A request naming a study makes nothing so: it must be in the registry.
    const found = await lookupStudy(db, sourceStudy);
    if (found.kind !== "registered") {
      throw refuse.notFound(`study:${sourceStudy}`, `There's no study space “${sourceStudy}” to copy from. It may have been typed wrongly, or never created.`);
    }
  }

  return db.runTransaction(async (tx) => {
    const [survey, draft, pointer] = await tx.getAll(refs.survey, refs.draft, refs.pointer);
    if (survey!.exists || draft!.exists || pointer!.exists) {
      throw refuse.invalid(`There is already a survey with the ID “${surveyId}”. Choose another ID.`, [
        problem("survey.exists", `The survey ID “${surveyId}” is taken.`, { kind: "survey", field: "surveyId" }),
      ], [], "already-exists");
    }

    let content: StudioDraft;
    let basedOn: DraftDoc["basedOn"] = null;
    if (from) {
      const sourceRefs = surveyRefs(db, sourceStudy, from.surveyId);
      const versionSnap = await tx.get(sourceRefs.version(from.version));
      if (!versionSnap.exists) {
        const where = sourceStudy === study ? "" : ` in the study space “${sourceStudy}”`;
        throw refuse.notFound(
          `version:${sourceStudy === study ? "" : `${sourceStudy}/`}${from.surveyId}@${from.version}`,
          `Version ${from.version} of “${from.surveyId}”${where} has not been published, so it can't be copied.`,
        );
      }
      const hash = versionSnap.get("hash") as string;
      const release = (await readReleases(tx, sourceRefs, [hash])).get(hash)!;
      content = extractDraft(release.raw);
      content.surveyId = surveyId;
      content.composition = { ...content.composition, key: surveyId, title, study };
      const items = Object.fromEntries(
        Object.values(content.instruments).flatMap((def) => def.forms[0]!.items.map((item) => [`${def.instrument}.${item.key}`, `${def.instrument}.${item.key}`])),
      );
      const record: ImportRecord = {
        id: newImportId(),
        at: now().toISOString(),
        by: actor.uid,
        byEmail: actor.email ?? "",
        origin: { kind: "release", study: sourceStudy, surveyId: from.surveyId, version: from.version, hash },
        items,
      };
      content.imports = [record];
      basedOn = sourceStudy === study ? { version: from.version, hash } : { version: from.version, hash, study: sourceStudy };
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
        fromStudy: from ? sourceStudy : null,
      }),
    );
    return { surveyId };
  });
}
