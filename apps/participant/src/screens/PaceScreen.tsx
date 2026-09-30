/**
 * "No rush": shown when a run of answers came in faster than the questions could
 * have been read (`effort.tooFastRunPrompt` in a row, set by the release). It
 * accuses nobody and offers no choice but to carry on — the point is the pause.
 * Every answer given stands, and the run starts counting again from nothing.
 */
export interface PaceScreenProps {
  /** Back to the question the survey was about to show. */
  onCarryOn: () => void;
}

export function PaceScreen({ onCarryOn }: PaceScreenProps) {
  return (
    <div className="screen checkin">
      <h1>No rush</h1>
      <p>
        The last few answers came in very quickly. There&apos;s no time limit here, and no right answers — take
        as long as you like reading each one.
      </p>
      <div className="checkin-actions">
        <button type="button" className="next big" onClick={() => onCarryOn()}>
          Carry on
        </button>
      </div>
    </div>
  );
}
