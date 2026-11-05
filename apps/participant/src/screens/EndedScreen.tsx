/**
 * What a participant sees once a researcher has ended the sitting (D-70):
 * thanks, and nothing that suggests they ran out of time or did anything
 * wrong. The researcher, holding the iPad, then readies it for the next person.
 *
 * And where to get support (D-82): a sitting ended early never reaches the
 * finish screen, which is where the survey says who to talk to after
 * questions about difficult feelings. So the finish screen's text is shown
 * here too, as the survey wrote it.
 */
/** The finish screen's text after its first paragraph (the thanks, said here already): where to get support. */
export function supportFrom(finishBody: string | undefined): string | null {
  const rest = (finishBody ?? "").split(/\n{2,}/).slice(1).join("\n\n").trim();
  return rest || null;
}

export function EndedScreen({ onDone, support }: { onDone: () => void; support?: string | null }) {
  return (
    <div className="screen finish">
      <h1>That's all for today — thank you! 🎉</h1>
      <p>Thank you for taking part. Your answers are saved safely on this device.</p>
      {support?.trim() ? <p className="ended-support">{support}</p> : null}
      <button type="button" className="next big" onClick={() => onDone()}>
        Ready for the next person
      </button>
    </div>
  );
}
