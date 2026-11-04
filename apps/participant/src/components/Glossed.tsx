import { glossSegments, type GlossaryEntry } from "../lib/glossary.js";

/**
 * Text with the survey's explained words made tappable (D-79). The words stay
 * exactly as written — a licensed questionnaire's items are not reworded — and
 * the explanation opens under the question, not over it.
 *
 * A button may end a line where a word would not, so punctuation straight
 * after an explained word ("appetite?") is kept on the same line as it.
 */
export function Glossed({
  text,
  glossary,
  open,
  onOpen,
}: {
  text: string;
  glossary: readonly GlossaryEntry[] | undefined;
  open: GlossaryEntry | null;
  onOpen: (entry: GlossaryEntry) => void;
}) {
  const segments = glossSegments(text, glossary);
  if (segments.length === 1 && segments[0]!.kind === "text") return <>{text}</>;
  const out: JSX.Element[] = [];
  let carry = "";
  segments.forEach((s, i) => {
    if (s.kind === "text") {
      const rest = s.text.slice(carry.length);
      carry = "";
      if (rest) out.push(<span key={i}>{rest}</span>);
      return;
    }
    const next = segments[i + 1];
    carry = next?.kind === "text" ? (/^[^\s\p{L}\p{N}]+/u.exec(next.text)?.[0] ?? "") : "";
    const button = (
      <button type="button" className="gloss" aria-expanded={open === s.entry} aria-controls="gloss-note" onClick={() => onOpen(s.entry)}>
        {s.text}
      </button>
    );
    out.push(
      carry ? (
        <span key={i} className="gloss-keep">
          {button}
          {carry}
        </span>
      ) : (
        <span key={i}>{button}</span>
      ),
    );
  });
  return <>{out}</>;
}
