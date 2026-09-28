import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import { NOT_YET_SUPPORTED, QUESTION_TYPES, type QuestionType, type QuestionTypeId } from "@myself/studio";
import { Dialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { TYPE_ICONS } from "./Row.js";

/**
 * Choosing what kind of question to add.
 *
 * Only the types the participant app renders, validates, stores and reports
 * can be chosen (catalogue.ts). The rest are listed too, greyed out with the
 * reason, so nobody spends ten minutes looking for a Likert grid that the app
 * could not show.
 */

const GROUPS: { id: QuestionType["group"]; title: string }[] = [
  { id: "choice", title: "Choices" },
  { id: "text", title: "Text" },
  { id: "number", title: "Numbers" },
  { id: "other", title: "Other" },
];

export function TypePicker({ where, onChoose, onClose }: { where: string; onChoose: (typeId: QuestionTypeId) => void; onClose: () => void }) {
  const creatable = QUESTION_TYPES.filter((t) => t.canCreate);
  const existingOnly = QUESTION_TYPES.filter((t) => !t.canCreate);

  // Arrow keys move between the choices as well as Tab, the way a grid of options reads.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const options = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".sto-type-option:not(:disabled)"));
    const i = options.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? Math.min(options.length - 1, i + 1) : Math.max(0, i - 1);
    options[next]?.focus();
  };

  return (
    <Dialog title="Add a question" description={<p className="stp-flush">It goes {where}. Choose what kind of answer it takes.</p>} onClose={onClose} width={680} initialFocus=".sto-type-option">
      <div className="sto-types" onKeyDown={onKeyDown}>
        {GROUPS.map((g) => {
          const types = creatable.filter((t) => t.group === g.id);
          if (types.length === 0) return null;
          return (
            <section key={g.id} className="sto-type-group" aria-labelledby={`sto-tg-${g.id}`}>
              <h3 id={`sto-tg-${g.id}`}>{g.title}</h3>
              <ul className="sto-type-grid">
                {types.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="sto-type-option" onClick={() => onChoose(t.id)}>
                      <span className="sto-type-icon" aria-hidden="true">
                        <Icon name={TYPE_ICONS[t.id]} size={18} />
                      </span>
                      <span className="sto-type-text">
                        <strong>{t.label}</strong>
                        <small>{t.description}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <section className="sto-type-group sto-type-unavailable" aria-labelledby="sto-tg-none">
          <h3 id="sto-tg-none">Not available for new questions</h3>
          <ul className="sto-type-grid">
            {existingOnly.map((t) => (
              <li key={t.id}>
                <div className="sto-type-option is-disabled" aria-disabled="true">
                  <span className="sto-type-icon" aria-hidden="true">
                    <Icon name={TYPE_ICONS[t.id]} size={18} />
                  </span>
                  <span className="sto-type-text">
                    <strong>{t.label}</strong>
                    <small>Questions of this kind that are already in a survey can still be edited, but new ones can&rsquo;t be made in the Studio.</small>
                  </span>
                </div>
              </li>
            ))}
            {NOT_YET_SUPPORTED.map((t) => (
              <li key={t.id}>
                <div className="sto-type-option is-disabled" aria-disabled="true">
                  <span className="sto-type-icon" aria-hidden="true">
                    <Icon name="close" size={18} />
                  </span>
                  <span className="sto-type-text">
                    <strong>{t.label}</strong>
                    <small>{t.reason}</small>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
