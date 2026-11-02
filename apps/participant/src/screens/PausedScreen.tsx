/**
 * A sitting a researcher has paused (D-73): nothing of it on screen, no
 * timeout for an hour, and one button to carry on where it was.
 */
export function PausedScreen({ onCarryOn }: { onCarryOn: () => void }) {
  return (
    <div className="screen finish paused">
      <h1>Paused</h1>
      <p>The researcher will start the survey again in a moment.</p>
      <button type="button" className="next big" onClick={() => onCarryOn()}>
        Carry on
      </button>
    </div>
  );
}
