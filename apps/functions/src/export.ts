import { onSchedule } from "firebase-functions/v2/scheduler";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getStorage } from "firebase-admin/storage";
import type { Firestore } from "firebase-admin/firestore";
import { joinSession, paths, type ChunkDoc, type SessionDoc } from "@myself/firebase";
import { compareVersions } from "@myself/release/gate";
import type { ReleaseManifest } from "@myself/schema";
import {
  buildBidsExport,
  buildZip,
  emptyDataset,
  ingest,
  type BidsFile,
  type Dataset,
  type DeviceSession,
  type StoredNarrativeRun,
} from "@myself/store";
import { STUDY, research } from "./apps.js";
import { latestRelease, resolveRelease, type ReleaseResolverFn } from "./releases.js";
import { registeredStudies, studyForCall } from "./studies.js";

/**
 * The archival copy, written nightly.
 *
 * Two things a study needs that are commonly conflated: something that restores
 * the system when a mistake deletes it, and something that IS the data in a
 * form anything can read in thirty years. Firestore's own scheduled export is
 * the first. This is the second — the BIDS folder, one file per instrument with
 * its dictionary beside it, written to dated paths so "the dataset as of 1
 * September" is a real object rather than a reconstruction.
 *
 * Cloud Storage object names contain slashes and the console renders them as
 * folders, so what lands is browsable exactly like a directory tree.
 */

/**
 * Every narrative run stored for this study.
 *
 * Read separately because they are stored separately — an analysis that does
 * not want narratives never pays to read them, and a study that never ran the
 * module gets an empty collection and no files. Filtering happens in the
 * export builder, which knows which sittings made it into the dataset.
 */
export async function readNarratives(study: string): Promise<StoredNarrativeRun[]> {
  const snap = await research().collection(paths.narratives(study)).get();
  return snap.docs.map((d) => d.data() as StoredNarrativeRun);
}

/** A sitting left out because nothing could say which release it was collected under. */
export interface UnreadableSitting {
  sessionId: string;
  releaseHash: string;
}

export interface StudyDataset {
  dataset: Dataset;
  /** Sittings read from the database, before any were found unreadable. */
  sittings: number;
  /** Left out of the dataset, and named, because their release is unknown. */
  unreadable: UnreadableSitting[];
  /** The releases the dataset was actually read through, one per hash. */
  releases: ReleaseManifest[];
}

/**
 * Read every sitting and derive the dataset, the same way the browser does.
 *
 * The db and the resolver are parameters so a test can hand in a stand-in
 * Firestore and a cold resolver; the scheduled export takes the defaults.
 */
export async function buildStudyDataset(
  study: string,
  db: Firestore = research(),
  resolve: ReleaseResolverFn = resolveRelease,
): Promise<StudyDataset> {
  // Every sitting, filtered in code rather than in the query.
  //
  // Firestore's `!=` operator excludes documents that do not have the field at
  // all, so `where("quarantined", "!=", true)` returns only the sittings that
  // were explicitly marked false — which, before this was found, was none of
  // them. The export would have been silently near-empty. At study sizes the
  // whole collection is a cheap read, and filtering here cannot be walked into
  // that way.
  const snap = await db.collection(paths.sessions(study)).get();

  const sessions: DeviceSession[] = [];
  let quarantinedCount = 0;
  for (const document of snap.docs) {
    const data = document.data() as SessionDoc;
    if (data.quarantined === true) {
      quarantinedCount += 1;
      continue;
    }
    const chunks: ChunkDoc[] =
      data.chunkCount > 0
        ? (await db.collection(paths.sessionChunks(study, data.sessionId)).get()).docs.map((c) => c.data() as ChunkDoc)
        : [];
    try {
      sessions.push(joinSession(data, chunks));
    } catch (error) {
      // A sitting whose chunks are incomplete is left out and shouted about
      // rather than exported short. The device still holds its copy, so this
      // is recoverable — quietly exporting a truncated log would not be.
      logger.error("incomplete sitting left out of the export", {
        sessionId: data.sessionId,
        expectedChunks: data.chunkCount,
        found: chunks.length,
        error: String(error),
      });
    }
  }

  const corrections = await db.collection(paths.corrections(study)).get();
  const aliases: Record<string, string> = {};
  for (const c of corrections.docs) {
    const data = c.data() as { wrongCode: string; rightCode: string; withdrawnAt?: unknown };
    if (!data.withdrawnAt) aliases[data.wrongCode] = data.rightCode;
  }

  const assignmentDocs = await db.collection(paths.assignments(study)).get();
  const assignments: Record<string, string> = {};
  for (const a of assignmentDocs.docs) {
    assignments[a.id] = (a.data() as { participantCode: string }).participantCode;
  }

  // Grouped by the release each sitting was collected under, oldest first, so
  // waves are numbered in the order they happened rather than the order the
  // documents came back.
  const groups = new Map<string, DeviceSession[]>();
  for (const s of sessions) {
    const list = groups.get(s.releaseHash);
    if (list) list.push(s);
    else groups.set(s.releaseHash, [s]);
  }

  let dataset = emptyDataset();
  const unreadable: UnreadableSitting[] = [];
  const releases: ReleaseManifest[] = [];
  for (const [hash, group] of [...groups.entries()].sort((a, b) => {
    const earliest = (rows: DeviceSession[]) => rows.reduce((m, r) => (r.startedAt < m ? r.startedAt : m), rows[0]!.startedAt);
    return earliest(a[1]).localeCompare(earliest(b[1]));
  })) {
    const ordered = [...group].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    // By hash, from the bundle or the release store — never "the latest
    // release" in its place. That fallback used to be here, and it read a
    // sitting through questions it was not asked, codes and all, into a file
    // that looked complete (D-35). A release nobody can find leaves its
    // sittings out, logged and listed in the export, and they stay in the
    // database to be read once the release is found.
    const resolved = await resolve(db, study, hash);
    if (!resolved) {
      logger.error("sittings under an unknown release were left out of the export", {
        releaseHash: hash,
        sittings: ordered.length,
      });
      unreadable.push(...ordered.map((s) => ({ sessionId: s.sessionId, releaseHash: hash })));
      continue;
    }
    releases.push(resolved.manifest);
    const result = ingest(ordered, {
      manifest: resolved.manifest,
      study,
      existing: dataset,
      aliases,
      assignments,
    });
    dataset = result.dataset;
    for (const collision of result.collisions) {
      // An export built over an unresolved twin collision describes two
      // children as one. It still runs — withholding the export helps nobody —
      // but it says so where somebody will see it.
      logger.error("unresolved code collision in export", collision);
    }
  }

  if (quarantinedCount > 0) {
    logger.warn("quarantined sittings left out of the export", { quarantinedCount });
  }
  return { dataset, sittings: sessions.length, unreadable, releases };
}

/**
 * The release the dataset-level files describe: the newest, by version, of
 * those the export was read through — and never older than the one compiled
 * in, so an export whose releases are all bundled describes exactly what it
 * described before the release store existed. On a tie the compiled-in one is
 * kept, for the same reason.
 *
 * A LIMITATION THIS DOES NOT REMOVE. `buildBidsExport` takes one manifest, so
 * `dataset_description.json` names one release and every
 * `phenotype/<instrument>.json` dictionary is written from it. The data files
 * are right whatever this picks — each sitting was ingested through its own
 * release above — but a question reworded between releases is described in
 * its newest wording, and a variable only an older release asked has no
 * description at all, only its `_status` column. Choosing the newest release
 * present, rather than the compiled-in one, at least means questions added
 * from the Studio are described. Per-release dictionaries need a change to
 * the BIDS builder in @myself/store.
 */
export function datasetManifest(
  present: readonly ReleaseManifest[],
  compiledIn: ReleaseManifest | undefined = latestRelease,
): ReleaseManifest | undefined {
  let newest = compiledIn;
  for (const manifest of present) {
    if (!newest || compareVersions(manifest.release.version, newest.release.version) > 0) newest = manifest;
  }
  return newest;
}

/**
 * Every file the export writes, before any of it is written.
 *
 * `unreadable.json` is added only when some sitting was left out, so an
 * export with nothing missing is unchanged. When it is there it sits at the
 * top of the tree and in the zip, because a log line at two in the morning is
 * not where anybody analysing the data will look for what is missing from it.
 */
export function exportFiles(
  built: StudyDataset,
  study: string,
  narratives: StoredNarrativeRun[],
  compiledIn: ReleaseManifest | undefined = latestRelease,
): BidsFile[] {
  const manifest = datasetManifest(built.releases, compiledIn);
  if (!manifest) throw new Error("no release manifest available");

  const files = buildBidsExport(built.dataset, {
    manifest,
    datasetName: `MySelf ${study}`,
    narratives,
  });
  if (built.unreadable.length > 0) {
    files.push({
      path: "unreadable.json",
      content: `${JSON.stringify(
        {
          Description:
            "Sittings left out of this export because the release they were collected under could not be found or did not verify. They are still in the database, untouched; none of their answers is in any file here. Each will be read once its release is available — do not analyse this export as if it were complete.",
          sittings: built.unreadable,
        },
        null,
        2,
      )}\n`,
    });
    // A top-level file BIDS does not define is an error to a validator, and
    // the archived export should validate whether or not something was left
    // out; `.bidsignore` is how this dataset already names what BIDS will not
    // recognise (review fix). Kept in path order, as `buildBidsExport` leaves it.
    const ignore = files.find((f) => f.path === ".bidsignore");
    if (ignore) ignore.content = `${ignore.content.replace(/\n?$/, "\n")}unreadable.json\n`;
    else files.push({ path: ".bidsignore", content: "unreadable.json\n" });
    files.sort((a, b) => a.path.localeCompare(b.path));
  }
  return files;
}

/**
 * Where a study's export is written (D-56). The default study keeps
 * `exports/{stamp}` exactly as before, so nothing that reads last night's export
 * has to change; every other study has its own tree under
 * `exports/studies/{study}/{stamp}`. The two cannot collide: a stamp starts with
 * a digit, and `studies` does not.
 */
export function exportPrefix(study: string, stamp: string, defaultStudy: string = STUDY): string {
  return study === defaultStudy ? `exports/${stamp}` : `exports/studies/${study}/${stamp}`;
}

/**
 * The release the dataset-level files describe, for this study: the compiled-in
 * one counts only for the study it belongs to. Another study's export is
 * described by its own releases or not written at all — a `ybm` dictionary on
 * a dataset of somebody else's questions would describe columns that are not
 * there.
 */
function compiledInFor(study: string): ReleaseManifest | undefined {
  return latestRelease?.release.study === study ? latestRelease : undefined;
}

async function writeExport(study: string, prefix: string): Promise<{ files: number; bytes: number } | null> {
  const built = await buildStudyDataset(study);

  /**
   * A study with nothing to describe — a study space with no sittings yet, or
   * none readable — writes nothing rather than failing the night for every
   * study after it. The default study always writes, as it always did.
   */
  if (study !== STUDY && !datasetManifest(built.releases, compiledInFor(study))) {
    logger.info("export skipped: nothing to describe yet", { study, sittings: built.sittings });
    return null;
  }

  /**
   * The narratives, joined to the sittings they belong to.
   *
   * Read even when the study has none: an empty collection costs one query
   * and produces no files, and the alternative is a flag somebody has to
   * remember to turn on when a study starts using the module.
   */
  const narratives = await readNarratives(study);

  const files = exportFiles(built, study, narratives, compiledInFor(study));
  const bucket = getStorage().bucket();

  for (const file of files) {
    await bucket.file(`${prefix}/${file.path}`).save(file.content, {
      contentType: file.path.endsWith(".json") ? "application/json" : "text/tab-separated-values",
    });
  }

  // A single zip alongside the tree, because "send me the data" should not
  // require anyone to learn gsutil.
  const zip = buildZip(files);
  await bucket.file(`${prefix}/bids.zip`).save(Buffer.from(zip), { contentType: "application/zip" });

  logger.info("export written", {
    study,
    prefix,
    files: files.length,
    sittings: built.sittings,
    unreadable: built.unreadable.length,
    narratives: narratives.length,
  });
  return { files: files.length, bytes: zip.length };
}

/**
 * 02:00 UTC, every night, for every registered study (D-56), the default first.
 *
 * One study's failure is logged and the next one still runs: a study space with
 * a corrupt document must not cost every other study its archival copy. The
 * night is reported as failed afterwards, so the scheduler's own record still
 * says something went wrong.
 */
export const nightlyExport = onSchedule({ schedule: "0 2 * * *", timeZone: "Etc/UTC", memory: "1GiB" }, async () => {
  const day = new Date().toISOString().slice(0, 10);
  const failed: string[] = [];
  for (const { study } of await registeredStudies(research())) {
    try {
      await writeExport(study, exportPrefix(study, day));
    } catch (error) {
      failed.push(study);
      logger.error("a study's nightly export failed", { study, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failed.length > 0) throw new Error(`the nightly export failed for ${failed.join(", ")}`);
});

/**
 * The same export, on demand, for when somebody needs today's rather than last
 * night's. `study` is optional and names which (D-56); absent is the default.
 */
export const exportNow = onCall({ memory: "1GiB" }, async (request) => {
  const token = request.auth?.token as { role?: string; device?: boolean } | undefined;
  if (!request.auth || token?.device || !["owner", "researcher"].includes(token?.role ?? "")) {
    throw new HttpsError("permission-denied", "only an owner or researcher can export");
  }
  const { study } = await studyForCall(research(), (request.data as { study?: unknown } | undefined)?.study);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, "");
  const prefix = exportPrefix(study, `${stamp}-manual`);
  const result = await writeExport(study, prefix);
  if (!result) throw new HttpsError("failed-precondition", "this study has no sittings to export yet");
  return { prefix, ...result };
});
