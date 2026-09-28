import type { ReactNode } from "react";
import { NOT_YET_SUPPORTED, QUESTION_TYPES, type QuestionType, type QuestionTypeId } from "@myself/studio";
import { Dialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Badge, Button } from "../../ui/kit.js";
import { Disclosure } from "./controls.js";
import { TYPE_ICONS } from "./types.js";

/**
 * Choosing a question type — for a new question, or to change (or replace)
 * an existing one.
 *
 * Only the types the participant app renders, validates, stores and reports
 * are offered (docs/16 §4.3). The ones asked for but not yet supported are
 * listed underneath, disabled, each with why, so nobody wonders whether a
 * matrix question is hidden somewhere.
 */

const GROUPS: { id: QuestionType["group"]; title: string }[] = [
  { id: "choice", title: "Choosing" },
  { id: "text", title: "Typing" },
  { id: "number", title: "Numbers" },
  { id: "other", title: "Other" },
];

export function TypePickerDialog({
  title,
  intro,
  current,
  actionLabel,
  onPick,
  onClose,
  footerNote,
  initialFocus,
}: {
  title: string;
  intro?: ReactNode;
  /** The question's type now; shown as current and not offered. */
  current?: QuestionTypeId;
  /** The words on each type's button, e.g. "Replace with". Omitted: the type's name alone. */
  actionLabel?: ((label: string) => string) | undefined;
  onPick: (id: QuestionTypeId) => void;
  onClose: () => void;
  footerNote?: ReactNode;
  /** What takes focus when the dialog opens; the first type that can be chosen, unless given. */
  initialFocus?: string;
}) {
  const creatable = QUESTION_TYPES.filter((t) => t.canCreate);
  const editOnly = QUESTION_TYPES.filter((t) => !t.canCreate);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={720}
      description={intro}
      // REVIEW FIX: named explicitly. Left to the shared dialog, focus lands on
      // its Close button (its body selector only scopes the first alternative).
      initialFocus={initialFocus ?? ".stn-type:not([disabled])"}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="stn-types">
        {GROUPS.map((group) => {
          const types = creatable.filter((t) => t.group === group.id);
          if (types.length === 0) return null;
          return (
            <section key={group.id} className="stn-types-group" aria-label={group.title}>
              <h3 className="stn-eyebrow">{group.title}</h3>
              <ul className="stn-types-list">
                {types.map((t) => {
                  const isCurrent = t.id === current;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        className={`stn-type${isCurrent ? " current" : ""}`}
                        onClick={() => onPick(t.id)}
                        disabled={isCurrent}
                        aria-describedby={`stn-type-desc-${t.id}`}
                      >
                        <span className="stn-type-icon">
                          <Icon name={TYPE_ICONS[t.id]} size={20} />
                        </span>
                        <span className="stn-type-text">
                          <span className="stn-type-label">
                            {actionLabel && !isCurrent ? actionLabel(t.label) : t.label}
                            {isCurrent ? (
                              <Badge tone="accent" icon="check">
                                Current
                              </Badge>
                            ) : null}
                          </span>
                          <span id={`stn-type-desc-${t.id}`} className="stn-type-desc">
                            {t.description}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      <Disclosure summary="Not available yet">
        <ul className="stn-unavailable">
          {NOT_YET_SUPPORTED.map((n) => (
            <li key={n.id}>
              <strong>{n.label}</strong>
              <span>{n.reason}</span>
            </li>
          ))}
          <li>
            <strong>{editOnly.map((t) => t.label).join(", ")}</strong>
            <span>Can be edited where the survey already has them, but new ones can't be created in the Studio yet.</span>
          </li>
        </ul>
      </Disclosure>
      {footerNote ? <div className="stn-hint">{footerNote}</div> : null}
    </Dialog>
  );
}
