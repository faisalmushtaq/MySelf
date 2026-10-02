import { useId, useState } from "react";
import { addQuestion, liveQuestions, type QuestionTypeId, type StudioDraft } from "@myself/studio";
import { useEditor } from "../context.js";
import { focusSoon } from "./focus.js";
import { TypePickerDialog } from "./TypePicker.js";
import { typeLabel } from "./types.js";

/**
 * Adding a question from the centre editor (the overview, or a section): pick
 * a section and a type, and the new question opens with its wording selected,
 * ready to be typed over.
 */
export function AddQuestionDialog({ sectionKey, onClose }: { sectionKey?: string; onClose: () => void }) {
  const ctx = useEditor();
  const sections = ctx.draft.composition.sections;
  const [target, setTarget] = useState(sectionKey ?? sections[sections.length - 1]?.key ?? "");
  const selectId = useId();

  const add = (typeId: QuestionTypeId) => {
    const out: { itemKey?: string; draft?: StudioDraft } = {};
    const ok = ctx.run(`Add a ${typeLabel(typeId).toLowerCase()} question`, (d) => {
      const result = addQuestion(d, { sectionKey: target, typeId, ...(ctx.reserved ? { reserved: ctx.reserved } : {}) });
      out.itemKey = result.itemKey;
      out.draft = result.draft;
      return result.draft;
    });
    onClose();
    if (ok && out.itemKey && out.draft) {
      ctx.select({ kind: "question", itemKey: out.itemKey });
      // REVIEW FIX: said "at the end of the section", which isn't always where
      // the model puts it (it joins the questions already added there); say
      // where it actually is.
      const live = liveQuestions(out.draft);
      const at = live.find((q) => q.itemKey === out.itemKey);
      const section = out.draft.composition.sections.find((s) => s.key === target)?.title ?? target;
      ctx.announce(
        `Added a ${typeLabel(typeId).toLowerCase()} question${at ? `: question ${at.position + 1} of ${live.length}` : ""}, in “${section}”.`,
      );
      focusSoon('[data-field="stem"]', { select: true });
    }
  };

  return (
    <TypePickerDialog
      title="Add a question"
      intro={
        sectionKey ? (
          <p className="stn-flush">
            Added at the end of “{sections.find((s) => s.key === sectionKey)?.title ?? sectionKey}”, after any questions already added there. You
            can move it afterwards.
          </p>
        ) : (
          <div className="stn-field stn-field-inline stn-flush">
            <label className="stn-label" htmlFor={selectId}>
              Add to section
            </label>
            <select
              id={selectId}
              className="st-select"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-describedby={`${selectId}-hint`}
            >
              {sections.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </select>
            <div id={`${selectId}-hint`} className="stn-hint">
              Added at the end of the section, after any questions already added there. You can move it afterwards.
            </div>
          </div>
        )
      }
      onPick={add}
      onClose={onClose}
      // The section menu comes first when there is one, as it is read first.
      {...(sectionKey ? {} : { initialFocus: `#${CSS.escape(selectId)}` })}
    />
  );
}
