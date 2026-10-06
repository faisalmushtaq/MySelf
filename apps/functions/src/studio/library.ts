import { FieldValue, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import { compareVersions } from "@myself/release/gate";
import {
  MAX_MODULE_CHARS,
  moduleContent,
  moduleContentHash,
  moduleProblems,
  questionCount,
  type LibraryCatalogueResponse,
  type LibraryModuleDoc,
  type LibraryModuleResponse,
  type LibraryModulesResponse,
  type LibraryModuleSummary,
  type LibraryModuleVersionDoc,
  type LibraryModuleVersionSummary,
  type LibrarySaveModuleResponse,
  type LibrarySetModuleResponse,
  type StoredTime,
  type StudioFragment,
  type SurveyDoc,
  type VersionDoc,
} from "@myself/studio";
import { STUDY } from "../apps.js";
import { registeredStudies } from "../studies.js";
import { auditRow, newAuditRef, type AuditActor } from "./audit.js";
import { problem, refusal, refuse } from "./errors.js";

/**
 * The item library's server side (D-57, docs/16 §12): the shelf of every
 * study's published surveys, and the saved modules.
 *
 * WHAT IS READ ACROSS STUDIES, AND WHAT IS NOT (§12.8). The catalogue lists
 * every registered study's surveys and their published versions — the
 * questionnaires participants are shown, already public by hash — for anyone
 * with Studio access to the study they are working in. Never a draft, a
 * sitting, a narrative or another study's list of people: only survey and
 * version documents are read.
 *
 * SAVED MODULES are project-wide, under `studioLibrary`, which the rules close
 * to every browser: these functions alone read and write it. A save is one
 * transaction — the immutable version, the module record and the audit row in
 * the saving study's trail — and is refused when it was made against a
 * version that is no longer the latest, so two people can never silently
 * overwrite each other. What is stored is checked first (`moduleProblems`):
 * editable content only, well formed, within the size limit, and testing
 * nothing outside itself.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A stored time as ISO: a Firestore timestamp, or a string already. Empty when there is none. */
export function isoOf(value: unknown): string {
  if (typeof value === "string") return value;
  const t = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number } | null | undefined;
  if (t && typeof t.toDate === "function") return t.toDate().toISOString();
  if (t && typeof t.seconds === "number") return new Date(t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6)).toISOString();
  return "";
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A module record read defensively: it is data, not a type. */
function moduleRecord(snap: DocumentSnapshot): LibraryModuleDoc {
  const d = (snap.data() ?? {}) as Record<string, unknown>;
  return {
    moduleId: snap.id,
    title: str(d["title"], snap.id),
    description: str(d["description"]),
    tags: Array.isArray(d["tags"]) ? (d["tags"] as unknown[]).filter((t): t is string => typeof t === "string") : [],
    latestVersion: typeof d["latestVersion"] === "number" ? d["latestVersion"] : 0,
    retired: d["retired"] === true,
    createdAt: d["createdAt"] as StoredTime,
    createdBy: str(d["createdBy"]),
    createdByEmail: str(d["createdByEmail"]),
    updatedAt: d["updatedAt"] as StoredTime,
    updatedBy: str(d["updatedBy"]),
  };
}

function versionSummary(snap: DocumentSnapshot): LibraryModuleVersionSummary {
  const d = (snap.data() ?? {}) as Record<string, unknown>;
  const source = (d["source"] ?? {}) as Record<string, unknown>;
  return {
    version: typeof d["version"] === "number" ? d["version"] : Number(snap.id),
    note: str(d["note"]),
    savedAt: isoOf(d["savedAt"]),
    savedByEmail: str(d["savedByEmail"]),
    contentHash: str(d["contentHash"]),
    questionCount: typeof d["questionCount"] === "number" ? d["questionCount"] : 0,
    source: {
      study: str(source["study"]),
      surveyId: str(source["surveyId"]),
      draftRevision: typeof source["draftRevision"] === "number" ? source["draftRevision"] : null,
    },
  };
}

function summaryOf(module: LibraryModuleDoc, latest: LibraryModuleVersionSummary | null): LibraryModuleSummary {
  return {
    moduleId: module.moduleId,
    title: module.title,
    description: module.description,
    tags: module.tags,
    latestVersion: module.latestVersion,
    retired: module.retired,
    createdByEmail: module.createdByEmail,
    updatedAt: isoOf(module.updatedAt),
    questionCount: latest?.questionCount ?? 0,
    contentHash: latest?.contentHash ?? "",
  };
}

const moduleRef = (db: Firestore, moduleId: string) => db.doc(paths.studioLibraryModule(moduleId));
const versionRef = (db: Firestore, moduleId: string, version: number) => db.doc(paths.studioLibraryVersion(moduleId, version));

// ---------------------------------------------------------------------------
// Published surveys, every study's
// ---------------------------------------------------------------------------

/**
 * Every registered study's published surveys, for the "Published surveys"
 * shelf: each study (the default first, registered with or without a
 * document), each of its surveys that has published at least one version,
 * and those versions newest first, with which is live. Survey and version
 * documents only — a survey never published offers nothing to copy, and its
 * draft is never read.
 */
export async function libraryCatalogue(db: Firestore, opts: { defaultStudy?: string } = {}): Promise<LibraryCatalogueResponse> {
  const studies = await registeredStudies(db, opts.defaultStudy ?? STUDY);
  const out: LibraryCatalogueResponse["studies"] = [];
  for (const s of studies) {
    const surveys = await db.collection(paths.studioSurveys(s.study)).get();
    const listed: LibraryCatalogueResponse["studies"][number]["surveys"] = [];
    for (const doc of surveys.docs) {
      const survey = doc.data() as Partial<SurveyDoc>;
      const versions = await db.collection(paths.studioVersions(s.study, doc.id)).get();
      const published = versions.docs
        .map((v) => v.data() as Partial<VersionDoc>)
        .filter((v): v is Partial<VersionDoc> & { version: string; hash: string } => typeof v.version === "string" && typeof v.hash === "string")
        .sort((a, b) => compareVersions(b.version, a.version))
        .map((v) => ({ version: v.version, hash: v.hash, publishedAt: isoOf(v.publishedAt) }));
      if (published.length === 0) continue;
      listed.push({
        surveyId: doc.id,
        title: typeof survey.title === "string" && survey.title ? survey.title : doc.id,
        live: survey.active?.version ?? null,
        versions: published,
      });
    }
    listed.sort((a, b) => a.title.localeCompare(b.title, "en-GB") || a.surveyId.localeCompare(b.surveyId));
    out.push({ study: s.study, title: s.title ?? s.study, status: s.status, surveys: listed });
  }
  return { studies: out };
}

// ---------------------------------------------------------------------------
// Saved modules: reading
// ---------------------------------------------------------------------------

/** The shelf of saved modules, by title; retired ones only when asked for. */
export async function listModules(db: Firestore, opts: { includeRetired?: boolean } = {}): Promise<LibraryModulesResponse> {
  const snap = await db.collection(paths.studioLibrary()).get();
  const modules = snap.docs.map(moduleRecord).filter((m) => m.latestVersion > 0 && (opts.includeRetired || !m.retired));
  const latest = modules.length > 0 ? await db.getAll(...modules.map((m) => versionRef(db, m.moduleId, m.latestVersion))) : [];
  return {
    modules: modules
      .map((m, i) => summaryOf(m, latest[i]?.exists ? versionSummary(latest[i]!) : null))
      .sort((a, b) => a.title.localeCompare(b.title, "en-GB") || a.moduleId.localeCompare(b.moduleId)),
  };
}

function corrupted(moduleId: string, version: number, why: string) {
  const message = `Version ${version} of the module “${moduleId}” can't be used: ${why}. Nothing was changed. Tell the study's technical lead — the library needs checking.`;
  return refuse.invalid(message, [problem("library.version_unreadable", message)]);
}

/**
 * One module, with the version asked for (the latest by default) and its piece,
 * and every version's summary, newest first. The stored content is checked
 * against its hash before it is handed out, and the piece's origin is given
 * that hash: whatever survey copies it records exactly which content it took.
 */
export async function getModule(db: Firestore, args: { moduleId: string; version?: number }): Promise<LibraryModuleResponse> {
  const { moduleId } = args;
  const snap = await moduleRef(db, moduleId).get();
  if (!snap.exists) throw refuse.notFound(`module:${moduleId}`, `There is no module “${moduleId}” in the library.`);
  const module = moduleRecord(snap);
  const version = args.version ?? module.latestVersion;
  const [wanted, latest] = await db.getAll(versionRef(db, moduleId, version), versionRef(db, moduleId, module.latestVersion));
  if (!wanted!.exists) throw refuse.notFound(`module:${moduleId}@${version}`, `The module “${module.title}” has no version ${version}.`);

  const stored = wanted!.data() as Partial<LibraryModuleVersionDoc>;
  if (typeof stored.content !== "string" || typeof stored.contentHash !== "string") throw corrupted(moduleId, version, "it holds no content");
  if ((await moduleContentHash(stored.content)) !== stored.contentHash) throw corrupted(moduleId, version, "its content does not match its hash");
  let fragment: StudioFragment;
  try {
    fragment = JSON.parse(stored.content) as StudioFragment;
  } catch {
    throw corrupted(moduleId, version, "its content is not JSON");
  }
  const origin = fragment.origin as { kind?: unknown; moduleId?: unknown; version?: unknown } | undefined;
  if (origin?.kind !== "module" || origin.moduleId !== moduleId || origin.version !== version) {
    throw corrupted(moduleId, version, "its content says it is a different module or version");
  }
  fragment.origin = { kind: "module", moduleId, version, contentHash: stored.contentHash };

  const versions = await db
    .collection(paths.studioLibraryVersions(moduleId))
    .select("version", "note", "savedAt", "savedByEmail", "contentHash", "questionCount", "source")
    .get();
  return {
    module: summaryOf(module, latest!.exists ? versionSummary(latest!) : null),
    version: { ...versionSummary(wanted!), fragment },
    versions: versions.docs.map(versionSummary).sort((a, b) => b.version - a.version),
  };
}

// ---------------------------------------------------------------------------
// Saved modules: saving
// ---------------------------------------------------------------------------

export interface SaveModuleArgs {
  /** The study the caller is working in, checked: where the save is audited. */
  study: string;
  surveyId: string;
  draftRevision?: number | null;
  create?: { moduleId: string; title: string; description: string; tags: string[] } | null;
  moduleId?: string | null;
  baseVersion?: number | null;
  note: string;
  fragment: unknown;
  actor: AuditActor;
}

/**
 * Save a piece to the library: a new module at version 1 (`create`), or the
 * next version of one (`moduleId`, made from `baseVersion`).
 *
 * ONE TRANSACTION: the version (created, never overwritten), the module record
 * and the audit row in the saving study's trail. A version made from anything
 * but the latest is refused as a conflict, naming the latest, so the second of
 * two people saving at once is told rather than silently overwritten. A
 * retired module takes no new versions until it is brought back.
 */
export async function saveModule(db: Firestore, args: SaveModuleArgs): Promise<LibrarySaveModuleResponse> {
  const { study, surveyId, actor, create } = args;
  const fragment = args.fragment as StudioFragment;
  const problems = moduleProblems(fragment);
  if (problems.length > 0) {
    const first = problems[0]!;
    throw refuse.invalid(
      `This can't be saved to the library: ${first.message.charAt(0).toLowerCase()}${first.message.slice(1)}.${first.hint ? ` ${first.hint}` : ""}`,
      problems,
    );
  }
  const moduleId = create?.moduleId ?? args.moduleId!;
  const count = questionCount(fragment);
  const ref = moduleRef(db, moduleId);

  return db.runTransaction(async (tx) => {
    const [snap, surveySnap] = await tx.getAll(ref, db.doc(paths.studioSurvey(study, surveyId)));
    if (!surveySnap!.exists) throw refuse.notFound(`survey:${surveyId}`, `There is no survey “${surveyId}” in this study space to save from.`);
    let version: number;
    let title: string;
    if (create) {
      if (snap!.exists) {
        throw refuse.invalid(
          `There is already a module with the ID “${moduleId}” in the library. Choose another ID, or save this as a new version of that module.`,
          [problem("library.module_exists", `The module ID “${moduleId}” is taken.`, { kind: "survey", field: "moduleId" })],
          [],
          "already-exists",
        );
      }
      version = 1;
      title = create.title;
    } else {
      if (!snap!.exists) throw refuse.notFound(`module:${moduleId}`, `There is no module “${moduleId}” in the library.`);
      const module = moduleRecord(snap!);
      title = module.title;
      if (module.retired) {
        throw refuse.invalid(
          `“${module.title}” has been retired from the library, so it takes no new versions. Bring it back first, or save this as a new module.`,
          [problem("library.module_retired", `The module “${moduleId}” is retired.`)],
        );
      }
      if (module.latestVersion !== args.baseVersion) {
        throw refusal(
          "aborted",
          `Someone saved a newer version of “${module.title}” (version ${module.latestVersion}) after you opened version ${args.baseVersion}, so nothing was saved. Open the latest version, check it, and save again.`,
          { kind: "conflict", currentRevision: module.latestVersion },
        );
      }
      version = module.latestVersion + 1;
    }

    const { content, contentHash } = await moduleContent(fragment, { moduleId, version });
    if (content.length > MAX_MODULE_CHARS) {
      throw refuse.invalid(`This is too large to save as one module. Save it as two or more modules.`, [
        problem("piece.too_large", `A module can be at most ${MAX_MODULE_CHARS.toLocaleString("en-GB")} characters.`),
      ]);
    }
    const at = FieldValue.serverTimestamp();
    const versionDoc: Omit<LibraryModuleVersionDoc, "savedAt"> & { savedAt: FieldValue } = {
      moduleId,
      version,
      content,
      contentHash,
      note: args.note,
      questionCount: count,
      savedAt: at,
      savedBy: actor.uid,
      savedByEmail: actor.email ?? "",
      source: { study, surveyId, draftRevision: args.draftRevision ?? null },
    };
    tx.create(versionRef(db, moduleId, version), versionDoc);
    if (create) {
      tx.create(ref, {
        moduleId,
        title: create.title,
        description: create.description,
        tags: create.tags,
        latestVersion: 1,
        retired: false,
        createdAt: at,
        createdBy: actor.uid,
        createdByEmail: actor.email ?? "",
        updatedAt: at,
        updatedBy: actor.uid,
      });
    } else {
      tx.update(ref, { latestVersion: version, updatedAt: at, updatedBy: actor.uid });
    }
    tx.create(
      newAuditRef(db, study),
      auditRow("library.module_saved", actor, surveyId, moduleId, {
        moduleId,
        version,
        contentHash,
        title,
        note: args.note,
        questionCount: count,
        created: !!create,
        draftRevision: args.draftRevision ?? null,
      }),
    );
    return { moduleId, version, contentHash };
  });
}

// ---------------------------------------------------------------------------
// Saved modules: describing and retiring
// ---------------------------------------------------------------------------

export interface SetModuleArgs {
  study: string;
  moduleId: string;
  title?: string;
  description?: string;
  tags?: string[];
  retired?: boolean;
  actor: AuditActor & { owner: boolean };
}

/**
 * Change a module's title, description or tags, or retire it or bring it back.
 *
 * Describing is for any editor. Retiring takes a module off the shelf without
 * touching a survey that uses it, and is for the person who first saved it or
 * an owner of the project (§12.6): the module is theirs to withdraw, and
 * nobody else's work disappears from the shelf because one editor tidied up.
 * Nothing is ever deleted. A change to what is already there writes nothing.
 */
export async function setModule(db: Firestore, args: SetModuleArgs): Promise<LibrarySetModuleResponse> {
  const { study, moduleId, actor } = args;
  const ref = moduleRef(db, moduleId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw refuse.notFound(`module:${moduleId}`, `There is no module “${moduleId}” in the library.`);
    const module = moduleRecord(snap);
    const latestSnap = module.latestVersion > 0 ? await tx.get(versionRef(db, moduleId, module.latestVersion)) : null;
    const latest = latestSnap?.exists ? versionSummary(latestSnap) : null;

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (args.title !== undefined && args.title !== module.title) changes["title"] = { from: module.title, to: args.title };
    if (args.description !== undefined && args.description !== module.description) changes["description"] = { from: module.description, to: args.description };
    if (args.tags !== undefined && JSON.stringify(args.tags) !== JSON.stringify(module.tags)) changes["tags"] = { from: module.tags, to: args.tags };
    if (args.retired !== undefined && args.retired !== module.retired) {
      if (!actor.owner && actor.uid !== module.createdBy) {
        throw refuse.forbidden(
          "admin",
          `Only the person who first saved “${module.title}”, or an owner of the project, can ${args.retired ? "retire it" : "bring it back"}.`,
        );
      }
      changes["retired"] = { from: module.retired, to: args.retired };
    }
    if (Object.keys(changes).length === 0) return { module: summaryOf(module, latest) };

    const next: LibraryModuleDoc = { ...module };
    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid };
    for (const [field, { to }] of Object.entries(changes)) {
      update[field] = to;
      (next as unknown as Record<string, unknown>)[field] = to;
    }
    tx.update(ref, update);
    tx.create(newAuditRef(db, study), auditRow("library.module_changed", actor, null, moduleId, { moduleId, changes }));
    // The time is the server's, set on commit; the summary says "now".
    return { module: summaryOf({ ...next, updatedAt: new Date().toISOString() }, latest) };
  });
}
