/**
 * The preview's one seam onto @myself/studio's editing model.
 *
 * TEMPORARY. `describeCondition` is being written in @myself/studio
 * (logic.ts) alongside the editor's logic builder. Until that is merged, the
 * preview uses its own describer (./describe.ts). Switching is a change to
 * this file only: import the model's version, adapt its arguments to
 * `DescribeContext` here if they differ, and delete ./describe.ts.
 *
 * Everything else the preview needs from @myself/studio — `previewRelease` —
 * already exists and is imported directly.
 */
export { describeCondition, type DescribeContext } from "./describe.js";
