import { choiceKey, isStudyId, isSurveyId, sameChoice, type LinkReading, type SurveyChoice } from "@myself/schema";
import {
  getCachedRelease,
  getReleaseState,
  getSelection,
  putCachedRelease,
  saveReleaseState,
  saveSelection,
  type ReleaseStateKey,
  type SelectionRow,
} from "./db.js";
import { BUILT_IN, releaseService, type CheckOutcome, type LoadedRelease, type ReleaseService } from "./releases.js";

/**
 * Which survey of which study this iPad runs (D-56, docs/16 §11.3).
 *
 * Until study spaces, the answer was baked into the build: one study, one
 * survey. It still is, for every iPad that has never been given a participant
 * link — that is the DEFAULT, with its built-in release — and an iPad can now
 * be sent to any survey a study has published, by a link or by staff in the
 * handover panel, and remembers it.
 *
 * THE RULES, each one a way a sitting could otherwise land in the wrong place:
 *
 *   - A CHOICE IS ADOPTED ONLY ONCE IT HAS BEEN PROVED. The study is in the
 *     registry and open, the survey has a live version, and that release
 *     downloads and verifies as this survey of this study. Until then the iPad
 *     stays where it was. Nothing is half-adopted.
 *   - ANY SURVEY BUT THE DEFAULT HAS NO BUILT-IN RELEASE. It is loaded online
 *     once, then cached, and runs offline from then on. A device that cannot
 *     load it says so; it never runs the default's questions under its name.
 *   - A LINK IS FOLLOWED ONCE (`lastLink`). A Home-Screen app saved from a link
 *     opens on it every time, and must not undo what staff have changed since.
 *   - A SITTING STAYS WHERE IT STARTED. The choice decides where a NEW sitting
 *     starts; a sitting's own row says where it is resumed and filed.
 *
 * The survey's own address is the build's: only the study id from a link is
 * appended to it, after the pattern has refused anything that could carry a
 * `/`. A link can choose a study and a survey, never a host.
 */

declare const __STUDY__: string;
declare const __SURVEY_ID__: string;
declare const __SURVEY_SOURCE__: string;
declare const __STUDIES_SOURCE__: string;

/** What this build runs when nobody has chosen anything else: today's study and survey. */
export const DEFAULT_CHOICE: SurveyChoice = Object.freeze({
  study: __STUDY__ || "ybm",
  surveyId: __SURVEY_ID__ || "ybm_nd2026_standard",
});

export function isDefaultChoice(choice: SurveyChoice, defaults: SurveyChoice = DEFAULT_CHOICE): boolean {
  return sameChoice(choice, defaults);
}

/**
 * The release-state row a survey's active release is kept in: `active` for the
 * default, exactly as before, so an iPad that never leaves it reads and writes
 * the same row it always did.
 */
export function stateKeyFor(choice: SurveyChoice, defaults: SurveyChoice = DEFAULT_CHOICE): ReleaseStateKey {
  return isDefaultChoice(choice, defaults) ? "active" : `active:${choiceKey(choice)}`;
}

export interface SourceConfig {
  /** The default study's own base (`__SURVEY_SOURCE__`). */
  surveySource: string;
  /** The parent of every study's base (`__STUDIES_SOURCE__`). */
  studiesSource: string;
  defaultStudy: string;
}

const BUILD_SOURCES: SourceConfig = {
  surveySource: __SURVEY_SOURCE__,
  studiesSource: __STUDIES_SOURCE__,
  defaultStudy: DEFAULT_CHOICE.study,
};

/**
 * The Firestore REST base for a study: `…/documents/studies/{study}`, which is
 * also its registry document. The default's is the one this build always used;
 * any other is the build's parent with the (already checked) id appended. Empty
 * when this build cannot reach that study, which the check reports as such.
 */
export function sourceFor(study: string, config: SourceConfig = BUILD_SOURCES): string {
  if (study === config.defaultStudy) return config.surveySource;
  return config.studiesSource ? `${config.studiesSource}/${study}` : "";
}

const services = new Map<string, ReleaseService<LoadedRelease | null>>();

/**
 * The release service for one survey, made once per page. The default keeps
 * its built-in release and reads the registry only to learn it has been
 * closed; any other has no fallback and needs its study to be registered.
 */
export function serviceFor(choice: SurveyChoice): ReleaseService<LoadedRelease | null> {
  const key = choiceKey(choice);
  const made = services.get(key);
  if (made) return made;
  const stateKey = stateKeyFor(choice);
  const isDefault = isDefaultChoice(choice);
  const service = releaseService({
    builtIn: isDefault ? BUILT_IN : null,
    cache: {
      get: getCachedRelease,
      put: putCachedRelease,
      state: () => getReleaseState(stateKey),
      saveState: (patch) => saveReleaseState(patch, stateKey),
    },
    source: sourceFor(choice.study),
    surveyId: choice.surveyId,
    study: choice.study,
    registry: isDefault ? "optional" : "required",
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  });
  services.set(key, service);
  return service;
}

// ---------------------------------------------------------------------------
// What a check means for choosing a survey
// ---------------------------------------------------------------------------

export type ChoiceVerdict =
  /** Proved and on the device: it can be run now, offline from here on. */
  | { kind: "ready"; title: string | null; version: string | null }
  /** A definite no: said plainly, and the iPad stays where it was. */
  | { kind: "refused"; reason: string }
  /** Could not ask (offline, unreachable): try again when the network returns. */
  | { kind: "unreachable"; reason: string };

/**
 * What a release check found, as an answer to "can this iPad run that survey".
 * Pure. Worded for staff — the person who opened the link or the panel — and
 * every refusal says what is wrong, not that something is.
 */
export function verdictOf(outcome: CheckOutcome, isDefault: boolean): ChoiceVerdict {
  switch (outcome.kind) {
    case "activated":
    case "up_to_date":
      return { kind: "ready", title: null, version: outcome.version };
    case "nothing_published":
      return isDefault
        ? { kind: "ready", title: null, version: null }
        : { kind: "refused", reason: "that survey has no live version: it has not been published in the Studio yet" };
    case "not_configured":
      return isDefault
        ? { kind: "ready", title: null, version: null }
        : { kind: "refused", reason: "this copy of MySelf can only run its own survey" };
    case "study_unknown":
      return { kind: "refused", reason: "there is no such study in this project" };
    case "study_closed":
      return { kind: "refused", reason: `the study${outcome.title ? ` “${outcome.title}”` : ""} is closed` };
    case "refused":
      return { kind: "refused", reason: `its live version can't be used on this iPad: ${outcome.reason}` };
    case "offline":
      return { kind: "unreachable", reason: "this iPad is offline" };
    case "unreachable":
      return { kind: "unreachable", reason: `the study could not be reached (${outcome.reason})` };
    case "failed":
      return { kind: "unreachable", reason: outcome.reason };
  }
}

/**
 * Check a survey, online, and keep its release if it proves itself.
 *
 * The default needs no network: it has its built-in release whatever the
 * study says, so it is always ready (and a check runs in the background as on
 * any start screen). For any other survey, its registry, its live pointer and
 * its release are checked by its own service — the same code that keeps it up
 * to date afterwards — and `ready` means the release is now cached here.
 */
export async function checkChoice(choice: SurveyChoice): Promise<ChoiceVerdict> {
  const service = serviceFor(choice);
  if (isDefaultChoice(choice)) {
    void service.refreshActiveRelease();
    return { kind: "ready", title: BUILT_IN.manifest.composition.title, version: null };
  }
  const result = await service.refreshActiveRelease();
  const verdict = verdictOf(result.record.outcome, false);
  if (verdict.kind !== "ready") return verdict;
  const loaded = result.activeHash ? await service.releaseForHash(result.activeHash) : null;
  if (!loaded) return { kind: "unreachable", reason: "its release could not be kept on this iPad" };
  return { kind: "ready", title: loaded.manifest.composition.title, version: loaded.manifest.release.version };
}

// ---------------------------------------------------------------------------
// The link in the address
// ---------------------------------------------------------------------------

export type LinkPlan =
  | { kind: "none" }
  | { kind: "invalid"; problem: string }
  /** The link names the survey the iPad is on already. Remembered as followed, nothing else. */
  | { kind: "same"; choice: SurveyChoice }
  /** Followed before; staff may have moved the iPad since. Said, not acted on. */
  | { kind: "followed"; choice: SurveyChoice }
  | { kind: "follow"; choice: SurveyChoice };

/** What to do with what the address says, given where the iPad is and which link it last followed. Pure. */
export function planLink(reading: LinkReading, current: SurveyChoice, lastLink: string | null): LinkPlan {
  if (reading.kind === "none") return reading;
  if (reading.kind === "invalid") return reading;
  const { choice } = reading;
  if (sameChoice(choice, current)) return { kind: "same", choice };
  if (lastLink === choiceKey(choice)) return { kind: "followed", choice };
  return { kind: "follow", choice };
}

// ---------------------------------------------------------------------------
// Remembering it
// ---------------------------------------------------------------------------

export interface StoredChoice {
  choice: SurveyChoice;
  row: SelectionRow | undefined;
}

/**
 * The survey this iPad is set to, from its own storage: the default when
 * nothing was ever chosen — or when what is stored is not two ids a link could
 * have carried, which only a damaged row could be. It is held to the same
 * patterns as a link because it becomes part of an address the same way.
 */
export async function storedChoice(): Promise<StoredChoice> {
  const row = await getSelection();
  const usable = row !== undefined && isStudyId(row.study) && isSurveyId(row.surveyId);
  return { choice: usable ? { study: row.study, surveyId: row.surveyId } : DEFAULT_CHOICE, row: usable ? row : undefined };
}

/** Set this iPad to a survey. `lastLink` is kept unless a link is what set it. */
export async function rememberChoice(
  choice: SurveyChoice,
  how: SelectionRow["chosenBy"],
  previous: SurveyChoice,
  lastLink: string | null,
): Promise<void> {
  await saveSelection({
    study: choice.study,
    surveyId: choice.surveyId,
    chosenAt: new Date().toISOString(),
    chosenBy: how,
    previous: sameChoice(previous, choice) ? null : { study: previous.study, surveyId: previous.surveyId },
    lastLink,
  });
}

/** Record that the link in the address has been followed, without moving the iPad. */
export async function rememberLinkFollowed(current: SurveyChoice, row: SelectionRow | undefined, link: string): Promise<void> {
  await saveSelection({
    study: current.study,
    surveyId: current.surveyId,
    chosenAt: row?.chosenAt ?? new Date().toISOString(),
    chosenBy: row?.chosenBy ?? "link",
    previous: row?.previous ?? null,
    lastLink: link,
  });
}
