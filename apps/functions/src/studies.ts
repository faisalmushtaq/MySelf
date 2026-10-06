import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { paths } from "@myself/firebase";
import { isStudyId } from "@myself/schema";
import type { StudyStatus } from "@myself/studio";
import { STUDY } from "./apps.js";
import { RelayError } from "./relay-policy.js";

/**
 * Which study a request is for (D-56, docs/16 §11.4–§11.5).
 *
 * Until study spaces, the study was a constant: `STUDY`, the deployment's
 * default, used by every function for every request. Now a request may name
 * one — an iPad filing a sitting it started in another study, MyStory calling
 * the model for that sitting, a Studio member working in a second study space —
 * and THIS is where the name becomes a study or is refused, before anything
 * else is read. Every path a function then builds is built from what this
 * returned, never from the request.
 *
 * THREE ANSWERS, AND ONLY ONE OF THEM IS A STUDY.
 *
 *   MALFORMED: not an id at all (`STUDY_ID_PATTERN`). Refused before Firestore
 *   is asked, because an id is about to become a path segment, and the pattern
 *   is what stops one naming another document.
 *
 *   UNKNOWN: a well-formed id with no registry document, and not the default.
 *   Refused: a study exists because an owner created it, never because a
 *   request named it. Without this, the first sitting posted to `studies/xyz`
 *   would have created a study nobody had decided to run.
 *
 *   REGISTERED: its document, or — for the deployment's default, `ybm` — no
 *   document at all. The default is registered IMPLICITLY so that nothing had
 *   to be written for the study that already existed (docs/16 §11.9). An owner
 *   may still give it a document (to name it, or to close it), and then the
 *   document decides.
 *
 * A REQUEST THAT NAMES NO STUDY means the default, which is what every request
 * meant before this — so every iPad, page and caller that predates study
 * spaces carries on exactly as it did.
 *
 * READ EVERY TIME, never cached. Closing a study has to bite on the next
 * request, and one document read is nothing beside what a sitting or a model
 * call costs.
 */

export interface RegisteredStudy {
  study: string;
  /** Its registry title; null for the default study when it has no document. */
  title: string | null;
  status: StudyStatus;
  /** Registered by being the deployment's default, with no document. */
  implicit: boolean;
  /** The deployment's default study. */
  isDefault: boolean;
}

export type StudyLookup =
  | { kind: "registered"; study: RegisteredStudy }
  | { kind: "malformed"; raw: string }
  | { kind: "unknown"; study: string };

/**
 * A registry document's status, failing CLOSED. Anything but exactly "open" —
 * a typo, a missing field, a value from a later build — reads as closed: a
 * study wrongly closed is noticed the same morning, one wrongly open is not.
 */
export function statusOf(value: unknown): StudyStatus {
  return value === "open" ? "open" : "closed";
}

/** What a registry document says, read defensively: it is data, not a type. */
export function registered(study: string, data: Record<string, unknown> | undefined, defaultStudy: string): RegisteredStudy {
  return {
    study,
    title: typeof data?.["title"] === "string" && data["title"] ? (data["title"] as string) : null,
    status: statusOf(data?.["status"]),
    implicit: false,
    isDefault: study === defaultStudy,
  };
}

/** The default study as it stands with no document: open, untitled. */
export function implicitDefault(defaultStudy: string): RegisteredStudy {
  return { study: defaultStudy, title: null, status: "open", implicit: true, isDefault: true };
}

/**
 * The study a request names (`raw`), looked up. `undefined` and `null` are the
 * default. Never throws for anything a caller sent; a Firestore that cannot be
 * read is allowed to, because "the registry could not be read" is not "no such
 * study" and must not be reported as one.
 */
export async function lookupStudy(db: Firestore, raw: unknown, defaultStudy: string = STUDY): Promise<StudyLookup> {
  const id = raw === undefined || raw === null ? defaultStudy : raw;
  if (typeof id !== "string" || (!isStudyId(id) && id !== defaultStudy)) {
    return { kind: "malformed", raw: typeof id === "string" ? id.slice(0, 48) : typeof id };
  }
  const snap = await db.doc(paths.study(id)).get();
  if (snap.exists) return { kind: "registered", study: registered(id, snap.data() as Record<string, unknown>, defaultStudy) };
  if (id === defaultStudy) return { kind: "registered", study: implicitDefault(defaultStudy) };
  return { kind: "unknown", study: id };
}

/**
 * The study a device-facing endpoint is asked about, or its refusal as the
 * endpoints send one (`RelayError`). Worded for whoever reads a sync panel or a
 * conversation: an iPad that was set to a study that does not exist has been
 * given a bad link, and the sittings on it are safe.
 */
export async function studyForRequest(db: Firestore, raw: unknown, defaultStudy: string = STUDY): Promise<RegisteredStudy> {
  const found = await lookupStudy(db, raw, defaultStudy);
  if (found.kind === "malformed") {
    throw new RelayError(400, "unknown", "this request names a study in a form no study id takes");
  }
  if (found.kind === "unknown") {
    throw new RelayError(
      404,
      "unknown",
      `“${found.study}” is not a study this project runs. Anything on the device is safe; tell the research team which link it was set up from.`,
    );
  }
  return found.study;
}

/**
 * The same, for a callable (`onCall`), whose refusals are `HttpsError`s. Used by
 * the owner's and researchers' callables that take an optional `study` — the
 * identity look-ups, `exportNow`, `revokeDevice`. A closed study is still a
 * study: reading it, exporting it and stopping one of its iPads all go on.
 */
export async function studyForCall(db: Firestore, raw: unknown, defaultStudy: string = STUDY): Promise<RegisteredStudy> {
  const found = await lookupStudy(db, raw, defaultStudy);
  if (found.kind === "malformed") throw new HttpsError("invalid-argument", "study must be a study id, such as ybm");
  if (found.kind === "unknown") throw new HttpsError("not-found", `there is no study “${found.study}” in this project`);
  return found.study;
}

/**
 * Every registered study: each registry document, and the default whether or
 * not it has one. The default first, then by id. For the nightly export and
 * the Studio's switcher; a project has a handful, so one listing is cheap.
 */
export async function registeredStudies(db: Firestore, defaultStudy: string = STUDY): Promise<RegisteredStudy[]> {
  const snap = await db.collection(paths.studies()).get();
  const found = new Map<string, RegisteredStudy>();
  for (const doc of snap.docs) {
    // A document under `studies/` whose id is not a study id was not written by
    // `studioCreateStudy`, and nothing should be done in its name.
    if (!isStudyId(doc.id) && doc.id !== defaultStudy) continue;
    found.set(doc.id, registered(doc.id, doc.data() as Record<string, unknown>, defaultStudy));
  }
  if (!found.has(defaultStudy)) found.set(defaultStudy, implicitDefault(defaultStudy));
  return [...found.values()].sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.study.localeCompare(b.study)));
}
