import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  definedQuestions,
  liveQuestions,
  MAX_DRAFT_CHARS,
  parseDraft,
  publishedScaleCodes,
  serialiseDraft,
  type ActivateVersionResponse,
  type ArchivedQuestion,
  type InstrumentOrModule,
  type PublishedPointerDoc,
  type RestoreVersionResponse,
  type StudioDraft,
  type VersionDoc,
} from "@myself/studio";
import { auditRow, newAuditRef, type AuditActor } from "./audit.js";
import { problem, refuse } from "./errors.js";
import { draftOf, historyHashes, readReleases, readSurveyState, surveyRefs } from "./store.js";

/**
 * Going back: restoring a version into the draft, and making an earlier
 * version live again (docs/16 §5.1, §5.5, §7).
 *
 * The ORDINARY rollback is a restore followed by a publish: the old content
 * becomes the draft, and publishing it makes a new version, with a new number
 * and a full record of why. The EMERGENCY rollback is `activateVersion`, which
 * repoints the live pointer at a release that is already published — no new
 * version, no validation, because nothing new is being released; it needs a
 * reason and is audited like everything else.
 */

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreMerge {
  draft: StudioDraft;
  /** Question IDs the restore moved into the archive rather than lose. */
  archived: string[];
  /** How many published option values were retired because the restored version lacks them. */
  retired: number;
}

function shellOf(def: InstrumentOrModule): InstrumentOrModule {
  return { ...structuredClone(def), forms: def.forms.map((f) => ({ ...structuredClone(f), items: [] })) } as InstrumentOrModule;
}

/**
 * The draft a restore writes: the version's content, with what the Studio
 * knows beyond any one release carried over from the current draft.
 *
 * A restore replaces the survey participants would see; it must not make the
 * Studio forget anything. So:
 *
 * - RETIRED OPTION VALUES are kept, and every option value any version ever
 *   published that the restored lists do not have is retired too. A value is
 *   never reused for a different answer, and going back to an older version is
 *   exactly when a value added later would otherwise look free.
 * - RESEARCHER NOTES are kept: they are about question IDs, which do not
 *   change.
 * - THE ARCHIVE is kept, minus anything the restored version has live again
 *   (a question cannot be both).
 * - EVERY QUESTION THE CURRENT DRAFT HAS THAT THE RESTORED VERSION DOES NOT is
 *   archived rather than dropped — published or not. A published one stays
 *   visible under its ID, which remains reserved in any case (the version
 *   records say so); an unpublished one is somebody's work, and a restore that
 *   silently deleted it could not be undone. Either can be brought back from
 *   the archive, with the option list and instrument it needs kept alongside.
 * - SCORING RULES are the current draft's, for every questionnaire both have.
 *   Scoring is not edited in the Studio — it is corrected in the library and
 *   arrives with a release (r7.2.0 fixed SWEMWBS and STAI-5) — so going back
 *   to older wording must not quietly bring back scoring that was put right,
 *   or leave a draft whose only errors are ones nobody here can fix.
 * - UNLOCKS ARE NOT KEPT. An unlock is an acknowledgement for a change to
 *   protected content; restoring a published version returns that content to
 *   an approved state, and a further change needs a fresh acknowledgement.
 *
 * When the current draft cannot be read at all, the version is restored as it
 * is: restoring is how a broken draft is recovered, so it cannot depend on the
 * broken draft.
 */
export function mergeRestore(
  restored: StudioDraft,
  current: StudioDraft | null,
  opts: { at: string; by: string; publishedCodes: Map<string, Map<number, string>> },
): RestoreMerge {
  const d = structuredClone(restored);
  d.unlocked = {};
  const archivedNow: string[] = [];

  if (current) {
    d.notes = structuredClone(current.notes ?? {});
    for (const [key, definition] of Object.entries(current.scoring ?? {})) {
      if (d.scoring[key]) d.scoring[key] = structuredClone(definition);
    }
    const defined = new Set(definedQuestions(d).map((q) => q.itemKey));
    const kept = (current.archived ?? []).filter((a) => !defined.has(a.itemKey));
    const keptKeys = new Set(kept.map((a) => a.itemKey));

    const placedIn = new Map<string, string>();
    try {
      for (const q of liveQuestions(current)) if (!placedIn.has(q.itemKey)) placedIn.set(q.itemKey, q.sectionKey);
    } catch {
      // A draft whose sections cannot be walked still has its definitions.
    }
    const added: ArchivedQuestion[] = [];
    for (const q of definedQuestions(current)) {
      if (defined.has(q.itemKey) || keptKeys.has(q.itemKey)) continue;
      keptKeys.add(q.itemKey);
      const def = current.instruments[q.refKey];
      added.push({
        itemKey: q.itemKey,
        refKey: q.refKey,
        item: structuredClone(q.item),
        sectionKey: placedIn.get(q.itemKey) ?? null,
        archivedAt: opts.at,
        archivedBy: opts.by,
        ...(!d.instruments[q.refKey] && def ? { instrumentShell: shellOf(def) } : {}),
      });
      archivedNow.push(q.itemKey);
    }
    d.archived = [...structuredClone(kept), ...added];

    // What the archive needs to be restorable: its option lists, scoring and
    // the file a postcode check reads (D-52).
    for (const a of d.archived) {
      const scale = (a.item as { scale?: unknown }).scale;
      if (typeof scale === "string" && !d.scales[scale] && current.scales[scale]) d.scales[scale] = structuredClone(current.scales[scale]!);
      const asset = (a.item as { postcodeCheck?: { asset?: unknown } }).postcodeCheck?.asset;
      if (typeof asset === "string" && !d.assets?.[asset] && current.assets?.[asset]) {
        d.assets = { ...d.assets, [asset]: structuredClone(current.assets[asset]) };
      }
      const scoringKey = (a.instrumentShell as { scoringKey?: unknown } | undefined)?.scoringKey;
      if (typeof scoringKey === "string" && !d.scoring[scoringKey] && current.scoring[scoringKey]) {
        d.scoring[scoringKey] = structuredClone(current.scoring[scoringKey]!);
      }
    }
    d.retiredCodes = structuredClone(current.retiredCodes ?? {});
  }

  let retired = 0;
  for (const [scaleKey, codes] of opts.publishedCodes) {
    const live = new Set((d.scales[scaleKey]?.options ?? []).map((o) => o.code));
    const list = (d.retiredCodes[scaleKey] ??= []);
    for (const [code, label] of codes) {
      if (live.has(code) || list.some((r) => r.code === code)) continue;
      list.push({ code, label, retiredAt: opts.at });
      retired += 1;
    }
    if (list.length === 0) delete d.retiredCodes[scaleKey];
  }
  return { draft: d, archived: archivedNow, retired };
}

export interface RestoreArgs {
  study: string;
  surveyId: string;
  version: string;
  expectedRevision: number;
  actor: AuditActor;
  now?: () => Date;
}

export async function restoreVersion(db: Firestore, args: RestoreArgs): Promise<RestoreVersionResponse> {
  const { study, surveyId, version, expectedRevision, actor } = args;
  const now = args.now ?? (() => new Date());
  const refs = surveyRefs(db, study, surveyId);

  return db.runTransaction(async (tx) => {
    const state = await readSurveyState(tx, refs);
    if (!state.draft) throw refuse.notFound(`draft:${surveyId}`, `There is no draft of the survey “${surveyId}” to restore into.`);
    if (state.draft.revision !== expectedRevision) throw refuse.conflict(state.draft.revision);
    const target = state.versions.get(version);
    if (!target) throw refuse.notFound(`version:${surveyId}@${version}`, `Version ${version} of “${surveyId}” has not been published.`);

    const releases = await readReleases(tx, refs, [...historyHashes(state), target.hash]);
    let current: StudioDraft | null = null;
    try {
      current = parseDraft(state.draft.content);
    } catch {
      current = null;
    }
    const merged = mergeRestore(draftOf(releases.get(target.hash)!), current, {
      at: now().toISOString(),
      by: actor.uid,
      publishedCodes: publishedScaleCodes([...releases.values()].map((r) => r.raw)),
    });
    const content = serialiseDraft(merged.draft);
    if (content.length > MAX_DRAFT_CHARS) {
      throw refuse.invalid(
        "Restoring this version would make the draft too large to save, because of everything kept in its archive. Tell the study's technical lead.",
        [problem("draft.too_large", "The restored draft would be over the size limit.")],
      );
    }

    const revision = expectedRevision + 1;
    tx.update(refs.draft, {
      content,
      revision,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.uid,
      updatedByEmail: actor.email ?? "",
      basedOn: { version, hash: target.hash },
    });
    tx.create(
      newAuditRef(db, study),
      auditRow("draft.restored", actor, surveyId, version, {
        version,
        hash: target.hash,
        fromRevision: expectedRevision,
        toRevision: revision,
        archived: merged.archived,
        retiredCodes: merged.retired,
        currentUnreadable: current === null,
      }),
    );
    return { revision };
  });
}

// ---------------------------------------------------------------------------
// Emergency rollback
// ---------------------------------------------------------------------------

export interface ActivateArgs {
  study: string;
  surveyId: string;
  version: string;
  reason: string;
  actor: AuditActor;
}

export async function activateVersion(db: Firestore, args: ActivateArgs): Promise<ActivateVersionResponse> {
  const { study, surveyId, version, reason, actor } = args;
  const refs = surveyRefs(db, study, surveyId);

  return db.runTransaction(async (tx) => {
    const [surveySnap, pointerSnap, versionSnap] = await tx.getAll(refs.survey, refs.pointer, refs.version(version));
    if (!surveySnap!.exists) throw refuse.notFound(`survey:${surveyId}`, `There is no survey “${surveyId}”.`);
    if (!versionSnap!.exists) throw refuse.notFound(`version:${surveyId}@${version}`, `Version ${version} of “${surveyId}” has not been published.`);
    const target = versionSnap!.data() as VersionDoc;
    const pointer = pointerSnap!.exists ? (pointerSnap!.data() as PublishedPointerDoc) : null;
    const liveHash = pointer?.hash ?? (surveySnap!.get("active.hash") as string | undefined) ?? null;
    if (liveHash === target.hash) {
      throw refuse.invalid(`Version ${version} is already the live version, so nothing was changed.`, [
        problem("version.already_live", `Version ${version} is already live.`),
      ]);
    }
    // Devices will fetch this release by hash the moment the pointer names it,
    // so it must be there and intact before they are sent to it.
    await readReleases(tx, refs, [target.hash]);

    const generation = (pointer?.generation ?? 0) + 1;
    tx.set(refs.pointer, {
      surveyId,
      study,
      hash: target.hash,
      version,
      releaseKey: target.releaseKey,
      engineVersion: target.engineVersion,
      generation,
      publishedAt: target.publishedAt,
    });
    tx.update(refs.survey, {
      active: {
        version,
        hash: target.hash,
        releaseKey: target.releaseKey,
        generation,
        publishedAt: target.publishedAt,
        publishedBy: target.publishedBy,
        publishedByEmail: target.publishedByEmail ?? null,
      },
    });
    tx.create(
      newAuditRef(db, study),
      auditRow("version.activated", actor, surveyId, version, {
        version,
        hash: target.hash,
        previous: pointer ? { version: pointer.version, hash: pointer.hash, generation: pointer.generation } : null,
        reason,
        generation,
      }),
    );
    return { version, hash: target.hash, generation };
  });
}
