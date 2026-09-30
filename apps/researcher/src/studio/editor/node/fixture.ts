import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractDraft, type StudioDraft } from "@myself/studio";

/**
 * The live survey (r7.3.0) as a draft, for the editor's tests: 9 sections, 147
 * questions, licensed questionnaires, the protected consent and identity
 * modules and shared option lists — every case the editor has to get right.
 * Test-only; never imported by the editor itself.
 */
const RAW = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json"), "utf8"),
) as unknown;

export function liveDraft(): StudioDraft {
  return extractDraft(RAW);
}
