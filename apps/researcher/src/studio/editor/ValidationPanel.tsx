import { useEditor } from "./context.js";

/** PLACEHOLDER — replaced by the editor build. Renders nothing until opened. */
export function ValidationPanel() {
  const { validationOpen } = useEditor();
  return validationOpen ? <div className="ste-placeholder">Validation panel</div> : null;
}
