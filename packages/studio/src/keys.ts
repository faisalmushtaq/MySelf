/**
 * Generating identifiers from what a researcher types.
 *
 * A question's key and variable end up as column names in every export and in
 * analysis scripts written years later, so they are made from the question's
 * own words ("How many hours do you sleep?" → `many_hours_sleep`) rather than
 * numbered: a column called `q17` has to be looked up every time it is read.
 *
 * Uniqueness is always against a set the caller supplies. That set must include
 * everything ever published (VersionDoc.itemKeys / variables) as well as what
 * the draft holds, because a key or variable that once meant one question may
 * never be given to another — old data would then be read as the new question.
 */

/** What the schema requires of a key or variable: lowercase snake_case, starting with a letter. */
export const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Longest key generated from question text. The schema allows 64; shorter keys read better in exports. */
export const MAX_KEY_LENGTH = 40;
/** The schema's (and Stata's) limit on a variable name. */
export const MAX_VARIABLE_LENGTH = 32;
/** The schema's limit on a dotted key such as a scale key. */
export const MAX_DOTTED_KEY_LENGTH = 96;

/**
 * Words that carry no meaning in a key. Dropped only when something is left,
 * so "Do you?" still becomes a key rather than nothing.
 */
const FILLER = new Set([
  "a", "an", "the", "do", "does", "did", "you", "your", "yours", "youre", "are", "is", "was", "were", "be",
  "been", "of", "to", "in", "on", "at", "for", "and", "or", "please", "what", "which", "how", "i", "im",
  "me", "my", "we", "our", "it", "its", "this", "that", "with", "any", "about", "would", "could", "can",
  "will", "if", "so", "as", "by", "from", "tell", "us",
]);

/** The words of a piece of text, lowercased and stripped of accents and punctuation. */
function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining accents: "café" → "cafe"
    .toLowerCase()
    .replace(/['’]/g, "") // "you've" → "youve", not "you_ve"
    .replace(/\{[^}]*\}/g, " ") // piped placeholders are not words of the question
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** Join words with underscores, stopping at a word boundary before `max` characters. */
function joinWithin(parts: string[], max: number): string {
  let out = "";
  for (const part of parts) {
    const next = out ? `${out}_${part}` : part;
    if (next.length > max) break;
    out = next;
  }
  // A single word longer than the limit is cut rather than lost.
  if (!out && parts[0]) out = parts[0].slice(0, max);
  return out.replace(/_+$/, "");
}

/** Lowercase snake_case of any text, e.g. "Sleep & rest" → "sleep_rest". May be empty. */
export function slugify(text: string, max = 64): string {
  return joinWithin(words(text), max);
}

/** Make a slug valid (starts with a letter) and within a length, using `fallback` if nothing is left. */
function validBase(slug: string, max: number, prefix: string, fallback: string): string {
  let base = slug;
  if (!base) base = fallback;
  else if (!/^[a-z]/.test(base)) base = `${prefix}${base}`;
  return base.slice(0, max).replace(/_+$/, "") || fallback;
}

/**
 * `base`, or `base_2`, `base_3`… — the first not in `taken`, cut so the whole
 * thing stays within `max`. Suffixes rather than rewording, so a copy of
 * `sleep_hours` is visibly `sleep_hours_2`.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>, max: number): string {
  const start = base.slice(0, max).replace(/_+$/, "");
  if (!taken.has(start)) return start;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A question key from its text: the meaningful words, snake_case, at most 40
 * characters, unique against `taken` (the keys already used in the same
 * instrument, including archived and published ones). Text that yields no
 * usable word gives `q`, `q_2`…; text that starts with a digit is prefixed
 * `q_` ("5 a day" → `q_5_day`).
 */
export function generateItemKey(text: string, taken: ReadonlySet<string>): string {
  const all = words(text);
  const meaningful = all.filter((w) => !FILLER.has(w));
  const slug = joinWithin(meaningful.length > 0 ? meaningful : all, MAX_KEY_LENGTH);
  return uniqueSlug(validBase(slug, MAX_KEY_LENGTH, "q_", "q"), taken, MAX_KEY_LENGTH);
}

/**
 * An analysis variable name from a base (usually the question key): at most 32
 * characters, unique against `taken` (every variable in the survey, archived
 * and published ones included).
 */
export function generateVariable(base: string, taken: ReadonlySet<string>): string {
  return uniqueSlug(validBase(slugify(base, MAX_VARIABLE_LENGTH), MAX_VARIABLE_LENGTH, "v_", "v"), taken, MAX_VARIABLE_LENGTH);
}

/**
 * A key for a question's own option list, `scale.<instrument>_<key>`, unique
 * against `taken` (every scale key in the draft and in its retired codes).
 */
export function generateScaleKey(instrument: string, key: string, taken: ReadonlySet<string>): string {
  const prefix = "scale.";
  const body = validBase(slugify(`${instrument}_${key}`, MAX_DOTTED_KEY_LENGTH - prefix.length), MAX_DOTTED_KEY_LENGTH - prefix.length, "s_", "options");
  const takenBodies = new Set([...taken].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  return `${prefix}${uniqueSlug(body, takenBodies, MAX_DOTTED_KEY_LENGTH - prefix.length)}`;
}

/** A section key from its title, unique against the survey's other section keys. */
export function generateSectionKey(title: string, taken: ReadonlySet<string>): string {
  return uniqueSlug(validBase(slugify(title, MAX_KEY_LENGTH), MAX_KEY_LENGTH, "s_", "section"), taken, MAX_KEY_LENGTH);
}
