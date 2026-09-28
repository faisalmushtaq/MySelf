import { useEditor } from "./context.js";

/** PLACEHOLDER — replaced by the editor build. Renders nothing until opened. */
export function PublishDialog() {
  const { publishOpen } = useEditor();
  return publishOpen ? <div className="ste-placeholder">Publish dialog</div> : null;
}
