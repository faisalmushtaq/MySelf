import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { paths } from "@myself/firebase";
import { compareVersions } from "@myself/release/gate";
import { CALLABLES, atLeast, extractDraft, type ResponseStatsRequest, type StudioDraft } from "@myself/studio";
import { STUDY, studioFirebase } from "../firebase.js";
import { toMillis } from "../format.js";
import { usePlaygroundMode } from "../mode.js";
import { toStudioCallError } from "./errors.js";
import { NOT_CONNECTED, useLiveDoc, useLiveQuery } from "./live.js";
import { publishedProtocols, publishedScaleCodes, reservedFrom } from "./model-adapter.js";
import { useRelease, useReleases, type LoadedRelease } from "./releases.js";
import { onBeforeSignOut, ruleEmail, useStudioSession } from "./session.js";
import type {
  AccessConfigDoc,
  AuditDoc,
  Loadable,
  MemberDoc,
  PresenceDoc,
  PublishedContext,
  ReleaseManifest,
  ResponseStatsResponse,
  SurveyDoc,
  VersionDoc,
} from "./types.js";

/**
 * The Studio's reads, as hooks. Each is live (a Firestore listener) unless it
 * is a function call, and each reports loading, ready or an error with a retry.
 */

const asSurvey = (d: DocumentData) => d as SurveyDoc;
const asVersion = (d: DocumentData) => d as VersionDoc;
const asAudit = (d: DocumentData) => d as AuditDoc;
const asMember = (d: DocumentData) => d as MemberDoc;
const asAccess = (d: DocumentData) => d as AccessConfigDoc;
const asPresence = (d: DocumentData) => d as PresenceDoc;

const byTitle = (a: SurveyDoc, b: SurveyDoc) => a.title.localeCompare(b.title, "en-GB") || a.surveyId.localeCompare(b.surveyId);
/**
 * Newest first by version number rather than by publish time: imported
 * versions all share one import time, while version numbers only ever go up
 * with each publish (a rollback repoints the live version; it does not
 * publish a new one).
 */
const newestFirst = (a: VersionDoc, b: VersionDoc) =>
  compareVersions(b.version, a.version) || (toMillis(b.publishedAt) ?? 0) - (toMillis(a.publishedAt) ?? 0);

export function useSurveys(): Loadable<SurveyDoc[]> {
  return useLiveQuery((db) => query(collection(db, paths.studioSurveys(STUDY))), "surveys", asSurvey, "the list of surveys", byTitle);
}

export function useSurvey(surveyId: string): Loadable<SurveyDoc | null> {
  return useLiveDoc(paths.studioSurvey(STUDY, surveyId), asSurvey, "this survey");
}

/** Newest first. */
export function useVersions(surveyId: string): Loadable<VersionDoc[]> {
  return useLiveQuery(
    (db) => query(collection(db, paths.studioVersions(STUDY, surveyId))),
    `versions:${surveyId}`,
    asVersion,
    "this survey’s versions",
    newestFirst,
  );
}

/**
 * Newest first; `surveyId` null for access-management rows. Needs the
 * composite index studioAudit (surveyId ASC, at DESC).
 */
export function useAudit(surveyId: string | null, max = 100): Loadable<AuditDoc[]> {
  return useLiveQuery(
    (db) => query(collection(db, paths.studioAudit(STUDY)), where("surveyId", "==", surveyId), orderBy("at", "desc"), limit(max)),
    `audit:${surveyId ?? "(access)"}:${max}`,
    asAudit,
    "the activity log",
  );
}

const AUDIT_PAGE = 500;

/**
 * A survey's whole audit trail, read once (for the provenance download).
 *
 * Page by page, newest first, through the same index the Activity tab uses.
 * Every row is read — the edits as well as the publishes — because the trail
 * has no other index to filter on, and a download asked for now and then is
 * worth that rather than a new index to deploy.
 */
export async function loadAudit(surveyId: string): Promise<AuditDoc[]> {
  const fb = studioFirebase();
  if (!fb) throw new Error(NOT_CONNECTED);
  const out: AuditDoc[] = [];
  let after: QueryDocumentSnapshot | null = null;
  for (;;) {
    const base = query(collection(fb.db, paths.studioAudit(STUDY)), where("surveyId", "==", surveyId), orderBy("at", "desc"), limit(AUDIT_PAGE));
    const page: QuerySnapshot = await getDocs(after ? query(base, startAfter(after)) : base);
    for (const d of page.docs) out.push(asAudit(d.data()));
    if (page.docs.length < AUDIT_PAGE) return out;
    after = page.docs[page.docs.length - 1]!;
  }
}

/** Admins only (the rules refuse anyone else the list). */
export function useMembers(): Loadable<MemberDoc[]> {
  return useLiveQuery(
    (db) => query(collection(db, paths.studioMembers(STUDY))),
    "members",
    asMember,
    "the list of people with access",
    (a, b) => a.email.localeCompare(b.email),
  );
}

export function useAccessConfig(): Loadable<AccessConfigDoc | null> {
  return useLiveDoc(paths.studioAccessConfig(STUDY), asAccess, "the domain rules");
}

/** A published release, fetched from the release store and verified against its hash. */
export function usePublishedManifest(hash: string | null): Loadable<ReleaseManifest | null> {
  const release = useRelease(hash);
  return useMemo(() => (release.status === "ready" ? { status: "ready", data: release.data?.manifest ?? null } : release), [release]);
}

export function useResponseStats(surveyId: string): Loadable<ResponseStatsResponse> {
  const fb = studioFirebase();
  const [attempt, setAttempt] = useState(0);
  const retry = useMemo(() => () => setAttempt((a) => a + 1), []);
  const key = `${surveyId}#${attempt}`;
  const [state, setState] = useState<{ key: string; value: Loadable<ResponseStatsResponse> } | null>(null);

  useEffect(() => {
    if (!fb) return;
    let live = true;
    httpsCallable<ResponseStatsRequest, ResponseStatsResponse>(fb.fns, CALLABLES.responseStats)({ surveyId })
      .then((r) => live && setState({ key, value: { status: "ready", data: r.data } }))
      .catch((e: unknown) => live && setState({ key, value: { status: "error", error: toStudioCallError(e).message, retry } }));
    return () => {
      live = false;
    };
  }, [fb, surveyId, key, retry]);

  if (!fb) return { status: "error", error: NOT_CONNECTED, retry };
  return state?.key === key ? state.value : { status: "loading" };
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

// ── Presence ──────────────────────────────────────────────────────────────

export const PRESENCE_HEARTBEAT_MS = 30_000;
export const PRESENCE_WINDOW_MS = 90_000;

/**
 * Other people with this survey open, excluding the current user.
 *
 * While mounted, keeps this person's own presence document fresh (every 30 s,
 * and when the question they are on changes) and deletes it on the way out.
 * Somebody whose tab crashed simply stops being shown after 90 s. In the
 * playground it neither writes nor reads: nobody is really editing there.
 */
export function usePresence(surveyId: string, focus: string | null): PresenceDoc[] {
  const playground = usePlaygroundMode();
  const fb = playground ? null : studioFirebase();
  const { user, role } = useStudioSession();
  const uid = user?.uid ?? null;
  const email = ruleEmail(user);
  // The rules let only editors (and above) write a presence marker: a viewer
  // cannot collide with anyone, and trying would be a refused write every 30 s.
  // Viewers still see who else is there.
  const writes = atLeast(role, "editor");
  const writer = writes ? fb : null;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const [all, setAll] = useState<PresenceDoc[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Own heartbeat.
  useEffect(() => {
    if (!writer || !uid) return;
    const ref = doc(writer.db, paths.studioPresenceOf(STUDY, surveyId, uid));
    const beat = () => {
      void setDoc(ref, { uid, email, at: serverTimestamp(), focus: focusRef.current }).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);
    const remove = () => deleteDoc(ref).catch(() => undefined);
    const leave = () => void remove();
    window.addEventListener("pagehide", leave);
    // Signing out unmounts this only after the sign-out, when the rules no
    // longer let this person delete their own document — so do it first.
    const unregister = onBeforeSignOut(remove);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      unregister();
      leave();
    };
  }, [writer, uid, email, surveyId]);

  // Tell others when the question in focus changes — debounced, so clicking
  // down an outline is one write, not twenty.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!writer || !uid) return;
    const t = window.setTimeout(() => {
      void setDoc(doc(writer.db, paths.studioPresenceOf(STUDY, surveyId, uid)), {
        uid,
        email,
        at: serverTimestamp(),
        focus: focusRef.current,
      }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(t);
  }, [writer, uid, email, surveyId, focus]);

  // Everyone else.
  useEffect(() => {
    if (!fb || !uid) return;
    return onSnapshot(
      collection(fb.db, paths.studioPresence(STUDY, surveyId)),
      (snap) => setAll(snap.docs.map((d) => asPresence(d.data())).filter((p) => p.uid !== uid)),
      () => setAll([]),
    );
  }, [fb, uid, surveyId]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  return useMemo(
    () =>
      all
        .filter((p) => {
          const at = toMillis(p.at);
          return at !== null && now - at < PRESENCE_WINDOW_MS;
        })
        .sort((a, b) => a.email.localeCompare(b.email)),
    [all, now],
  );
}

// ── What has been published ───────────────────────────────────────────────

/**
 * One draft per live release, however often the survey document changes. Each
 * save's bookkeeping (the list of who has edited since the last publish)
 * rebuilds the published context, and a new baseline object every time
 * restarted everything compared with it: the toolbar said "Comparing…" for a
 * second after each save, and the draft was validated again for nothing.
 */
const baselines = new WeakMap<LoadedRelease, StudioDraft>();
function baselineOf(release: LoadedRelease): StudioDraft {
  let draft = baselines.get(release);
  if (!draft) {
    draft = extractDraft(release.raw);
    baselines.set(release, draft);
  }
  return draft;
}

/** Pure: the published context from the survey, its versions and their releases. */
export function buildPublishedContext(
  survey: SurveyDoc | null,
  versions: readonly VersionDoc[],
  releases: ReadonlyMap<string, LoadedRelease>,
): PublishedContext {
  const active = survey?.active ?? null;
  const activeRelease = active ? releases.get(active.hash) : undefined;
  const publishedItemKeys = new Set<string>();
  for (const v of versions) for (const k of v.itemKeys ?? []) publishedItemKeys.add(k);
  const manifests = versions.map((v) => releases.get(v.hash)?.manifest).filter((m): m is ReleaseManifest => !!m);
  if (activeRelease && !manifests.includes(activeRelease.manifest)) manifests.push(activeRelease.manifest);
  return {
    baseline: activeRelease ? baselineOf(activeRelease) : null,
    active,
    latestVersion: survey?.latestVersion ?? null,
    // A copy: the real reservedFrom (packages/studio history.ts) takes a
    // mutable array, and this must still compile when the adapter becomes a
    // re-export of it.
    reserved: reservedFrom([...versions]),
    publishedItemKeys,
    publishedScaleCodes: publishedScaleCodes(manifests),
    publishedProtocols: publishedProtocols(manifests),
  };
}

/**
 * The published baseline, reserved IDs and codes — what validation and the diff
 * need. Waits for every version's release, because validation that ran before
 * knowing which option codes were ever published could approve reusing one.
 */
export function usePublishedContext(surveyId: string): Loadable<PublishedContext> {
  const survey = useSurvey(surveyId);
  const versions = useVersions(surveyId);
  const hashes = useMemo(() => {
    if (survey.status !== "ready" || versions.status !== "ready") return null;
    const set = new Set(versions.data.map((v) => v.hash));
    if (survey.data?.active) set.add(survey.data.active.hash);
    return [...set];
  }, [survey, versions]);
  const releases = useReleases(hashes);

  return useMemo<Loadable<PublishedContext>>(() => {
    for (const part of [survey, versions, releases] as const) {
      if (part.status === "error") {
        return {
          status: "error",
          error: part.error,
          retry: () => {
            if (survey.status === "error") survey.retry();
            if (versions.status === "error") versions.retry();
            if (releases.status === "error") releases.retry();
          },
        };
      }
    }
    if (survey.status !== "ready" || versions.status !== "ready" || releases.status !== "ready") return { status: "loading" };
    try {
      return { status: "ready", data: buildPublishedContext(survey.data, versions.data, releases.data) };
    } catch {
      // Deterministic (the stored release is valid but will not extract), so
      // retrying cannot help; the message says who can.
      return {
        status: "error",
        error: "The live version couldn’t be opened for comparison. Tell the study’s technical lead.",
        retry: () => undefined,
      };
    }
  }, [survey, versions, releases]);
}
