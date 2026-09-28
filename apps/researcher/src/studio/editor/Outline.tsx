import { useEditor } from "./context.js";

/**
 * PLACEHOLDER — replaced by the editor build. It renders enough to show the
 * frame is wired: the component's name and the size of the draft.
 */
export function Outline() {
  const { draft } = useEditor();
  return (
    <div className="ste-placeholder">
      Outline — {draft.composition.sections.length} sections
    </div>
  );
}
