import {
  openPublishedManifest,
  openPublishedRelease,
  responseScale,
  scoringDefinition,
  type ActiveReleaseDoc,
  type ReleaseManifest,
} from "@myself/schema";
import { flattenManifest } from "./flatten.js";

/**
 * Which version of the survey this device runs (D-54).
 *
 * A version published from the dashboard goes straight to the live survey, so
 * a device no longer runs only the release it was built with. It decides at
 * start-up, before the app is drawn, by these rules in order:
 *
 *   1. A sitting being finished runs under the version it was started with.
 *      Resuming never switches version. The start screen asks for this by
 *      reloading into that version (`markResume` in db.ts); see App's `start`.
 *   2. Otherwise the version the study has made active, if the study answers
 *      within a few seconds and the version checks out: its content hashes to
 *      the hash it was published under, the schema accepts it, and this
 *      build's engine can run it. It is then stored on the device.
 *   3. On any failure, or with no network, the last active version this device
 *      stored, and failing that the one bundled into the build.
 *
 * It never gives up and never waits long, because the alternative to a version
 * is a blank screen in front of a child, and a stored or bundled version is
 * always to hand. It never runs a manifest that has not been checked: one read
 * back from the device is checked again, since a later build may have a newer
 * engine than the one that stored it.
 *
 * Everything that touches the network or the device is passed in, so the rules
 * are tested without either (`versions.test.ts`).
 */

/** Where a running version came from, which the start screen shows staff. */
export type ReleaseOrigin =
  /** Built into this app. */
  | "bundled"
  /** The version the study has made active, checked. */
  | "active"
  /** The last active version this device checked, because the study could not be asked now. */
  | "stored"
  /** A sitting's own version, to finish it. */
  | "resumed"
  /** A draft sent by the dashboard to preview. Nothing is saved. */
  | "preview";

export interface ChosenRelease {
  manifest: ReleaseManifest;
  origin: ReleaseOrigin;
  /** Something staff may want to know, such as why the live version is not the one running. */
  note?: string;
  /** Set with `resumed`: the participant code to pick the sitting up for, straight away. */
  resumeCode?: string;
}

/** The study's database, as far as choosing a version needs it. */
export interface PublishedSource {
  /** The active-version pointer, or null when the study has none. Throws when the study cannot be asked. */
  activeRelease(): Promise<ActiveReleaseDoc | null>;
  /** The published-version document for a hash, or null when there is none. Throws when the study cannot be asked. */
  release(hash: string): Promise<unknown>;
}

/** The versions this device keeps, by hash. */
export interface DeviceReleases {
  /** A stored manifest's JSON, or null. */
  get(hash: string): Promise<string | null>;
  put(manifest: ReleaseManifest, json: string): Promise<void>;
  /** The last active version this device checked and stored. */
  lastActive(): Promise<string | null>;
  setLastActive(hash: string): Promise<void>;
  /** A sitting waiting to be picked up under its own version, consumed as it is read. */
  takeResume(): Promise<{ hash: string; code: string } | null>;
}

export interface ChoiceOptions {
  bundled: ReleaseManifest;
  /** Null when this build has no study configured, such as a public preview. */
  source: PublishedSource | null;
  device: DeviceReleases;
  engineVersion: string;
  /** How long to wait for the active-version pointer. */
  activeTimeoutMs?: number;
  /** How long to wait for a manifest not yet stored. It is larger; a slow school network gets longer. */
  manifestTimeoutMs?: number;
}

export const ACTIVE_TIMEOUT_MS = 4_000;
export const MANIFEST_TIMEOUT_MS = 8_000;

/**
 * Whether this app can draw a manifest at all.
 *
 * The same work the app does with it at load — flattening it into screens, and
 * parsing every scale and scoring definition — done here first. The schema
 * checks the manifest's outline; this catches what the outline allows but the
 * app cannot run, such as a section naming a protocol that was not frozen.
 * Accepting one that failed here would mean the app failing to load, which is
 * the blank screen all of this exists to prevent.
 */
export function runnable(manifest: ReleaseManifest): string | null {
  try {
    flattenManifest(manifest);
    for (const scale of Object.values(manifest.scales)) responseScale.parse(scale);
    for (const definition of Object.values(manifest.scoring)) scoringDefinition.parse(definition);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "it cannot be drawn";
  }
}

/** Choose the version to run now. See the rules at the top of this file. */
export async function chooseRelease(options: ChoiceOptions): Promise<ChosenRelease> {
  const { bundled, device } = options;

  // Kept on the device too, so a sitting started under it can still be
  // finished after a later build has replaced it.
  await keep(device, bundled);

  const resume = await device.takeResume().catch(() => null);
  if (resume) {
    const manifest = await fromDevice(options, resume.hash);
    if (manifest) return { manifest, origin: "resumed", resumeCode: resume.code };
  }

  return chooseForNewSittings(options);
}

/**
 * The version a new sitting would run now: rules 2 and 3.
 *
 * Also what a device asks after a handover, to learn whether the study has
 * made a different version active since it started.
 */
export async function chooseForNewSittings(options: ChoiceOptions): Promise<ChosenRelease> {
  const { bundled, source, device } = options;
  let note: string | undefined;

  if (source) {
    try {
      const active = await within(source.activeRelease(), options.activeTimeoutMs ?? ACTIVE_TIMEOUT_MS);
      if (active === null) {
        // The study has published nothing from the dashboard, so the version
        // it runs is the one built in.
        return { manifest: bundled, origin: "bundled" };
      }
      const known = await fromDevice(options, active.hash);
      if (known) {
        await device.setLastActive(active.hash).catch(() => undefined);
        return { manifest: known, origin: "active" };
      }
      const fetched = await within(fetchChecked(options, source, active.hash), options.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS);
      if (fetched.ok) {
        await keep(device, fetched.manifest, fetched.json);
        await device.setLastActive(active.hash).catch(() => undefined);
        return { manifest: fetched.manifest, origin: "active" };
      }
      note = `the live version ${active.version ?? active.hash.slice(7, 19)} was refused: ${fetched.problem}`;
    } catch (error) {
      note = `the study could not be asked for the live version (${explain(error)})`;
    }
  }

  const last = await device.lastActive().catch(() => null);
  if (last) {
    const manifest = await fromDevice(options, last);
    if (manifest) return { manifest, origin: manifest === bundled ? "bundled" : "stored", ...(note ? { note } : {}) };
  }
  return { manifest: bundled, origin: "bundled", ...(note ? { note } : {}) };
}

/**
 * Whether a sitting started under `hash` can be finished on this device: the
 * version is stored here, still checks out, and this build can run it.
 */
export async function canResumeUnder(options: ChoiceOptions, hash: string): Promise<boolean> {
  return (await fromDevice(options, hash)) !== null;
}

/** A version from the device, checked again; or the bundled one; or null. */
async function fromDevice(options: ChoiceOptions, hash: string): Promise<ReleaseManifest | null> {
  if (options.bundled.hash === hash) return options.bundled;
  const json = await options.device.get(hash).catch(() => null);
  if (!json) return null;
  const opened = await openPublishedManifest(json, hash, { engineVersion: options.engineVersion });
  if (!opened.ok || runnable(opened.manifest) !== null) return null;
  return opened.manifest;
}

type Fetched = { ok: true; manifest: ReleaseManifest; json: string } | { ok: false; problem: string };

async function fetchChecked(options: ChoiceOptions, source: PublishedSource, hash: string): Promise<Fetched> {
  const document = await source.release(hash);
  if (document === null || document === undefined) return { ok: false, problem: "the study has no copy of it" };
  const opened = await openPublishedRelease(document, { expectedHash: hash, engineVersion: options.engineVersion });
  if (!opened.ok) return opened;
  const problem = runnable(opened.manifest);
  if (problem) return { ok: false, problem: `this app cannot draw it (${problem})` };
  return { ok: true, manifest: opened.manifest, json: (document as { manifestJson: string }).manifestJson };
}

/** Store a version unless it is already there. A full device loses nothing: it is still used this time. */
async function keep(device: DeviceReleases, manifest: ReleaseManifest, json?: string): Promise<void> {
  if (!manifest.hash) return;
  try {
    if (await device.get(manifest.hash)) return;
    await device.put(manifest, json ?? JSON.stringify(manifest));
  } catch {
    // Storing is for next time. Failing to store never stops this start.
  }
}

class TimedOut extends Error {}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut(`no answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function explain(error: unknown): string {
  if (error instanceof TimedOut) return error.message;
  if (error instanceof Error) return error.message;
  return "no reason given";
}
