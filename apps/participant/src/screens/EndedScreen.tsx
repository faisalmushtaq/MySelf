/**
 * What a participant sees once a researcher has ended the sitting (D-70):
 * thanks, and nothing that suggests they ran out of time or did anything
 * wrong. The researcher, holding the iPad, then readies it for the next person.
 */
export function EndedScreen({ onDone }: { onDone: () => void }) {
  return (
    <div className="screen finish">
      <h1>That's all for today — thank you! 🎉</h1>
      <p>Thank you for taking part. Your answers are saved safely on this device.</p>
      <button type="button" className="next big" onClick={() => onDone()}>
        Ready for the next person
      </button>
    </div>
  );
}
