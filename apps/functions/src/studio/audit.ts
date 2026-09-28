import { FieldValue, type DocumentReference, type Firestore, type Timestamp } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import type { AuditAction, AuditDoc } from "@myself/studio";

/**
 * The Studio audit trail — the only code that writes `studioAudit` (docs/16
 * §5.8, R9).
 *
 * No client can write that collection; the rules refuse every role. So a row
 * exists only because a function wrote it, and every function writes its row
 * in the same transaction or batch as the change it records: a publish that
 * lands has its row, and a row never describes a publish that did not. The
 * row's time is the server's, never the caller's.
 *
 * `studio-access.mjs` (the command line for the first admin) writes rows of
 * the same shape with a `cli:` actor; it runs with the project's own
 * credentials, outside any function.
 */

export interface AuditActor {
  uid: string;
  /** The list key (lower-cased address), or null when the token carried none. */
  email: string | null;
}

/** An audit row ready for `tx.create` / `batch.create`, stamped with the server's time. */
export type AuditRow = Omit<AuditDoc, "at"> & { at: FieldValue | Timestamp };

export function auditRow(
  action: AuditAction,
  actor: AuditActor,
  surveyId: string | null,
  subject: string,
  detail: Record<string, unknown> | null,
): AuditRow {
  return {
    at: FieldValue.serverTimestamp(),
    actor: actor.uid,
    actorEmail: actor.email,
    action,
    surveyId,
    subject,
    detail,
  };
}

/** A new, unique row in the study's audit trail. */
export function newAuditRef(db: Firestore, study: string): DocumentReference {
  return db.collection(paths.studioAudit(study)).doc();
}
