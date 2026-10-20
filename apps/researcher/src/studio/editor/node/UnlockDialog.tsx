import { useId, useState } from "react";
import { instrumentName, MIN_UNLOCK_REASON, protectedModule, relockModule, unlockModule, type StudioDraft } from "@myself/studio";
import { formatDateTime } from "../../format.js";
import { Dialog } from "../../ui/dialog.js";
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";

/**
 * Unlocking a protected module (docs/16 §4.4, R4, R5).
 *
 * The consent wording is ethics-approved and the identity questions are what
 * participant linkage rests on, so opening either for editing asks for two
 * things: a sentence saying why the change is allowed — kept verbatim with the
 * draft and in the audit log — and an explicit acknowledgement. Neither can be
 * clicked through: the button stays disabled, and says why, until both are there.
 */
export function UnlockDialog({ instrument, onClose }: { instrument: string; onClose: () => void }) {
  const ctx = useEditor();
  const protection = protectedModule(instrument);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const reasonId = useId();
  const ackId = useId();
  const countId = useId();
  const name = instrumentName(ctx.draft, instrument);
  // A licensed questionnaire (no protection record) is locked only so it isn't
  // changed by accident: unlocking it asks why, like a protected module.
  const licensed = !protection;
  const ethics = protection?.reason === "ethics";
  const remaining = MIN_UNLOCK_REASON - reason.trim().length;
  const ready = remaining <= 0 && acknowledged;

  const unlock = () => {
    const ok = ctx.run(`Unlock ${name}`, (d) => unlockModule(d, instrument, { ...ctx.actor(), reason: reason.trim() }).draft);
    if (ok) {
      ctx.announce(`${name} is unlocked for editing.`);
      onClose();
    }
  };

  return (
    <Dialog
      title={`Unlock “${name}”`}
      onClose={onClose}
      width={560}
      // REVIEW FIX: start in the reason box. Left to the shared dialog, focus
      // landed on its Close button, so someone who opened this from the
      // keyboard and began typing their reason closed it with the first space.
      initialFocus={`#${CSS.escape(reasonId)}`}
      description={
        <p className="stn-flush">
          {licensed
            ? "This is a published questionnaire. It is locked so its wording isn't changed by accident. Unlocked, its wording, answer options and order can be edited in this survey. To use the edited version in other surveys, save it to the library as its own copy."
            : protection.explanation}
        </p>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it locked
          </Button>
          <Button variant="primary" icon="unlock" onClick={unlock} disabled={!ready || !ctx.canEdit}>
            Unlock for editing
          </Button>
        </>
      }
    >
      <div className="stn-field">
        <label className="stn-label" htmlFor={reasonId}>
          {licensed ? "Why does its wording need to change?" : ethics ? "Why is this change covered by the ethics approval?" : "Why is this change safe for participant linkage?"}
        </label>
        <textarea
          id={reasonId}
          className="st-input stn-unlock-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={countId}
          placeholder={
            licensed
              ? "For example: Rewording the ladder explanations so they read better for this age group."
              : ethics
              ? "For example: Correcting a typo in statement 2, approved as a minor amendment under PSCETHS-1449 on 12 Sep."
              : "For example: Rewording the hint only; the answers and their format stay exactly the same."
          }
        />
        <div id={countId} className="stn-hint" aria-live="polite">
          {remaining > 0
            ? `At least ${MIN_UNLOCK_REASON} characters — ${remaining} more to go. This is kept with the survey's history and shown to whoever publishes.`
            : "Kept with the survey's history and shown to whoever publishes."}
        </div>
      </div>
      <div className="stn-check">
        <input id={ackId} type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <label htmlFor={ackId}>
          {licensed
            ? "I understand that edited wording makes this the study's own version of the questionnaire, and that this is recorded with the survey."
            : ethics
            ? "I confirm this change is covered by the study's ethics approval, and that participants will consent to the wording as changed."
            : "I confirm this change keeps participant linkage working: the same person will give the same answers, so their sittings still link together."}
        </label>
      </div>
      {!ctx.canEdit ? <p className="stn-hint">{ctx.readOnlyReason}</p> : null}
    </Dialog>
  );
}

/** Who unlocked a module, when and why — shown while it stays unlocked. */
export function unlockedText(draft: StudioDraft, instrument: string): string | null {
  const unlock = Object.prototype.hasOwnProperty.call(draft.unlocked, instrument) ? draft.unlocked[instrument] : undefined;
  if (!unlock) return null;
  const when = new Date(unlock.at);
  return `Unlocked by ${unlock.by} on ${formatDateTime(Number.isNaN(when.getTime()) ? null : when)}: “${unlock.reason}”. Changes made while it is open stay when it is locked again.`;
}

/** Lock a protected module or questionnaire again. Changes made while it was open stay. */
export function relock(ctx: ReturnType<typeof useEditor>, instrument: string): void {
  const name = instrumentName(ctx.draft, instrument);
  if (ctx.run(`Lock ${name} again`, (d) => relockModule(d, instrument).draft)) ctx.announce(`${name} is locked again.`);
}
