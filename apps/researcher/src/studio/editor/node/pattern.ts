/**
 * Answer formats ("patterns") in plain English, and a tester that applies a
 * pattern exactly as the participant app does.
 *
 * The participant app checks a typed answer — and the participant code on the
 * start screen — with `new RegExp(pattern).test(answer.trim())`. So a pattern
 * without ^ and $ matches the rule anywhere inside the answer, not the whole
 * answer; the tester says so, because that is the mistake a regular expression
 * makes silently.
 */

export type PatternResult =
  | { status: "empty" }
  | { status: "invalid"; message: string }
  | { status: "match"; message: string }
  | { status: "no-match"; message: string };

/** Whether a pattern compiles, with the reason when it doesn't. */
export function patternError(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^Invalid regular expression: /, "") : String(error);
    return `This isn't a pattern the app can use (${detail}). Check its brackets and symbols.`;
  }
}

/** Test a sample the way the participant app would. */
export function testPattern(pattern: string, sample: string): PatternResult {
  if (sample.trim() === "") return { status: "empty" };
  const error = patternError(pattern);
  if (error) return { status: "invalid", message: error };
  const trimmed = sample.trim();
  return new RegExp(pattern).test(trimmed)
    ? { status: "match", message: `“${trimmed}” would be accepted.` }
    : { status: "no-match", message: `“${trimmed}” would be refused, and the participant shown the format hint.` };
}

/** Starts with ^ and ends with an unescaped $: the rule is about the whole answer. */
export function isAnchored(pattern: string): boolean {
  return pattern.startsWith("^") && /(^|[^\\])(\\\\)*\$$/.test(pattern);
}

type Unit = { what: string; plural: string } | { literal: string };

const CLASS_NAMES: Record<string, { what: string; plural: string }> = {
  "A-Za-z": { what: "letter", plural: "letters" },
  "a-zA-Z": { what: "letter", plural: "letters" },
  "A-Z": { what: "capital letter", plural: "capital letters" },
  "a-z": { what: "lowercase letter", plural: "lowercase letters" },
  "0-9": { what: "digit", plural: "digits" },
  "A-Za-z0-9": { what: "letter or digit", plural: "letters or digits" },
  "a-zA-Z0-9": { what: "letter or digit", plural: "letters or digits" },
  "A-Z0-9": { what: "capital letter or digit", plural: "capital letters or digits" },
  "a-z0-9": { what: "lowercase letter or digit", plural: "lowercase letters or digits" },
  "0-9A-Za-z": { what: "letter or digit", plural: "letters or digits" },
};

const ESCAPES: Record<string, { what: string; plural: string }> = {
  d: { what: "digit", plural: "digits" },
  w: { what: "letter, digit or underscore", plural: "letters, digits or underscores" },
  s: { what: "space", plural: "spaces" },
};

function count(n: number, unit: { what: string; plural: string }): string {
  return `${n} ${n === 1 ? unit.what : unit.plural}`;
}

/**
 * A plain-English reading of a simple pattern — "3 letters, then 4 digits" —
 * or null when the pattern uses anything this reader does not cover (groups,
 * alternatives, look-arounds). Null is shown as "a custom format; test some
 * answers to check it", never as a guess.
 */
export function explainPattern(pattern: string): string | null {
  if (patternError(pattern)) return null;
  let body = pattern;
  const anchoredStart = body.startsWith("^");
  if (anchoredStart) body = body.slice(1);
  const anchoredEnd = /(^|[^\\])(\\\\)*\$$/.test(body);
  if (anchoredEnd) body = body.slice(0, -1);
  if (body === "") return null;

  const parts: string[] = [];
  let literal = "";
  const flush = () => {
    if (literal) parts.push(literal.length === 1 ? `the character “${literal}”` : `the text “${literal}”`);
    literal = "";
  };

  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    let unit: Unit;
    if (ch === "[") {
      const close = body.indexOf("]", i + 1);
      if (close < 0) return null;
      const inner = body.slice(i + 1, close);
      if (inner.startsWith("^")) return null;
      const known = CLASS_NAMES[inner];
      if (known) unit = known;
      else if (/^[^\\\-\]]+$/.test(inner)) unit = { what: `one of “${inner}”`, plural: `characters from “${inner}”` };
      else return null;
      i = close + 1;
    } else if (ch === "\\") {
      const next = body[i + 1];
      if (next === undefined) return null;
      const known = ESCAPES[next];
      if (known) unit = known;
      else if (/[A-Za-z0-9]/.test(next)) return null;
      else unit = { literal: next };
      i += 2;
    } else if (ch === ".") {
      unit = { what: "character of any kind", plural: "characters of any kind" };
      i += 1;
    } else if ("()|?*+{}^$".includes(ch)) {
      return null;
    } else {
      unit = { literal: ch };
      i += 1;
    }

    // A quantifier after the unit.
    const rest = body.slice(i);
    const braces = /^\{(\d+)(,(\d*))?\}/.exec(rest);
    let phrase: string | null = null;
    if (braces) {
      const min = Number(braces[1]);
      const hasComma = braces[2] !== undefined;
      const max = braces[3] ? Number(braces[3]) : null;
      const u = "literal" in unit ? { what: `“${unit.literal}”`, plural: `“${unit.literal}”s` } : unit;
      phrase = !hasComma
        ? count(min, u)
        : max === null
          ? `${min} or more ${u.plural}`
          : `between ${min} and ${max} ${u.plural}`;
      i += braces[0].length;
    } else if (rest[0] === "+" || rest[0] === "*" || rest[0] === "?") {
      const u = "literal" in unit ? { what: `“${unit.literal}”`, plural: `“${unit.literal}”s` } : unit;
      phrase = rest[0] === "+" ? `one or more ${u.plural}` : rest[0] === "*" ? `any number of ${u.plural}` : `optionally 1 ${u.what}`;
      i += 1;
    }
    if (body[i] === "?" || body[i] === "+") return null; // lazy or possessive quantifiers

    if (phrase === null && "literal" in unit) {
      literal += unit.literal;
      continue;
    }
    flush();
    parts.push(phrase ?? `1 ${(unit as { what: string }).what}`);
  }
  flush();

  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", then ")}, then ${parts[parts.length - 1]}`;
  if (anchoredStart && anchoredEnd) return `The whole answer must be ${list}.`;
  if (anchoredStart) return `The answer must start with ${list}; anything may follow it.`;
  if (anchoredEnd) return `The answer must end with ${list}; anything may come before it.`;
  return `The answer must contain ${list} somewhere — anything may come before or after it, because the pattern has no ^ at the start or $ at the end.`;
}
