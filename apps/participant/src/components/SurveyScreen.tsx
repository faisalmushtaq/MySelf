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
} from "./controls.js";
import { NarrativeStep } from "./NarrativeStep.js";

export interface EffortPolicy extends DwellPolicy {
  confirmSkip: boolean;
  skipRunCheckIn: number;
  tooFastSeconds: number;
  tooFastWordsPerSecond: number;
  tooFastMaxSeconds: number;
  tooFastRunPrompt: number;
}

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
        firstName?: string | undefined;
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
}

export function SurveyScreen(props: SurveyScreenProps) {
  const { units, scales, store, allowBack, index, sessionStart, effort } = props;
  const unit = units[index];
  const startTime = sessionStart.getTime();
  const walker = useMemo(
    () => new Walker(units, store, allowBack, new Date(startTime)),
    [units, store, allowBack, startTime],
  );
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  // Draft validity reported by the control on screen (formats, required parts).
  const [draft, setDraft] = useState<{ ok: boolean; complete: boolean } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** Message when this answer contradicts an earlier one (D-25). */
  const [inconsistency, setInconsistency] = useState<string | null>(null);
  const [dwelling, setDwelling] = useState(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    setConfirmingSkip(false);
    setDraft(null);
    setHelpOpen(false);
    setMoreOpen(false);
    setInconsistency(null);
    setDwelling(false);
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
  useEffect(() => {
    if (unit?.item.responseType === "info") return;
    const item = unit?.item;
    const statements = item?.responseType === "checkbox_set" ? item.statements.map((st) => st.text.text) : [];
    const waitMs = dwellHintMs(wordCount(item?.stem.text, item?.lede?.text, ...statements), effort);
    const t = setTimeout(() => {
      setDwelling(true);
      props.onEvent("hint.shown", { reason: "dwell", afterMs: waitMs });
    }, waitMs);
    return () => clearTimeout(t);
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
                Keep going
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
          sessionId={handover.sessionId}
          releaseHash={handover.releaseHash}
          firstName={handover.firstName}
          onEvent={props.onEvent}
          onDone={() => props.onAdvance(index, "next")}
        />
      </div>
    );
  }

  const item = unit.item;
  const baseScale = "scale" in item ? scales.get(item.scale) : undefined;
  // Options this participant could not truthfully choose are not offered —
  // an age older than they are is not an answer we want to be able to record.
  const scale =
    baseScale && item.responseType === "single_choice" && item.limitOptions
      ? { ...baseScale, options: visibleOptions(item.limitOptions, baseScale.options, store, new Date()) }
      : baseScale;
  const record = store.get({ instrument: unit.instrument, item: item.key, revision: item.revision });
  const answered = record?.status === "answered";
  const progress = walker.sectionProgress(index);
  const stemText = resolveText(item.stem.text, item.stem.pipes, store, sessionStart);

  const resolvedItem: ItemDefinition =
    item.responseType === "checkbox_set"
      ? {
          ...item,
          statements: item.statements.map((s) => ({
            ...s,
            text: { ...s.text, text: resolveText(s.text.text, s.text.pipes, store, sessionStart) },
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
  const canAdvance =
    item.responseType === "info" ||
    (!draftBlocked && (item.required === "hard" ? satisfied : true));

  const handleAnswer = (value: AnswerValue, autoAdvance: boolean | { afterMs: number }) => {
    // An answer that contradicts an earlier one is still recorded — it is what
    // the participant said, and the raw log is never edited. But the screen
    // says so and holds here, because right now they can tell us which of the
    // two is right; after the session, nobody can.
    const conflict = checkConsistency(item, value, scale, store);
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
    // Ask once, in place, before letting it go.
    if (effort.confirmSkip && !confirmingSkip) {
      setConfirmingSkip(true);
      return;
    }
    props.onEvent("skip.confirmed");
    props.onAdvance(index, "skip");
  };

  const controlProps = {
    item: resolvedItem,
    scale,
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

  return (
    <div className="screen survey">
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
        <div className="segments" aria-label={`Section ${progress.activeIndex + 1} of ${progress.sections.length}`}>
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
            {resolveText(item.lede.text, item.lede.pipes, store, sessionStart)}
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
                {resolveText(item.moreInfo.body.text, item.moreInfo.body.pipes, store, sessionStart)}
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

        {inconsistency && (
          <p className="error inconsistency" role="alert">
            {inconsistency}
          </p>
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
            <p className="skip-question">Leave this one blank?</p>
            {/* "Skip" sits first and quiet, where the Next button was, so the
                tap that opened this strip does not land straight on it.
                "I'll answer it" takes the prominent right-hand position the
                thumb returns to. Skipping stays one tap away — it is just no
                longer the accidental one. */}
            <div className="skip-actions">
              <button type="button" className="skip-go" onClick={handleNext}>
                Skip
              </button>
              <button
                type="button"
                className="skip-back"
                onClick={() => {
                  setConfirmingSkip(false);
                  props.onEvent("skip.abandoned");
                }}
              >
                I'll answer it
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
