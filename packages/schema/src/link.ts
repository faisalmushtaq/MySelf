import { z } from "zod";

/**
 * Where a participant's iPad is sent: one study, one survey (D-56, docs/16 §11.2).
 *
 *   https://faisalmushtaq.github.io/MySelf/?study=<studyId>&survey=<surveyId>
 *
 * Defined once, here, because three parties read or write it and must agree to
 * the character: the Studio builds the link and draws its QR code, the survey
 * reads it on the iPad, and the functions check the same ids on every request
 * that names a study. A link that one of them accepts and another refuses is an
 * iPad set to a survey its sittings cannot be filed under.
 *
 * NOTHING IN A LINK IS TRUSTED, AND NOTHING IS TIDIED. An id that does not match
 * its pattern exactly is refused — not lower-cased, not trimmed, not
 * percent-decoded into shape — because an id ends up as a segment of a
 * Firestore path, a REST address and a Storage prefix, and the pattern is what
 * makes it impossible for one to carry a `/`, a `.`, a `%`, a `?` or a `#` into
 * any of them. Whether the study exists, is open, and has the survey live is
 * the next question, asked of the study itself; this only decides whether the
 * question can be asked safely.
 *
 * A LINK NAMES NO PERSON. Two ids and nothing else: the participant code is
 * typed on the iPad, as it always was, so a link can be printed on a poster.
 */

/**
 * A study id: 2 to 40 characters, lower-case letters, digits and underscores,
 * starting with a letter. `ybm` is one. Within the schema's `slug`, so it can be
 * a composition's `study`, and short enough that `<study>_studio` (the Studio's
 * own module for a study, `studioModuleKey`) is still a slug.
 */
export const STUDY_ID_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * A survey id: a Studio survey's composition key, 1 to 64 characters of the
 * same alphabet. The same pattern the Studio's routes and callables accept.
 */
export const SURVEY_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const studyId = z
  .string()
  .regex(STUDY_ID_PATTERN, "a study id is 2 to 40 lower-case letters, numbers and underscores, starting with a letter");

export const surveyId = z
  .string()
  .regex(SURVEY_ID_PATTERN, "a survey id is lower-case letters, numbers and underscores, starting with a letter");

/** Which survey of which study an iPad runs. */
export interface SurveyChoice {
  study: string;
  surveyId: string;
}

/** The two query parameters, named once. */
export const LINK_PARAMS = { study: "study", survey: "survey" } as const;

export function isStudyId(value: unknown): value is string {
  return typeof value === "string" && STUDY_ID_PATTERN.test(value);
}

export function isSurveyId(value: unknown): value is string {
  return typeof value === "string" && SURVEY_ID_PATTERN.test(value);
}

/** Two choices are one when both ids are. */
export function sameChoice(a: SurveyChoice | null | undefined, b: SurveyChoice | null | undefined): boolean {
  return !!a && !!b && a.study === b.study && a.surveyId === b.surveyId;
}

/**
 * `<study>/<surveyId>`: how a choice is written where one string is wanted (a
 * remembered link, a storage key). Unambiguous because neither id can hold a `/`.
 */
export function choiceKey(choice: SurveyChoice): string {
  return `${choice.study}/${choice.surveyId}`;
}

export type LinkReading =
  /** The address names no survey: the iPad keeps the one it is on. */
  | { kind: "none" }
  | { kind: "choice"; choice: SurveyChoice }
  /** Something was there and it is not a link MySelf can use; `problem` says why, for staff. */
  | { kind: "invalid"; problem: string };

/**
 * What an address's query string asks for.
 *
 * - Neither parameter: nothing. The bare address is no instruction (docs/16
 *   §11.2), which is what keeps every iPad and link in use today as it is.
 * - `survey` alone: that survey of the default study.
 * - Both: that survey of that study.
 * - `study` alone, either one twice, or an id off its pattern: refused, with
 *   the reason in words. Twice is refused rather than one picked, because a
 *   link that two readers could take two ways is a link that files a sitting
 *   somewhere nobody chose.
 *
 * `URLSearchParams` decodes `%2F` to `/` and `+` to a space before the pattern
 * sees them, so an encoded separator is refused like a plain one.
 */
export function readParticipantLink(search: string | URLSearchParams, defaultStudy: string): LinkReading {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const studies = params.getAll(LINK_PARAMS.study);
  const surveys = params.getAll(LINK_PARAMS.survey);
  if (studies.length === 0 && surveys.length === 0) return { kind: "none" };
  if (studies.length > 1) return { kind: "invalid", problem: "it names more than one study" };
  if (surveys.length > 1) return { kind: "invalid", problem: "it names more than one survey" };
  if (surveys.length === 0) return { kind: "invalid", problem: "it names a study but not which of its surveys to run" };
  const study = studies[0] ?? defaultStudy;
  const survey = surveys[0]!;
  if (!isStudyId(study)) return { kind: "invalid", problem: `“${clip(study)}” is not a study id` };
  if (!isSurveyId(survey)) return { kind: "invalid", problem: `“${clip(survey)}” is not a survey id` };
  return { kind: "choice", choice: { study, surveyId: survey } };
}

/**
 * What staff typed or pasted into the handover panel: a whole participant link,
 * `study/survey`, or a survey id alone (the default study's). Read by the same
 * rules as a link, so the panel cannot set an iPad to anything a link could not.
 */
export function readTypedChoice(text: string, defaultStudy: string): LinkReading {
  const typed = text.trim();
  if (typed === "") return { kind: "none" };
  if (/^https?:\/\//i.test(typed)) {
    let url: URL;
    try {
      url = new URL(typed);
    } catch {
      return { kind: "invalid", problem: "that is not a whole link" };
    }
    const reading = readParticipantLink(url.searchParams, defaultStudy);
    return reading.kind === "none" ? { kind: "invalid", problem: "that link does not name a survey" } : reading;
  }
  const parts = typed.split("/");
  if (parts.length > 2) return { kind: "invalid", problem: "write it as study/survey" };
  const [first, second] = parts as [string, string | undefined];
  const study = second === undefined ? defaultStudy : first;
  const survey = second === undefined ? first : second;
  if (!isStudyId(study)) return { kind: "invalid", problem: `“${clip(study)}” is not a study id` };
  if (!isSurveyId(survey)) return { kind: "invalid", problem: `“${clip(survey)}” is not a survey id` };
  return { kind: "choice", choice: { study, surveyId: survey } };
}

/**
 * The participant link for a survey, from the address the participant app is
 * served at. Both parameters, always — the default survey included, so that a
 * link to it moves an iPad back from wherever it was sent. Throws on an id off
 * its pattern: a link nobody can follow is worse than no link.
 */
export function participantLink(base: string, choice: SurveyChoice): string {
  if (!isStudyId(choice.study)) throw new Error(`“${choice.study}” is not a study id`);
  if (!isSurveyId(choice.surveyId)) throw new Error(`“${choice.surveyId}” is not a survey id`);
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  url.searchParams.set(LINK_PARAMS.study, choice.study);
  url.searchParams.set(LINK_PARAMS.survey, choice.surveyId);
  return url.toString();
}

/** Enough of a refused value to recognise it, never a paragraph of somebody's paste. */
function clip(value: string): string {
  return value.length > 48 ? `${value.slice(0, 45)}…` : value;
}
