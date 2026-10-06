import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import { STUDY_ID_PATTERN } from "@myself/schema";
import type { CreateStudyResponse, SetStudyResponse, StudyStatus, StudySummary } from "@myself/studio";
import { STUDY } from "../apps.js";
import { lookupStudy, registered, registeredStudies, type RegisteredStudy } from "../studies.js";
import { studioRoleFor, type StudioToken } from "./access.js";
import { auditRow, newAuditRef, type AuditActor } from "./audit.js";
import { problem, refuse } from "./errors.js";

/**
 * Study spaces in the Studio (D-56, docs/16 §11.4).
 *
 * A study space is a registry document, `studies/{study}`, and everything
 * filed beneath it. These are the only code that writes the registry, and
 * only the project's owners reach them: creating a study decides who may run
 * one more study in this project under its ethics approval and its OpenAI
 * budget, which is not a decision for whoever administers one study's Studio.
 *
 * NOTHING HERE DELETES. A closed study keeps everything, can be reopened, and
 * its id can never be given to another study: a sitting filed under an id is
 * filed under it for good, and an id reused would put two studies' data in one
 * place.
 */

/** How a Studio callable says which study it is for, or refuses in the Studio's terms. */
export async function studyForStudio(db: Firestore, raw: unknown, defaultStudy: string = STUDY): Promise<RegisteredStudy> {
  const found = await lookupStudy(db, raw, defaultStudy);
  if (found.kind === "malformed") {
    const message = "That isn't a study id: use 2 to 40 lower-case letters, numbers and underscores, starting with a letter.";
    throw refuse.invalid(message, [problem("study.malformed", message)], [], "invalid-argument");
  }
  if (found.kind === "unknown") {
    throw refuse.notFound(`study:${found.study}`, `There's no study space “${found.study}”. It may have been typed wrongly, or never created.`);
  }
  return found.study;
}

/**
 * The studies a caller may open in the Studio, for the switcher: every study
 * where `studioRoleFor` gives them a role — the same answer the rules give, per
 * study, so the list never offers a study whose every read would be refused.
 * An owner is an admin everywhere and so sees them all. Two document reads per
 * study at most; a project has a handful.
 */
export async function studiesFor(db: Firestore, token: StudioToken, defaultStudy: string = STUDY): Promise<StudySummary[]> {
  const all = await registeredStudies(db, defaultStudy);
  const out: StudySummary[] = [];
  for (const s of all) {
    const access = await studioRoleFor(db, s.study, token);
    if (!access.role) continue;
    out.push({ study: s.study, title: s.title ?? s.study, status: s.status, role: access.role, isDefault: s.isDefault });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Creating one
// ---------------------------------------------------------------------------

export interface CreateStudyArgs {
  study: string;
  title: string;
  actor: AuditActor;
  defaultStudy?: string;
}

/**
 * Collections whose presence under an id means data is already filed there.
 * Checked before an id is registered, so that a study space always starts
 * empty: an id left over from a test, or one some request wrote into before
 * the registry existed, must not hand its data to whoever registers it next.
 */
const LEFTOVERS = (study: string) => [
  paths.studioSurveys(study),
  paths.sessions(study),
  paths.studioMembers(study),
  paths.devices(study),
  paths.narratives(study),
];

/**
 * A new study space, open, with its creator as its first Studio admin.
 *
 * ONE TRANSACTION: the registry document, the creator's place on the list and
 * both audit rows land together or not at all. Refused for an id already
 * registered, for the default study's id (registered already, with or without
 * a document), and for an id with data under it.
 *
 * The creator is listed by the address Google verified. An owner without one —
 * a token from the command line, say — is still an admin through the claim,
 * and the study then starts with nobody on its list, which an owner can fix
 * from the Studio like any other.
 */
export async function createStudy(db: Firestore, args: CreateStudyArgs): Promise<CreateStudyResponse> {
  const { study, title, actor } = args;
  const defaultStudy = args.defaultStudy ?? STUDY;
  if (!STUDY_ID_PATTERN.test(study)) {
    const message = "A study id is 2 to 40 lower-case letters, numbers and underscores, starting with a letter.";
    throw refuse.invalid(message, [problem("study.malformed", message, { kind: "survey", field: "study" })], [], "invalid-argument");
  }
  if (study === defaultStudy) {
    throw refuse.invalid(
      `“${study}” is this project's own study, and is already a study space.`,
      [problem("study.exists", `“${study}” is already a study space.`, { kind: "survey", field: "study" })],
      [],
      "already-exists",
    );
  }
  const ref = db.doc(paths.study(study));

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      throw refuse.invalid(
        `There's already a study space with the id “${study}”. Choose another id.`,
        [problem("study.exists", `The study id “${study}” is taken.`, { kind: "survey", field: "study" })],
        [],
        "already-exists",
      );
    }
    for (const collection of LEFTOVERS(study)) {
      const found = await tx.get(db.collection(collection).limit(1));
      if (!found.empty) {
        throw refuse.invalid(
          `Something is already filed under the id “${study}”, so it can't be used for a new study space. Choose another id, and tell the study's technical lead.`,
          [problem("study.not_empty", `Data already exists under studies/${study}.`, { kind: "survey", field: "study" })],
          [],
          "already-exists",
        );
      }
    }

    const at = FieldValue.serverTimestamp();
    tx.create(ref, {
      study,
      title,
      status: "open" satisfies StudyStatus,
      createdAt: at,
      createdBy: actor.uid,
      updatedAt: at,
      updatedBy: actor.uid,
      closedAt: null,
    });
    tx.create(newAuditRef(db, study), auditRow("study.created", actor, null, study, { title }));
    if (actor.email) {
      const note = "Created this study space";
      tx.create(db.doc(paths.studioMember(study, actor.email)), {
        email: actor.email,
        role: "admin",
        addedAt: at,
        addedBy: actor.uid,
        addedByEmail: actor.email,
        note,
      });
      tx.create(newAuditRef(db, study), auditRow("access.member_set", actor, null, actor.email, { role: "admin", previousRole: null, note }));
    }
    return { study };
  });
}

// ---------------------------------------------------------------------------
// Renaming, closing and reopening one
// ---------------------------------------------------------------------------

export interface SetStudyArgs {
  study: string;
  title?: string;
  status?: StudyStatus;
  actor: AuditActor;
  defaultStudy?: string;
}

/**
 * Change a study's title, or close or reopen it.
 *
 * For the default study with no document yet, this is the one-off bootstrap:
 * its document is created, open unless closed here, titled as given or with its
 * id. Idempotent: a change to what is already there writes nothing and records
 * nothing. `closedAt` is set each time it closes and kept when it reopens, so
 * the last closure stays on the record.
 */
export async function setStudy(db: Firestore, args: SetStudyArgs): Promise<SetStudyResponse> {
  const { study, actor } = args;
  const defaultStudy = args.defaultStudy ?? STUDY;
  const ref = db.doc(paths.study(study));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists && study !== defaultStudy) {
      throw refuse.notFound(`study:${study}`, `There's no study space “${study}”.`);
    }
    const before = snap.exists ? registered(study, snap.data() as Record<string, unknown>, defaultStudy) : null;
    const fromTitle = before?.title ?? null;
    const fromStatus: StudyStatus = before?.status ?? "open";
    const title = args.title ?? fromTitle ?? study;
    const status = args.status ?? fromStatus;
    if (snap.exists && title === fromTitle && status === fromStatus) return { study, title, status };

    const at = FieldValue.serverTimestamp();
    tx.set(
      ref,
      {
        ...(snap.exists ? {} : { study, createdAt: at, createdBy: actor.uid, closedAt: null }),
        title,
        status,
        updatedAt: at,
        updatedBy: actor.uid,
        ...(status === "closed" && fromStatus !== "closed" ? { closedAt: at } : {}),
      },
      { merge: true },
    );
    tx.create(
      newAuditRef(db, study),
      auditRow("study.updated", actor, null, study, {
        title: { from: fromTitle, to: title },
        status: { from: snap.exists ? fromStatus : null, to: status },
        createdDocument: !snap.exists,
      }),
    );
    return { study, title, status };
  });
}
