/**
 * Shown when a write to the iPad's own storage did not land, in front of
 * whatever the participant was doing. See `persist` and `saveError` in App for
 * why a failed write stops the survey rather than letting it carry on.
 */
export interface SaveFailedScreenProps {
  /** What went wrong, as one sentence the participant can read. */
  message: string;
  /** Replay the writes that did not land, in order. */
  onRetry: () => void;
}

export function SaveFailedScreen({ message, onRetry }: SaveFailedScreenProps) {
  return (
    <div className="screen save-failed" role="alertdialog" aria-label="Answers are not being saved">
      <h1>Let&apos;s pause a moment</h1>
      <p>{message} Nothing you have already answered is lost.</p>
      <p>Please put your hand up so somebody from the team can help.</p>
      <div className="checkin-actions">
        <button type="button" className="next big" onClick={onRetry}>
          Try again
        </button>
      </div>
      <p className="hint">
        For the team: this iPad refused a write to its own storage, so the survey has stopped rather than carry on
        without recording answers. Free space on the device, or hand over what is on it and use another iPad.
      </p>
    </div>
  );
}
