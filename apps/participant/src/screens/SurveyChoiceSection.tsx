import { useState } from "react";
import type { SurveyChoice } from "@myself/schema";

/**
 * Which survey this iPad runs, and changing it — in the handover panel only
 * (D-56, docs/16 §11.3).
 *
 * The panel is five taps on the build line away, so a participant never sees
 * this; and a change takes two deliberate steps — Check, then Use this survey —
 * with the second saying what happens to sittings already on the iPad. Nothing
 * here decides anything: App checks the survey online (the same check a link
 * gets) and moves the iPad only once it has proved itself.
 *
 * It is also the one way to move an iPad that runs MySelf from the Home Screen,
 * whose storage is its own: a link opened in Safari sets Safari's copy, not
 * the app's, so staff paste the link here instead.
 */

/** What a Check found, as App reports it. */
export type PanelCheck =
  | { kind: "invalid"; problem: string }
  /** It is the survey this iPad is already on. */
  | { kind: "same" }
  | { kind: "refused"; reason: string }
  | { kind: "unreachable"; reason: string }
  | {
      kind: "ready";
      choice: SurveyChoice;
      /** Its title, from the release it will run. */
      title: string | null;
      version: string | null;
      /** Unfinished sittings of other surveys that stay on the iPad. */
      leftBehind: number;
    };

export interface SurveyChoiceSectionProps {
  survey: { choice: SurveyChoice; isDefault: boolean; defaultChoice: SurveyChoice };
  online: boolean;
  onCheck: (text: string) => Promise<PanelCheck>;
  onUse: (choice: SurveyChoice) => Promise<void>;
}

const ids = (choice: SurveyChoice) => `“${choice.surveyId}” of the study “${choice.study}”`;

export function SurveyChoiceSection({ survey, online, onCheck, onUse }: SurveyChoiceSectionProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<PanelCheck | null>(null);

  const check = (text: string) => {
    setBusy(true);
    setFound(null);
    void onCheck(text)
      .then(setFound)
      .catch(() => setFound({ kind: "unreachable", reason: "the check could not be made" }))
      .finally(() => setBusy(false));
  };

  const use = (choice: SurveyChoice) => {
    setBusy(true);
    void onUse(choice)
      .then(() => {
        setFound(null);
        setTyped("");
      })
      .catch(() => setFound({ kind: "unreachable", reason: "this iPad could not save the change" }))
      .finally(() => setBusy(false));
  };

  return (
    <section className="survey-choice" aria-label="Survey on this iPad">
      <h3>Survey on this iPad</h3>
      <p className="hint">
        New sittings on this iPad use the survey {ids(survey.choice)}
        {survey.isDefault ? ", the one this app was built for." : "."} A sitting already started finishes on the
        survey it started on.
      </p>
      <label className="field">
        <span className="field-label">Participant link, or study/survey</span>
        <input
          className="text-input"
          value={typed}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => {
            setTyped(event.target.value);
            setFound(null);
          }}
        />
      </label>
      <div className="handover-actions">
        <button type="button" className="secondary" disabled={busy || !online || typed.trim() === ""} onClick={() => check(typed)}>
          {busy && found === null ? "Checking…" : "Check"}
        </button>
        {!survey.isDefault && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => check(`${survey.defaultChoice.study}/${survey.defaultChoice.surveyId}`)}
          >
            Back to the default survey
          </button>
        )}
      </div>
      {!online && <p className="hint">Checking another survey needs a connection. The default survey is always available.</p>}
      {found && <CheckResult found={found} busy={busy} onUse={use} onCancel={() => setFound(null)} />}
    </section>
  );
}

function CheckResult({
  found,
  busy,
  onUse,
  onCancel,
}: {
  found: PanelCheck;
  busy: boolean;
  onUse: (choice: SurveyChoice) => void;
  onCancel: () => void;
}) {
  switch (found.kind) {
    case "invalid":
      return <p className="hint warn">That can't be used: {found.problem}.</p>;
    case "same":
      return <p className="hint">This iPad is already on that survey.</p>;
    case "refused":
      return <p className="hint warn">That survey can't be used: {found.reason}. Nothing has changed.</p>;
    case "unreachable":
      return <p className="hint warn">That survey couldn't be checked: {found.reason}. Nothing has changed.</p>;
    case "ready":
      return (
        <div className="survey-choice-confirm" role="group" aria-label="Confirm the change">
          <p className="hint">
            Found {found.title ? <strong>{found.title}</strong> : "it"}
            {found.version ? `, version ${found.version}` : ""}: the survey {ids(found.choice)}. New sittings on this
            iPad will use it, here and offline, until it is changed again.
            {found.leftBehind > 0
              ? ` ${found.leftBehind} unfinished sitting${found.leftBehind === 1 ? "" : "s"} of another survey stay${found.leftBehind === 1 ? "s" : ""} on this iPad, still uploading, and can be finished after switching back.`
              : ""}
          </p>
          <div className="handover-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => onUse(found.choice)}>
              Use this survey on this iPad
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      );
  }
}
