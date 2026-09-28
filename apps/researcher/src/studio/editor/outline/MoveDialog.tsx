import { useState } from "react";
import type { OutlineSection } from "@myself/studio";
import { Dialog } from "../../ui/dialog.js";
import { Button } from "../../ui/kit.js";

/**
 * "Move to section…" (and "Restore into section…"): the keyboard- and
 * screen-reader-friendly way to send something to another section without
 * dragging it past a hundred rows. It goes to the end of the section chosen.
 */
export function MoveDialog({
  title,
  intro,
  sections,
  current,
  initial,
  origin,
  confirmLabel,
  onMove,
  onClose,
}: {
  title: string;
  intro: string;
  sections: OutlineSection[];
  /** Where it is now, if anywhere: marked, and not the default. */
  current: string | null;
  /** The section chosen to begin with, when there is a natural one (a restore: where it was). */
  initial?: string | null;
  /** Where an archived question was archived from: marked, and still choosable. */
  origin?: string | null;
  confirmLabel: string;
  onMove: (sectionKey: string) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string>(
    () =>
      (initial && initial !== current && sections.some((s) => s.key === initial) ? initial : null) ??
      sections.find((s) => s.key !== current)?.key ??
      sections[0]?.key ??
      "",
  );
  const count = (s: OutlineSection) => s.blocks.reduce((n, b) => n + b.questions.length, 0);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={520}
      initialFocus="input[type=radio]:checked"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onMove(chosen)} disabled={!chosen || chosen === current}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="stp-flush">{intro}</p>
      <fieldset className="stp-fieldset sto-move-list">
        <legend className="st-field-label">Section</legend>
        {sections.map((s) => (
          <label key={s.key} className="stp-radio">
            <input type="radio" name="sto-move-section" value={s.key} checked={chosen === s.key} onChange={() => setChosen(s.key)} />
            <span>
              <strong>{s.title}</strong>
              <small>
                {count(s) === 1 ? "1 question" : `${count(s)} questions`}
                {s.key === current ? " · where it is now" : ""}
                {s.key === origin ? " · where it was" : ""}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}
