/**
 * The end of a sitting: thanks, an offer to change an answer, and the button
 * that hands the iPad back.
 */
export interface FinishScreenProps {
  /** Already piped, so it can use the name given at the start. */
  title: string;
  body: string;
  /** Open the review list. Absent when the release has no review screen. */
  onReview?: (() => void) | undefined;
  /** Clear the sitting from the screen and return to the start. */
  onHandBack: () => void;
}

export function FinishScreen({ title, body, onReview, onHandBack }: FinishScreenProps) {
  return (
    <div className="screen finish">
      <h1>
        {title}{" "}
        🎉
      </h1>
      <p>{body}</p>
      <p className="hint">Your answers are saved safely on this device.</p>

      {/* Offered, not imposed. Most people are done when they are done;
          the list is there for the minority who know they got something
          wrong, and it sits below the finish message rather than in front
          of it (D-31). */}
      {onReview && (
        <div className="finish-amend">
          <p className="finish-amend-q">Need to change anything?</p>
          <button type="button" className="finish-amend-go" onClick={() => onReview()}>
            Go back to my answers
          </button>
        </div>
      )}

      <button type="button" className="next big" onClick={() => onHandBack()}>
        Hand back to the researcher
      </button>
    </div>
  );
}
