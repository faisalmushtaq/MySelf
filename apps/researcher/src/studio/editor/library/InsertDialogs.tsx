import { useId, useState } from "react";
import { MIN_UNLOCK_REASON, protectedModule } from "@myself/studio";
import { Dialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button, InfoTip, Notice } from "../../ui/kit.js";
import type { InsertOutcome } from "./model.js";

/**
 * The two moments around adding a piece that need words: the reason for
 * copying a protected module, asked before anything is added, and what came of
 * the copy when anything was renamed or dropped.
 */

/**
 * Copying the consent or identity module asks why, as unlocking one does
 * (docs/16 §4.4, §12.2): its wording is approved for one study, so using it in
 * another is an ethics decision somebody must own. The reason is kept with the
 * draft, audited, and shown to whoever publishes.
 */
export function ProtectedReasonDialog({
  modules,
  onCancel,
  onConfirm,
}: {
  modules: { instrument: string; name: string }[];
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const reasonId = useId();
  const countId = useId();
  const ackId = useId();
  const remaining = MIN_UNLOCK_REASON - reason.trim().length;
  const ready = remaining <= 0 && acknowledged;
  const ethics = modules.some((m) => protectedModule(m.instrument)?.reason === "ethics");
  const names = modules.map((m) => `“${m.name}”`).join(" and ");

  return (
    <Dialog
      title={`Copy ${names}?`}
      onClose={onCancel}
      width={560}
      initialFocus={`#${CSS.escape(reasonId)}`}
      description={
        <p className="stn-flush">
          {modules.length === 1 ? "It is protected" : "They are protected"}: {ethics ? "consent wording is approved for one study by its ethics committee" : "participant linkage rests on these questions"}.
          {" "}It is added unlocked, with your reason kept with the survey&rsquo;s history and shown to whoever publishes.
        </p>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onConfirm(reason.trim())} disabled={!ready}>
            Add with this reason
          </Button>
        </>
      }
    >
      <ul className="stl-protected">
        {modules.map((m) => (
          <li key={m.instrument}>
            <Icon name="lock" size={14} />
            <span>{m.name}</span>
            <InfoTip text={protectedModule(m.instrument)?.explanation ?? "Protected."} label={`why “${m.name}” is protected`} />
          </li>
        ))}
      </ul>
      <div className="stn-field">
        <label className="stn-label" htmlFor={reasonId}>
          {ethics ? "Why may this wording be used in this survey?" : "Why is copying these questions safe for participant linkage?"}
        </label>
        <textarea
          id={reasonId}
          className="st-input stn-unlock-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={countId}
          placeholder={
            ethics
              ? "For example: The same consent wording is approved for this study under PSCETHS-1449 (amendment of 2 Oct)."
              : "For example: This survey links sittings with the same participant code, built from the same four answers."
          }
        />
        <div id={countId} className="stn-hint" aria-live="polite">
          {remaining > 0 ? `At least ${MIN_UNLOCK_REASON} characters — ${remaining} more to go.` : "Kept with the survey’s history."}
        </div>
      </div>
      <div className="stn-check">
        <input id={ackId} type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <label htmlFor={ackId}>
          {ethics
            ? "I confirm this study’s ethics approval covers this wording, or that it will be changed and approved before this survey is published."
            : "I confirm these questions will link this survey’s sittings correctly."}
        </label>
      </div>
    </Dialog>
  );
}

/**
 * What came of a copy that renamed or dropped something. A rename is shown
 * first and plainly: a renamed question will not line up with the original's
 * data, which is the whole point of keeping IDs.
 */
export function InsertResultDialog({
  outcome,
  summary,
  onClose,
}: {
  outcome: InsertOutcome;
  /** `describeInsert` for each piece. */
  summary: string[];
  onClose: () => void;
}) {
  const n = outcome.added.length;
  return (
    <Dialog
      title={n === 1 ? "Added 1 question" : `Added ${n} questions`}
      onClose={onClose}
      width={600}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {outcome.renamed.length > 0 || outcome.variablesRenamed.length > 0 ? (
        <Notice tone="warn" title="Renamed, so these will not line up with the original’s data">
          <p className="stn-flush">Their IDs or variables were already taken in this survey by different questions.</p>
          <ul className="stl-renames">
            {outcome.renamed.map((r) => (
              <li key={`q:${r.from}`}>
                <code>{r.from}</code> <span aria-hidden="true">→</span>
                <span className="st-sr"> is now </span> <code>{r.to}</code>
              </li>
            ))}
            {outcome.variablesRenamed.map((r) => (
              <li key={`v:${r.itemKey}:${r.from}`}>
                Variable <code>{r.from}</code> <span aria-hidden="true">→</span>
                <span className="st-sr"> is now </span> <code>{r.to}</code> <span className="stl-meta">({r.itemKey})</span>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {outcome.conditionsRemoved.length > 0 ? (
        <section className="stl-result-part" aria-label="Conditions removed">
          <h3 className="stl-h3">Conditions removed</h3>
          <ul className="stl-bullets">
            {outcome.conditionsRemoved.map((c, i) => (
              <li key={i}>
                {c.itemKey ? <code>{c.itemKey}</code> : c.block ? <>Block “{c.block}”</> : "A block"}: {c.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {outcome.alreadyThere.length > 0 ? (
        <section className="stl-result-part" aria-label="Already in this survey">
          <h3 className="stl-h3">Already in this survey, so not added again</h3>
          <p className="stn-flush stl-meta">{outcome.alreadyThere.join(", ")}</p>
        </section>
      ) : null}
      <section className="stl-result-part" aria-label="Summary">
        {summary.map((line, i) => (
          <p key={i} className="stn-flush stl-summary">
            {line}
          </p>
        ))}
      </section>
    </Dialog>
  );
}
