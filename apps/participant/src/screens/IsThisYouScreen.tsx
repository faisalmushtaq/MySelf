/**
 * "Welcome back, Sam — is this you?" (D-75): the last step before an
 * unfinished sitting carries on, whether the participant got there with their
 * code, date of birth and initials or a researcher chose it from the panel.
 * Twins share a date of birth, and a resumed sitting used to say whose it was
 * only at the end. Only the first name is shown, and only once the checks
 * before it have passed.
 */
export function IsThisYouScreen({ firstName, busy, onYes, onNo }: { firstName: string; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className="screen checkin is-this-you">
      <h1>Welcome back, {firstName}!</h1>
      <p>Is this you? Only carry on if this is your name.</p>
      <div className="checkin-actions">
        <button type="button" className="next big" disabled={busy} onClick={() => onYes()}>
          Yes, that&apos;s me
        </button>
        <button type="button" className="decline" disabled={busy} onClick={() => onNo()}>
          No, that&apos;s not me
        </button>
      </div>
    </div>
  );
}
