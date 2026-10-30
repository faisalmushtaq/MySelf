import { useState } from "react";

/**
 * The researcher's wrap-up (D-70): opened mid-sitting with five taps on the
 * progress bar and the staff PIN, for when the session is over and the
 * participant has not finished. Everything answered is kept; the questions
 * not reached are recorded as such, and the sitting is marked as ended by a
 * researcher, with the reason, so the dashboard can tell it apart from someone
 * who walked away.
 */

export const WRAP_UP_REASONS = [
  { key: "time", label: "Time's up" },
  { key: "participant_stopped", label: "The participant asked to stop" },
  { key: "distress", label: "The participant was upset or unwell" },
  { key: "technical", label: "Technical problem" },
  { key: "other", label: "Something else" },
] as const;

export type WrapUpReason = (typeof WRAP_UP_REASONS)[number]["key"];

export interface WrapUpPanelProps {
  answered: number;
  total: number;
  busy: boolean;
  onEnd: (reason: WrapUpReason) => void;
  onCancel: () => void;
}

export function WrapUpPanel({ answered, total, busy, onEnd, onCancel }: WrapUpPanelProps) {
  const [reason, setReason] = useState<WrapUpReason>("time");
  return (
    <div className="wrapup-overlay" role="dialog" aria-modal="true" aria-labelledby="wrapup-title">
      <div className="wrapup-card">
        <h2 id="wrapup-title">End this sitting?</h2>
        <p>
          {answered} of about {total} questions answered. Everything answered is kept, and the rest are recorded as not reached. The participant then sees a
          thank-you screen.
        </p>
        <fieldset className="wrapup-reasons">
          <legend>Why is it ending?</legend>
          {WRAP_UP_REASONS.map((r) => (
            <label key={r.key}>
              <input type="radio" name="wrapup-reason" checked={reason === r.key} onChange={() => setReason(r.key)} />
              {r.label}
            </label>
          ))}
        </fieldset>
        {reason === "participant_stopped" || reason === "distress" ? (
          <p className="hint">
            Their answers are kept. If they want them removed, that is a withdrawal: email the research team with their name and date of birth.
          </p>
        ) : null}
        <div className="wrapup-actions">
          <button type="button" className="wrapup-back" onClick={onCancel} disabled={busy}>
            Back to the survey
          </button>
          <button type="button" className="wrapup-end" onClick={() => onEnd(reason)} disabled={busy}>
            {busy ? "Ending…" : "End the sitting"}
          </button>
        </div>
      </div>
    </div>
  );
}
