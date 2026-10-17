/**
 * Cut typed text to a limit without cutting a character in half.
 *
 * THE BUG. The text controls cut with `input.slice(0, maxChars)`, which counts
 * UTF-16 code units. An emoji is two of them, so a 🎉 typed across the limit
 * was cut down the middle and left half a surrogate pair in the answer —
 * text no encoder can represent, which the server refuses, and with it the
 * whole sitting, on every retry, for ever.
 *
 * So the text is cut at the last whole character (a whole grapheme where the
 * engine can say what one is — 👍🏽 or 🇬🇧 is several code points that read as
 * one) that still fits. The limit stays in code units, because that is how the
 * server and `maxLength` count it, so what is kept is always accepted. Any
 * lone surrogate already in the text (pasted, or from an older draft) becomes
 * U+FFFD, the replacement character, for the same reason.
 */
export function truncateText(input: string, max: number): string {
  const text = wellFormed(input);
  if (text.length <= max) return text;
  let out = "";
  for (const piece of pieces(text)) {
    if (out.length + piece.length > max) break;
    out += piece;
  }
  return out;
}

function pieces(text: string): Iterable<string> {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text); // code points
}

/** Every unpaired surrogate replaced with U+FFFD; everything else unchanged. */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}
