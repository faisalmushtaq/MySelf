import type { StudioDraft } from "@myself/studio";
import { EmptyState } from "../ui/kit.js";

/**
 * PLACEHOLDER — the isolated preview is being built on its own branch and
 * replaces this file. It pins the props the platform passes: the working
 * draft (unsaved edits included) and the question to start at, if any.
 */

export interface PreviewPageProps {
  surveyId: string;
  draft: StudioDraft | null;
  startAt?: string | null;
}

export function PreviewPage({ draft, startAt }: PreviewPageProps) {
  return (
    <div className="stp-page">
      <h1 className="stp-h1">Preview</h1>
      <EmptyState icon="eye" title="The preview is coming soon">
        <p>
          {draft
            ? `It will show “${draft.composition.title}” exactly as a participant sees it${startAt ? `, starting at ${startAt}` : ""}, with nothing saved.`
            : "There’s no draft to preview yet."}
        </p>
      </EmptyState>
    </div>
  );
}
