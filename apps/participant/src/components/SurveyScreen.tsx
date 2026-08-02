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
        <h1 ref={headingRef} tabIndex={-1} className={item.responseType === "info" ? "info-text" : "stem"}>
          {stemText}
        </h1>
        <SingleChoice {...controlProps} />
        <MultiChoice {...controlProps} />
        <SliderControl {...controlProps} />
        <LadderControl {...controlProps} />
        <NumericControl {...controlProps} />
        <DateControl {...controlProps} />
        <TextControl {...controlProps} />
        <FormFieldsControl {...controlProps} />
        <RankGroupControl {...controlProps} />
        <CheckboxSetControl {...controlProps} />

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
        </button>
      </footer>
    </div>
  );
}
