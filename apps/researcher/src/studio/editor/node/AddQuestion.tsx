import { useId, useState } from "react";
import { addQuestion, type QuestionTypeId } from "@myself/studio";
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
    const out: { itemKey?: string } = {};
    const ok = ctx.run(`Add a ${typeLabel(typeId).toLowerCase()} question`, (d) => {
      const result = addQuestion(d, { sectionKey: target, typeId, ...(ctx.reserved ? { reserved: ctx.reserved } : {}) });
      out.itemKey = result.itemKey;
      return result.draft;
    });
    onClose();
    if (ok && out.itemKey) {
      ctx.select({ kind: "question", itemKey: out.itemKey });
      ctx.announce(`Added a ${typeLabel(typeId).toLowerCase()} question at the end of the section.`);
      focusSoon('[data-field="stem"]', { select: true });
    }
  };

  return (
    <TypePickerDialog
      title="Add a question"
      intro={
        sectionKey ? (
          <p className="stn-flush">It goes at the end of “{sections.find((s) => s.key === sectionKey)?.title ?? sectionKey}”. You can move it afterwards.</p>
        ) : (
          <div className="stn-field stn-flush">
            <label className="stn-label" htmlFor={selectId}>
              Section
            </label>
            <select id={selectId} className="st-select" value={target} onChange={(e) => setTarget(e.target.value)}>
              {sections.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </select>
            <div className="stn-hint">It goes at the end of the section. You can move it afterwards.</div>
          </div>
        )
      }
      onPick={add}
      onClose={onClose}
    />
  );
}
