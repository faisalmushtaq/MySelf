import { z } from "zod";
import { STUDIO_ROLES } from "@myself/studio";
import { domainKey, emailKey, isDomainKey, isEmailKey } from "./domains.js";

/**
 * What each Studio callable accepts (docs/16 §5.5, §5.7).
 *
 * Checked before anything is read. Every value that ends up in a document path
 * — a survey ID, a version, an address — is held to a pattern that cannot name
 * a different document, and nothing about who is asking is taken from the
 * request: the caller's identity and role come from the verified token and the
 * list, never from a field a browser filled in. Unknown fields are ignored
 * rather than refused, so an older Studio tab keeps working after a newer one
 * starts sending more.
 */

/** An existing survey: what `route.ts` in the Studio accepts. */
export const surveyIdField = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "must be a survey ID: lower-case letters, numbers and underscores, starting with a letter");

/** A new survey's ID: what the "New survey" dialog allows (3 to 48 characters). */
export const newSurveyIdField = z
  .string()
  .min(3, "must be at least 3 characters")
  .max(48, "must be at most 48 characters")
  .regex(/^[a-z][a-z0-9_]*$/, "must use lower-case letters, numbers and underscores, starting with a letter");

/**
 * MAJOR.MINOR.PATCH, digits only. The same shape `checkChosenVersion` accepts,
 * and a safe document ID: `versions/{version}`.
 */
export const versionField = z
  .string()
  .regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/, "must be a version number such as 8.0.0");

const revisionField = z.number().int("must be a whole number").min(1, "must be 1 or more").max(Number.MAX_SAFE_INTEGER);

const roleField = z.enum(STUDIO_ROLES);

/** An emergency rollback has to say why, in more than a word (the dialog asks for 10 characters). */
export const MIN_REASON_CHARS = 10;

export const sessionRequest = z.object({});

export const importLiveRequest = z.object({ surveyId: surveyIdField });

export const createSurveyRequest = z.object({
  surveyId: newSurveyIdField,
  title: z.string().trim().min(1, "give the survey a title").max(200, "must be at most 200 characters"),
  from: z.object({ surveyId: surveyIdField, version: versionField }).nullable().optional(),
});

export const publishRequest = z.object({
  surveyId: surveyIdField,
  expectedRevision: revisionField,
  version: versionField,
  releaseNote: z.string().trim().min(1, "say what this version changes").max(5_000, "must be at most 5,000 characters"),
});

export const restoreVersionRequest = z.object({
  surveyId: surveyIdField,
  version: versionField,
  expectedRevision: revisionField,
});

export const activateVersionRequest = z.object({
  surveyId: surveyIdField,
  version: versionField,
  reason: z
    .string()
    .trim()
    .min(MIN_REASON_CHARS, `say why, in at least ${MIN_REASON_CHARS} characters`)
    .max(2_000, "must be at most 2,000 characters"),
});

export const setMemberRequest = z.object({
  email: z
    .string()
    .transform(emailKey)
    .refine(isEmailKey, "must be an email address, such as name@example.org"),
  role: roleField.nullable(),
  note: z.string().trim().max(500, "must be at most 500 characters").nullable().optional(),
});

export const setDomainRequest = z.object({
  domain: z
    .string()
    .transform(domainKey)
    .refine(isDomainKey, "must be a domain, such as brainpop.com — just the part after the @"),
  // Public mail providers are refused by `setDomain` itself, and only when a
  // rule is being set: taking one away must always be possible.
  role: roleField.nullable(),
});

export const responseStatsRequest = z.object({ surveyId: surveyIdField });

export type CreateSurveyInput = z.output<typeof createSurveyRequest>;
export type PublishInput = z.output<typeof publishRequest>;
export type RestoreVersionInput = z.output<typeof restoreVersionRequest>;
export type ActivateVersionInput = z.output<typeof activateVersionRequest>;
export type SetMemberInput = z.output<typeof setMemberRequest>;
export type SetDomainInput = z.output<typeof setDomainRequest>;
