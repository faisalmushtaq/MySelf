/**
 * The countdown before an untouched iPad goes back to the start (lib/idle.ts).
 *
 * In front of whatever is on screen, and calm: nobody is in trouble, and the
 * answers are already saved. Any touch carries on as well as the button does.
 */
export interface IdleNoticeProps {
  /** `survey` mid-sitting, where the sitting can be carried on later; `hand-back` otherwise. */
  kind: "survey" | "hand-back";
  secondsLeft: number;
  onStillHere: () => void;
}

export function IdleNotice({ kind, secondsLeft, onStillHere }: IdleNoticeProps) {
  const seconds = `${secondsLeft} second${secondsLeft === 1 ? "" : "s"}`;
  return (
    <div className="idle-notice" role="alertdialog" aria-modal="true" aria-labelledby="idle-notice-title">
      <div className="idle-notice-card">
        <h2 id="idle-notice-title">{kind === "survey" ? "Are you still there?" : "Still there?"}</h2>
        <p>
          {kind === "survey"
            ? `To keep your answers private, this iPad will go back to the start in ${seconds}. Your answers are saved, and you can carry on later with your code.`
            : `To keep your answers private, this screen will close in ${seconds}.`}
        </p>
        <button type="button" className="next big idle-stay" onClick={() => onStillHere()}>
          I&apos;m still here
        </button>
      </div>
    </div>
  );
}
