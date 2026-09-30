import { onSchedule } from "firebase-functions/v2/scheduler";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getStorage } from "firebase-admin/storage";
import { joinSession, paths, type ChunkDoc, type SessionDoc } from "@myself/firebase";
import {
  buildBidsExport,
  buildZip,
  emptyDataset,
  ingest,
  type Dataset,
  type DeviceSession,
  type StoredNarrativeRun,
} from "@myself/store";
import { STUDY, research } from "./apps.js";
import { knownReleases, releaseFor } from "./releases.js";

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

/** Read every sitting and derive the dataset, the same way the browser does. */
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

export async function buildStudyDataset(study: string): Promise<{ dataset: Dataset; sittings: number }> {
  const db = research();
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

  // Bundled and published from the dashboard alike (D-54), each checked
  // against its hash before it is used to read anything.
  const known = await knownReleases();
  let dataset = emptyDataset();
  for (const [hash, group] of [...groups.entries()].sort((a, b) => {
    const earliest = (rows: DeviceSession[]) => rows.reduce((m, r) => (r.startedAt < m ? r.startedAt : m), rows[0]!.startedAt);
    return earliest(a[1]).localeCompare(earliest(b[1]));
  })) {
    const manifest = (await releaseFor(hash)) ?? known.latest;
    if (!manifest) continue;
    const result = ingest([...group].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), {
      manifest,
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
  return { dataset, sittings: sessions.length };
}

async function writeExport(study: string, prefix: string): Promise<{ files: number; bytes: number }> {
  const { dataset, sittings } = await buildStudyDataset(study);
  const { latest: latestRelease } = await knownReleases();
  if (!latestRelease) throw new Error("no release manifest available");

  /**
   * The narratives, joined to the sittings they belong to.
   *
   * Read even when the study has none: an empty collection costs one query
   * and produces no files, and the alternative is a flag somebody has to
   * remember to turn on when a study starts using the module.
   */
  const narratives = await readNarratives(study);

  const files = buildBidsExport(dataset, {
    manifest: latestRelease,
    datasetName: `MySelf ${study}`,
    narratives,
  });
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

  logger.info("export written", { prefix, files: files.length, sittings, narratives: narratives.length });
  return { files: files.length, bytes: zip.length };
}

/** 02:00 UTC, every night. */
export const nightlyExport = onSchedule({ schedule: "0 2 * * *", timeZone: "Etc/UTC", memory: "1GiB" }, async () => {
  const day = new Date().toISOString().slice(0, 10);
  await writeExport(STUDY, `exports/${day}`);
});

/** The same export, on demand, for when somebody needs today's rather than last night's. */
export const exportNow = onCall({ memory: "1GiB" }, async (request) => {
  const token = request.auth?.token as { role?: string; device?: boolean } | undefined;
  if (!request.auth || token?.device || !["owner", "researcher"].includes(token?.role ?? "")) {
    throw new HttpsError("permission-denied", "only an owner or researcher can export");
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, "");
  const prefix = `exports/${stamp}-manual`;
  const result = await writeExport(STUDY, prefix);
  return { prefix, ...result };
});
