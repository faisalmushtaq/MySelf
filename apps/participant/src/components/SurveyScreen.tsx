import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnswerStore,
  Walker,
  checkConsistency,
  visibleOptions,
  type AnswerValue,
  type PresentableUnit,
} from "@myself/engine";
import type { ItemDefinition, ResponseScale } from "@myself/schema";
import { resolveText } from "../lib/pipes.js";
import { gridRowsFor } from "../lib/timegrid.js";
import { dwellHintMs, wordCount, type DwellPolicy } from "../lib/timing.js";
import { Illustration } from "./illustrations.js";
import {
  CheckboxSetControl,
  DateControl,
  FormFieldsControl,
  LadderControl,
  MultiChoice,
  NumericControl,
  RankGroupControl,
  SingleChoice,
  SliderControl,
  TextControl,
  TimeGridControl,
} from "./controls/index.js";
import { NarrativeStep } from "./NarrativeStep.js";

export interface EffortPolicy extends DwellPolicy {
  confirmSkip: boolean;
  skipRunCheckIn: number;
  tooFastSeconds: number;
  tooFastWordsPerSecond: number;
  tooFastMaxSeconds: number;
  tooFastRunPrompt: number;
  /** Reassure someone stuck on an unanswered question (D-70); on unless the release says otherwise. */
  stuckPrompt?: boolean | undefined;
  /** …and offer to skip it, when it is not hard-required. */
  stuckPromptOffersSkip?: boolean | undefined;
}

/**
 * Questions where a long pause is the work itself — writing, reading consent
 * statements — and is not a sign of being stuck.
 */
const NO_STUCK_PROMPT = new Set<string>(["info", "text_short", "text_long", "form_fields", "checkbox_set"]);

/**
 * Leaving the home address blank (D-71): it is how answers are linked to
 * records (UPRN), so a skip is asked about three times, each time with a
 * reason to fill in what they know. Still a choice: the third "Yes, skip" lets
 * them go. Any other question asks once.
 */
const ADDRESS_SKIP_PROMPTS = [
  {
    question: "Your address really matters to this study.",
    detail: "It is how we link your answers to your health and education records. Could you fill in what you know — even just your street?",
    go: "Skip anyway",
  },
  {
    question: "Not sure of your postcode?",
    detail: "That's fine — leave it out. Your house number and street on their own help a lot.",
    go: "Skip anyway",
  },
  { question: "Last check: leave your address blank?", detail: null, go: "Yes, skip it" },
] as const;

/** Five taps within this long on the progress bar open the researcher's wrap-up (D-70). */
const STAFF_TAPS = 5;
const STAFF_TAP_WINDOW_MS = 4000;

export interface SurveyScreenProps {
  units: PresentableUnit[];
  /**
   * Where the narrative module is served from, and what to tell it.
   *
   * Absent when this build has no module configured, in which case a
   * narrative position says so rather than showing an empty frame.
   */
  narrative?:
    | {
        moduleUrl: string | null;
        sessionId: string;
        releaseHash: string;
        /** The sitting's study (D-56), which the module acts in. Absent means the default. */
        study?: string | undefined;
        firstName?: string | undefined;
        /** The release's frozen protocols, by `key@version`; the module is sent its own. */
        protocols?: Record<string, unknown> | undefined;
        /** A preview of a draft (Studio's preview), which never starts the module. */
        preview?: boolean | undefined;
        /**
         * Reads this iPad's credential for the module (D-55). Supplied by the app,
         * which owns the device's identity; never by a preview, which must not
         * reach it.
         */
        credential?: (() => Promise<string | null>) | undefined;
      }
    | undefined;
  scales: Map<string, ResponseScale>;
  store: AnswerStore;
  allowBack: boolean;
  sectionTitles: Map<string, string>;
  index: number;
  sessionStart: Date;
  effort: EffortPolicy;
  /** Instrument instructions for this item, re-shown on request. */
  context?: string | undefined;
  onRecord: (unit: PresentableUnit, value: AnswerValue) => void;
  onAdvance: (from: number, kind: "next" | "skip" | "decline") => void;
  onBack: (from: number) => void;
  /**
   * This question was opened from the end-of-survey summary to change one answer.
   * In that mode both "Back to summary" and the primary button return to the
   * summary, so a participant correcting one answer is never dropped back into
   * the middle of the survey with a walk to the end ahead of them.
   */
  reviewEdit?: boolean;
  onEvent: (type: string, payload?: Record<string, unknown>) => void;
  /**
   * Five taps on the progress bar: a researcher asking for the wrap-up (D-70).
   * Absent where there is no researcher to ask for (a preview).
   */
  onStaffGesture?: () => void;
}

export function SurveyScreen(props: SurveyScreenProps) {
  const { units, scales, store, allowBack, index, sessionStart, effort } = props;
  const unit = units[index];
  const startTime = sessionStart.getTime();
  const walker = useMemo(
    () => new Walker(units, store, allowBack, new Date(startTime)),
    [units, store, allowBack, startTime],
  );
  /** How many times leaving this question blank has been asked about (0: not yet). */
  const [skipAsked, setSkipAsked] = useState(0);
  const confirmingSkip = skipAsked > 0;
  // Draft validity reported by the control on screen (formats, required parts).
  const [draft, setDraft] = useState<{ ok: boolean; complete: boolean } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** Message when this answer contradicts an earlier one (D-25). */
  const [inconsistency, setInconsistency] = useState<string | null>(null);
  const [dwelling, setDwelling] = useState(false);
  /** Reassurance shown to someone stuck on this question, until they answer or close it (D-70). */
  const [stuck, setStuck] = useState(false);
  const staffTaps = useRef<number[]>([]);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    setSkipAsked(0);
    setDraft(null);
    setHelpOpen(false);
    setMoreOpen(false);
    setInconsistency(null);
    setDwelling(false);
    setStuck(false);
    headingRef.current?.focus();
    return () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    };
  }, [index]);

  /**
   * Dwell detection: if someone sits on one question far longer than it takes
   * to read it, quietly offer help rather than leaving them stuck. The offer
   * appears once per item and is recorded as paradata (response-time flag).
   */
  // The wait restarts whenever the participant touches the screen: someone
  // trying answers, scrolling or typing is working, not stuck (D-70).
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellShown = useRef(false);
  const armDwell = useRef<() => void>(() => {});
  useEffect(() => {
    dwellShown.current = false;
    if (unit?.item.responseType === "info") return;
    const item = unit?.item;
    const statements = item?.responseType === "checkbox_set" ? item.statements.map((st) => st.text.text) : [];
    const waitMs = dwellHintMs(wordCount(item?.stem.text, item?.lede?.text, ...statements), effort);
    armDwell.current = () => {
      if (dwellTimer.current) clearTimeout(dwellTimer.current);
      if (dwellShown.current) return;
      dwellTimer.current = setTimeout(() => {
        dwellShown.current = true;
        setDwelling(true);
        props.onEvent("hint.shown", { reason: "dwell", afterMs: waitMs });
        const answeredNow = item && unit ? store.get({ instrument: unit.instrument, item: item.key, revision: item.revision })?.status === "answered" : true;
        if (item && effort.stuckPrompt !== false && !NO_STUCK_PROMPT.has(item.responseType) && !answeredNow) {
          setStuck(true);
          props.onEvent("effort.stuck_prompt_shown", { afterMs: waitMs });
        }
      }, waitMs);
    };
    armDwell.current();
    return () => {
      if (dwellTimer.current) clearTimeout(dwellTimer.current);
    };
  }, [index, effort]);

  /**
   * Enter continues, for anyone using a keyboard. Ignored while typing in a
   * field so text answers are never hijacked. Option selection is by tap,
   * click, Tab+Space or arrow keys — there are no shortcut letters to learn.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement
      ) {
        return;
      }
      const next = document.querySelector<HTMLButtonElement>("button.next:not(:disabled)");
      if (next) {
        e.preventDefault();
        next.click();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [index]);

  if (!unit) return null;

  /**
   * A narrative position: hand over to the module rather than draw a question.
   *
   * Before the rest of the screen's work, because none of it applies — there
   * is no scale, no answer to record, and the marker item exists only so the
   * walk can count this position like any other.
   */
  if (unit.narrative) {
    const handover = props.narrative;
    // Whether anything follows. When MyStory is the last position, the finish
    // screen comes next, and the words on the way out should say so.
    const last = walker.next(index) === null;
    if (handover?.preview) {
      // A preview stores nothing and sends nothing, and the module would do
      // both: a run filed against a sitting that does not exist, and model
      // calls on the study's account. So its place is shown, not run.
      return (
        <div className="screen survey">
          <div className="narrative-step">
            <div className="narrative-after">
              <p>
                MyStory would start here ({unit.narrative.protocol}@{unit.narrative.version}). A preview does not run
                it, so nothing is sent to the model or saved.
              </p>
              <button type="button" className="primary" onClick={() => props.onAdvance(index, "next")}>
                {last ? "Finish" : "Keep going"}
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (!handover?.moduleUrl) {
      // A build with no module configured. Said plainly rather than shown as
      // an empty rectangle, and never a dead end: the sitting must be
      // finishable whatever else is broken.
      return (
        <div className="screen survey">
          <div className="narrative-step">
            <div className="narrative-after">
              <p>This part of the study is not available on this device.</p>
              <button type="button" className="primary" onClick={() => props.onAdvance(index, "skip")}>
                {last ? "Finish" : "Keep going"}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="screen survey narrative-screen">
        <NarrativeStep
          moduleUrl={handover.moduleUrl}
          protocol={unit.narrative.protocol}
          protocolVersion={unit.narrative.version}
          definition={handover.protocols?.[`${unit.narrative.protocol}@${unit.narrative.version}`]}
          last={last}
          sessionId={handover.sessionId}
          releaseHash={handover.releaseHash}
          study={handover.study}
          firstName={handover.firstName}
          credential={handover.credential}
          onEvent={props.onEvent}
          onDone={() => props.onAdvance(index, "next")}
        />
      </div>
    );
  }

  const item = unit.item;
  const baseScale = "scale" in item ? scales.get(item.scale) : undefined;
  // Earlier answers as the walk now stands: one to a question a later change
  // hid is stale, and must not be piped, checked against or limit options.
  const answers = walker.visibleAnswers();
  // Options this participant could not truthfully choose are not offered —
  // an age older than they are is not an answer we want to be able to record.
  const scale =
    baseScale && item.responseType === "single_choice" && item.limitOptions
      ? { ...baseScale, options: visibleOptions(item.limitOptions, baseScale.options, answers, new Date()) }
      : baseScale;
  const record = store.get({ instrument: unit.instrument, item: item.key, revision: item.revision });
  const answered = record?.status === "answered";
  const progress = walker.sectionProgress(index);
  const stemText = resolveText(item.stem.text, item.stem.pipes, answers, sessionStart);

  const resolvedItem: ItemDefinition =
    item.responseType === "checkbox_set"
      ? {
          ...item,
          statements: item.statements.map((s) => ({
            ...s,
            text: { ...s.text, text: resolveText(s.text.text, s.text.pipes, answers, sessionStart) },
          })),
        }
      : item;

  const consentComplete =
    item.responseType !== "checkbox_set" ||
    (record?.status === "answered" &&
      record.value?.kind === "checkboxes" &&
      item.statements.filter((s) => s.required).every((s) => record.value!.kind === "checkboxes" && record.value!.checked.includes(s.key)));

  // A visible format error blocks advancing whatever the requirement level:
  // nobody should be able to move past a field the screen is calling wrong,
  // and no earlier valid value should be carried forward behind an error.
  const draftBlocked = (draft !== null && !draft.ok) || inconsistency !== null;
  // Once a control reports on itself, what is on screen is the truth — not what
  // happens to be in the store. So a complete draft counts as answered before
  // the autosave debounce fires (nobody waits on a disabled button after typing
  // a good answer), and clearing a field back to blank stops counting as one
  // even if an earlier value was already recorded.
  const satisfied = (draft !== null ? draft.complete : answered) && consentComplete;
  /** The home address, which records are linked by (D-52, D-71): its form carries the postcode check. */
  const isAddress = item.responseType === "form_fields" && "postcodeCheck" in item && item.postcodeCheck != null;
  const canAdvance =
    item.responseType === "info" ||
    (!draftBlocked && (item.required === "hard" ? satisfied : true));

  const handleAnswer = (value: AnswerValue, autoAdvance: boolean | { afterMs: number }) => {
    // An answer that contradicts an earlier one is still recorded — it is what
    // the participant said, and the raw log is never edited. But the screen
    // says so and holds here, because right now they can tell us which of the
    // two is right; after the session, nobody can.
    const conflict = checkConsistency(item, value, scale, walker.visibleAnswers());
    setInconsistency(conflict);
    props.onRecord(unit, value);
    if (conflict) {
      props.onEvent("response.inconsistent", {
        with: item.crossChecks?.[0]?.against,
        kind: item.crossChecks?.[0]?.kind,
      });
      return; // never auto-advance past a contradiction
    }
    if (autoAdvance) {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      const afterMs = typeof autoAdvance === "object" ? autoAdvance.afterMs : 300;
      advanceTimer.current = setTimeout(() => props.onAdvance(index, "next"), afterMs);
    } else if (advanceTimer.current) {
      // A later input that does not complete the screen (an untick straight
      // after the last tick) cancels a move that was about to happen.
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  };

  const handleNext = () => {
    // Pressing Next while an automatic move is pending takes its place: the
    // item is left once, not once by hand and again by the timer.
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    if (item.responseType === "info") return props.onAdvance(index, "next");
    if (draftBlocked) return; // button is disabled; belt and braces
    if (satisfied) return props.onAdvance(index, "next");
    if (item.required === "hard") return; // button disabled anyway
    // Blank and skippable — including a field the participant has just emptied,
    // which is recorded as a skip so the data matches what was left on screen.
    // Ask once, in place, before letting it go — the home address three times (D-71).
    const asks = isAddress ? ADDRESS_SKIP_PROMPTS.length : effort.confirmSkip ? 1 : 0;
    if (skipAsked < asks) {
      if (isAddress) props.onEvent("skip.prompted", { ask: skipAsked + 1, of: asks });
      setSkipAsked(skipAsked + 1);
      return;
    }
    props.onEvent("skip.confirmed");
    props.onAdvance(index, "skip");
  };

  const controlProps = {
    item: resolvedItem,
    scale,
    // A time grid asks about what was chosen earlier, as the walk now stands.
    rows: item.responseType === "time_grid" ? gridRowsFor(item, units, scales, answers).rows : undefined,
    value: record?.value,
    onAnswer: handleAnswer,
    onValidity: setDraft,
    // Enter on a typed answer advances, mirroring choice auto-advance. The
    // handler still respects validity, so it can never skip a bad entry.
    onSubmit: () => {
      window.setTimeout(() => {
        const next = document.querySelector<HTMLButtonElement>("button.next:not(:disabled)");
        next?.click();
      }, 0);
    },
  };
  /**
   * Identity of the question on screen. Used as a React key so every control
   * remounts between questions: without it React reuses the control instance
   * and its internal draft state (e.g. typed text) bleeds into the next item.
   */
  const unitKey = `${unit.instrument}.${item.key}#${item.revision}`;

  /** Five quick taps on the progress bar: the researcher's wrap-up (D-70). Nothing a participant sees changes. */
  const onProgressTap = () => {
    if (!props.onStaffGesture) return;
    const now = Date.now();
    staffTaps.current = [...staffTaps.current.filter((t) => now - t < STAFF_TAP_WINDOW_MS), now];
    if (staffTaps.current.length >= STAFF_TAPS) {
      staffTaps.current = [];
      props.onStaffGesture();
    }
  };
  const stuckSkip = stuck && !answered && effort.stuckPromptOffersSkip !== false && item.required !== "hard";

  return (
    <div className="screen survey" onPointerDown={() => armDwell.current()} onKeyDown={() => armDwell.current()}>
      <header className="survey-header">
        {/* Named, not just an arrow: a bare chevron in a corner is missed, and
            people who want to change an answer need to see the way back. */}
        {props.reviewEdit ? (
          // Always offered when correcting one answer from the summary — even on
          // the first question, where ordinary back-navigation has nowhere to go —
          // because it returns to the summary, not to the previous question.
          <button type="button" className="back" onClick={() => props.onBack(index)}>
            <span className="back-arrow" aria-hidden="true">
              ‹
            </span>
            Back to summary
          </button>
        ) : allowBack && walker.back(index) !== null ? (
          <button type="button" className="back" onClick={() => props.onBack(index)}>
            <span className="back-arrow" aria-hidden="true">
              ‹
            </span>
            Back
          </button>
        ) : (
          <span className="back-spacer" />
        )}
        <div className="segments" aria-label={`Section ${progress.activeIndex + 1} of ${progress.sections.length}`} onClick={onProgressTap}>
          {progress.sections.map((s, i) => (
            <span key={s} className={`segment${i < progress.activeIndex ? " done" : i === progress.activeIndex ? " active" : ""}`} />
          ))}
        </div>
      </header>

      <main className="survey-body">
        {/* An information screen carrying its own body text gets a real title,
            set like every other question. A short instruction screen is set at
            question size too — it was reading as a footnote next to everything
            around it. Only genuinely long prose drops to body size, where
            question sizing would be a wall. */}
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={
            item.responseType === "info" && !item.lede && stemText.length > 600
              ? "info-text"
              : `stem${stemText.length > 110 ? " stem-long" : ""}`
          }
        >
          {stemText}
        </h1>
        {/* Framing that used to be its own click-through page. Keeping it with
            the control means the explanation is still on screen when the
            answer is given. */}
        {item.lede && (
          <p className={`lede${item.responseType === "info" ? " lede-body" : ""}`}>
            {resolveText(item.lede.text, item.lede.pipes, answers, sessionStart)}
          </p>
        )}
        {/* Detail on request — data handling, mostly. Available from the screen
            it belongs to, never in the way of getting started. */}
        {item.moreInfo && (
          <div className="more-info">
            <button
              type="button"
              className="more-info-toggle"
              aria-expanded={moreOpen}
              onClick={() => {
                const next = !moreOpen;
                setMoreOpen(next);
                if (next) props.onEvent("hint.shown", { reason: "more_info", label: item.moreInfo?.label });
              }}
            >
              <span className="more-info-caret" aria-hidden="true">
                {moreOpen ? "▾" : "▸"}
              </span>
              {item.moreInfo.label}
            </button>
            {moreOpen && (
              <div className="more-info-body">
                {resolveText(item.moreInfo.body.text, item.moreInfo.body.pipes, answers, sessionStart)}
              </div>
            )}
          </div>
        )}
        {item.illustration && (
          <span
            // On a left-to-right spectrum the drawing is centred over the
            // axis. Left-aligned it sat directly above the leftmost option,
            // which is a nudge towards "left" on a question about which hand
            // you use (D-32).
            className={`stem-object${item.responseType === "single_choice" && item.presentation === "spectrum" ? " centred" : ""}`}
          >
            <Illustration token={item.illustration} />
          </span>
        )}
        <SingleChoice key={`sc-${unitKey}`} {...controlProps} />
        <MultiChoice key={`mc-${unitKey}`} {...controlProps} />
        <SliderControl key={`sl-${unitKey}`} {...controlProps} />
        <LadderControl key={`ld-${unitKey}`} {...controlProps} />
        <NumericControl key={`nu-${unitKey}`} {...controlProps} />
        <DateControl key={`dt-${unitKey}`} {...controlProps} />
        <TextControl key={`tx-${unitKey}`} {...controlProps} />
        <FormFieldsControl key={`ff-${unitKey}`} {...controlProps} />
        <RankGroupControl key={`rg-${unitKey}`} {...controlProps} />
        <CheckboxSetControl key={`cb-${unitKey}`} {...controlProps} />
        <TimeGridControl key={`tg-${unitKey}`} {...controlProps} />

        {inconsistency && (
          <p className="error inconsistency" role="alert">
            {inconsistency}
          </p>
        )}

        {/* Someone still on an unanswered question long after they could have
            read it: reassure, once, and offer a way past (D-70). */}
        {stuck && !answered && (
          <div className="stuck-prompt" role="status">
            <p className="stuck-text">Take your time. If you're not sure, choose the answer that fits best.</p>
            {item.hint && <p className="help-hint">{item.hint}</p>}
            <div className="stuck-actions">
              {stuckSkip && (
                <button
                  type="button"
                  className="stuck-skip"
                  onClick={() => {
                    props.onEvent("effort.stuck_skip");
                    props.onAdvance(index, "skip");
                  }}
                >
                  Skip this one
                </button>
              )}
              <button type="button" className="stuck-ok" onClick={() => setStuck(false)}>
                OK
              </button>
            </div>
          </div>
        )}

        {/* Context and help: opened by the participant, or offered after a long
            pause. Rendered inside the body so nothing below it moves. */}
        {(props.context || item.hint) && (
          <div className="help-area">
            {!helpOpen && (
              <button
                type="button"
                className={`help-toggle${dwelling ? " nudge" : ""}`}
                onClick={() => {
                  setHelpOpen(true);
                  props.onEvent("hint.shown", { reason: "requested" });
                }}
              >
                {dwelling ? "Need a hand with this one?" : "Remind me what this is about"}
              </button>
            )}
            {helpOpen && (
              <div className="help-panel" role="status">
                {item.hint && <p className="help-hint">{item.hint}</p>}
                {props.context && <p className="help-context">{props.context}</p>}
                <button type="button" className="help-close" onClick={() => setHelpOpen(false)}>
                  Got it
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="survey-footer">
        {/* Skip confirmation lives in a reserved strip: asking never reflows
            the question above it. */}
        {confirmingSkip ? (
          <div className="skip-confirm" role="alertdialog" aria-label="Skip this question?">
            {isAddress ? (
              <div className="skip-question">
                <p className="skip-lead">{ADDRESS_SKIP_PROMPTS[Math.min(skipAsked, ADDRESS_SKIP_PROMPTS.length) - 1]!.question}</p>
                {ADDRESS_SKIP_PROMPTS[Math.min(skipAsked, ADDRESS_SKIP_PROMPTS.length) - 1]!.detail ? (
                  <p className="skip-detail">{ADDRESS_SKIP_PROMPTS[Math.min(skipAsked, ADDRESS_SKIP_PROMPTS.length) - 1]!.detail}</p>
                ) : null}
              </div>
            ) : (
              <p className="skip-question">Leave this one blank?</p>
            )}
            {/* "Skip" sits first and quiet, where the Next button was, so the
                tap that opened this strip does not land straight on it.
                "I'll answer it" takes the prominent right-hand position the
                thumb returns to. Skipping stays one tap away — it is just no
                longer the accidental one. */}
            <div className="skip-actions">
              <button type="button" className="skip-go" onClick={handleNext}>
                {isAddress ? ADDRESS_SKIP_PROMPTS[Math.min(skipAsked, ADDRESS_SKIP_PROMPTS.length) - 1]!.go : "Skip"}
              </button>
              <button
                type="button"
                className="skip-back"
                onClick={() => {
                  setSkipAsked(0);
                  props.onEvent("skip.abandoned");
                }}
              >
                {isAddress ? "I'll fill it in" : "I'll answer it"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {item.allowDecline && !answered && (
              <button type="button" className="decline" onClick={() => props.onAdvance(index, "decline")}>
                Prefer not to say
              </button>
            )}
            <button type="button" className="next" disabled={!canAdvance} onClick={handleNext}>
              {props.reviewEdit ? "Save" : item.responseType === "info" ? (item.advanceLabel ?? "Continue") : "Next"}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
