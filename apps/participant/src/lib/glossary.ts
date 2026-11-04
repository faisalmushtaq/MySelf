/**
 * Word explanations (D-79): where a survey's explained words appear in a
 * question, so they can be tapped. Pure, so the matching is tested apart from
 * the screen.
 *
 * Whole words only ("appetite" is found in "my appetite." but "fun" is not in
 * "funny"), any case, the longest explained phrase first where two overlap,
 * and each word marked once per piece of text — a question that says
 * "optimistic" twice needs one place to tap, not two.
 */

export interface GlossaryEntry {
  term: string;
  explanation: string;
}

export type GlossSegment = { kind: "text"; text: string } | { kind: "term"; text: string; entry: GlossaryEntry };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` cut into plain runs and explained words, in order. */
export function glossSegments(text: string, glossary: readonly GlossaryEntry[] | undefined): GlossSegment[] {
  const entries = (glossary ?? []).filter((g) => g.term.trim() && g.explanation.trim());
  if (!text || entries.length === 0) return [{ kind: "text", text }];
  // Longest first, so "bad news" wins over "news" where both are explained.
  const ordered = [...entries].sort((a, b) => b.term.trim().length - a.term.trim().length);
  // A letter or digit on either side means it is part of a longer word.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${ordered.map((g) => escape(g.term.trim()).replace(/\s+/g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const byTerm = new Map(ordered.map((g) => [g.term.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB"), g]));
  const used = new Set<GlossaryEntry>();
  const out: GlossSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const entry = byTerm.get(match[0].replace(/\s+/g, " ").toLocaleLowerCase("en-GB"));
    if (!entry || used.has(entry)) continue;
    used.add(entry);
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push({ kind: "term", text: match[0], entry });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.length > 0 ? out : [{ kind: "text", text }];
}
