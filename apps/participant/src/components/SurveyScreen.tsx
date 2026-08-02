import { useEffect, useMemo, useRef, useState } from "react";
import { AnswerStore, Walker, type AnswerValue, type PresentableUnit } from "@myself/engine";
import type { ItemDefinition, ResponseScale } from "@myself/schema";
import { resolveText } from "../lib/pipes.js";
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

export interface SurveyScreenProps {
  units: PresentableUnit[];
  scales: Map<string, ResponseScale>;
  store: AnswerStore;
  allowBack: boolean;
  sectionTitles: Map<string, string>;
  index: number;
  sessionStart: Date;
  onRecord: (unit: PresentableUnit, value: AnswerValue) => void;
  onAdvance: (from: number, kind: "next" | "skip" | "decline") => void;
  onBack: (from: number) => void;
}

export function SurveyScreen(props: SurveyScreenProps) {
  const { units, scales, store, allowBack, index, sessionStart } = props;
  const unit = units[index];
  const walker = useMemo(() => new Walker(units, store, allowBack), [units, store, allowBack]);
  const [softPrompted, setSoftPrompted] = useState(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    setSoftPrompted(false);
    headingRef.current?.focus();
    return () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    };
  }, [index]);

  /**
   * Keyboard parity with the on-screen affordances: a letter selects the
   * option showing that key; Enter continues. Ignored while typing in a
   * field, so text answers are never hijacked.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Enter" && !typing) {
        const next = document.querySelector<HTMLButtonElement>("button.next:not(:disabled)");
        if (next) {
          e.preventDefault();
          next.click();
        }
        return;
      }
      if (typing || e.key.length !== 1) return;
      const letter = e.key.toUpperCase();
      if (letter < "A" || letter > "Z") return;
      const option = document.querySelector<HTMLButtonElement>(`[data-option-key="${letter}"]`);
      if (option) {
        e.preventDefault();
        option.click();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [index]);

  if (!unit) return null;
  const item = unit.item;
  const scale = "scale" in item ? scales.get(item.scale) : undefined;
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

  const canAdvance =
    item.responseType === "info" ||
    (item.required === "hard" ? answered && consentComplete : true);

  const handleAnswer = (value: AnswerValue, autoAdvance: boolean) => {
    props.onRecord(unit, value);
    if (autoAdvance) {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => props.onAdvance(index, "next"), 300);
    }
  };

  const handleNext = () => {
    if (item.responseType === "info") return props.onAdvance(index, "next");
    if (answered && consentComplete) return props.onAdvance(index, "next");
    if (item.required === "hard") return; // button disabled anyway
    if (item.required === "soft" && !softPrompted && !answered) {
      setSoftPrompted(true);
      return;
    }
    props.onAdvance(index, "skip");
  };

  const controlProps = { item: resolvedItem, scale, value: record?.value, onAnswer: handleAnswer };
  /**
   * Identity of the question on screen. Used as a React key so every control
   * remounts between questions: without it React reuses the control instance
   * and its internal draft state (e.g. typed text) bleeds into the next item.
   */
  const unitKey = `${unit.instrument}.${item.key}#${item.revision}`;

  return (
    <div className="screen survey">
      <header className="survey-header">
        {allowBack && walker.back(index) !== null ? (
          <button type="button" className="back" aria-label="Go back" onClick={() => props.onBack(index)}>
            ‹
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
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={
            item.responseType === "info"
              ? "info-text"
              : `stem${stemText.length > 110 ? " stem-long" : ""}`
          }
        >
          {stemText}
        </h1>
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

        {softPrompted && !answered && (
          <p className="soft-prompt" role="status">
            If you'd rather not answer, you can continue — but your answer really helps if you can give one.
          </p>
        )}
      </main>

      <footer className="survey-footer">
        {item.allowDecline && !answered && (
          <button type="button" className="decline" onClick={() => props.onAdvance(index, "decline")}>
            Prefer not to say
          </button>
        )}
        <button type="button" className="next" disabled={!canAdvance && item.required === "hard"} onClick={handleNext}>
          {item.responseType === "info" ? "Continue" : answered ? "Next" : item.required === "hard" ? "Next" : softPrompted ? "Skip" : "Next"}
          <span className="key-hint" aria-hidden="true">
            ↵
          </span>
        </button>
      </footer>
    </div>
  );
}
