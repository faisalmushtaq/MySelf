/**
 * "Just checking in": shown after a run of skipped or declined questions
 * (`effort.skipRunCheckIn` in the release). Leaving questions blank is allowed,
 * so both ways on are offered as equals — back to the first one skipped, or on
 * to the next question.
 */
export interface CheckInScreenProps {
  /** Back to the first question of the run that was left blank. */
  onGoBack: () => void;
  /** On to the question the survey was about to show. */
  onKeepGoing: () => void;
}

export function CheckInScreen({ onGoBack, onKeepGoing }: CheckInScreenProps) {
  return (
    <div className="screen checkin">
      <h1>Just checking in</h1>
      <p>
        You&apos;ve left the last few questions blank. That&apos;s completely allowed — but if any of them
        were skipped by accident, you can go back to them now.
      </p>
      <div className="checkin-actions">
        <button type="button" className="next big" onClick={() => onGoBack()}>
          Go back to them
        </button>
        <button type="button" className="decline" onClick={() => onKeepGoing()}>
          Keep going
        </button>
      </div>
    </div>
  );
}
