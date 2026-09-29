/**
 * Streets, for someone who does not know their postcode (D-53).
 *
 * The address question offers the named roads of West Yorkshire closest to what
 * was typed, each with the area and postcode district it runs through, so a
 * participant can recognise their own. The list ships with the release, like
 * the postcode list: it works with no network, and nothing typed leaves the
 * device to be looked up.
 *
 * Matching is forgiving on purpose. People write "Rd" for "Road", "St" for
 * "Street" or "Saint", leave out apostrophes, start with the house number, and
 * mistype. None of that should stop their street being found. A street the list
 * does not know is never refused: the participant keeps what they typed.
 */

export interface StreetMatch {
  /** As the list spells it: "Hyde Park Road". */
  street: string;
  /** "Horsforth, Leeds", or just the district where OS names no other place. */
  area: string;
  /** Postcode district ("LS6"); empty where the list gives none. */
  outward: string;
}

export interface StreetList {
  /** Street entries in the list (one per street, area and postcode district). */
  readonly size: number;
  /** The closest entries to what was typed, best first; empty for under three letters. */
  search(query: string, limit?: number): StreetMatch[];
}

/** Common abbreviations, to the form the list's names are compared in. */
const ABBREVIATIONS: Record<string, string> = {
  rd: "road",
  // "Street" and "Saint" are both written "St"; compared as one token, so
  // either spelling finds either.
  st: "st",
  str: "st",
  street: "st",
  saint: "st",
  ave: "avenue",
  av: "avenue",
  ln: "lane",
  dr: "drive",
  cres: "crescent",
  cresc: "crescent",
  cl: "close",
  ct: "court",
  gdns: "gardens",
  gro: "grove",
  gr: "grove",
  pl: "place",
  sq: "square",
  ter: "terrace",
  terr: "terrace",
  tce: "terrace",
  mt: "mount",
  pk: "park",
  grn: "green",
  wk: "walk",
};

/**
 * A street name as it is compared: lower case, no accents or punctuation,
 * abbreviations spelled out, and any house number at the front dropped —
 * "12a St. Michael's Rd" and "st michaels road" compare equal.
 */
export function normaliseStreet(input: string): string {
  const tokens = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (tokens.length > 1 && /^\d+[a-z]?$/.test(tokens[0]!)) tokens.shift();
  return tokens.map((t) => ABBREVIATIONS[t] ?? t).join(" ");
}

/**
 * Edit distance counting a swap of two neighbouring letters as one edit
 * (optimal string alignment), giving up once it must exceed `limit`.
 */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      cur.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > limit) return limit + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Letter counts of a normalised name (a-z, 0-9, space), for a cheap bound on distance. */
const SLOTS = 37;
const slotOf = (code: number): number => (code === 32 ? 36 : code >= 97 ? code - 97 : code - 22);
function countsOf(text: string, length = text.length): Int16Array {
  const counts = new Int16Array(SLOTS);
  for (let i = 0; i < length && i < text.length; i += 1) counts[slotOf(text.charCodeAt(i))]! += 1;
  return counts;
}

const scratch = new Int16Array(SLOTS);
/**
 * A lower bound on the edit distance between the query (by its counts) and the
 * first `length` characters of `text`: every edit changes the letter counts by
 * at most two, so half the total difference, rounded up, is a floor. Costs a
 * pass over the name, where the full distance costs a pass per letter — most
 * of 40,000 names are ruled out here.
 */
function countBound(query: Int16Array, text: string, length: number): number {
  scratch.set(query);
  for (let i = 0; i < length && i < text.length; i += 1) scratch[slotOf(text.charCodeAt(i))]! -= 1;
  let total = 0;
  for (let i = 0; i < SLOTS; i += 1) total += Math.abs(scratch[i]!);
  return Math.ceil(total / 2);
}

interface Entry extends StreetMatch {
  /** The name as compared. */
  key: string;
  /** Name, place and district as compared, for a query that names the area too. */
  full: string;
}

/** How close a typed street is to one entry, from 0 (nothing alike) to 1 (the same). */
function closeness(q: string, qCounts: Int16Array, e: Entry): number {
  if (e.key === q) return 1;
  if (e.key.startsWith(q)) return 0.9 + 0.08 * (q.length / e.key.length);
  if (e.full.startsWith(q)) return 0.88;
  if (e.key.includes(` ${q}`)) return 0.8;
  // Typing mistakes: the whole name, or — while still typing — its start. The
  // count bound skips the full comparison for names that cannot be close.
  const limit = Math.max(1, Math.floor(q.length / 4));
  const whole =
    Math.abs(q.length - e.key.length) <= limit && countBound(qCounts, e.key, e.key.length) <= limit
      ? distance(q, e.key, limit)
      : limit + 1;
  const start = countBound(qCounts, e.key, q.length) <= limit ? distance(q, e.key.slice(0, q.length), limit) : limit + 1;
  const best = Math.max(
    whole <= limit ? 1 - whole / Math.max(q.length, e.key.length) : 0,
    start <= limit ? 0.85 * (1 - start / q.length) : 0,
  );
  return best;
}

/**
 * Read a list in the format scripts/build-streets.mjs writes: comment lines,
 * "@<place>|<district>|<outward>" block headers, then one street per line.
 */
export function parseStreetList(text: string): StreetList {
  const entries: Entry[] = [];
  let area: string | null = null;
  let outward = "";
  let areaKey = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("@")) {
      const parts = line.slice(1).split("|");
      if (parts.length !== 3 || !parts[1]) throw new Error(`street list: unreadable block header '${line}'`);
      const [place, district, out] = parts as [string, string, string];
      // OS often names the town itself as the place ("Leeds|Leeds"): said once.
      area = place && place !== district ? `${place}, ${district}` : district;
      outward = out;
      areaKey = normaliseStreet(`${place} ${district}`);
      continue;
    }
    if (area === null) throw new Error(`street list: '${line}' comes before any area`);
    const key = normaliseStreet(line);
    entries.push({ street: line, area, outward, key, full: `${key} ${areaKey}` });
  }
  return {
    size: entries.length,
    search(query: string, limit = 5) {
      const q = normaliseStreet(query);
      if (q.replace(/[^a-z]/g, "").length < 3) return [];
      const qCounts = countsOf(q);
      const scored: { e: Entry; s: number }[] = [];
      for (const e of entries) {
        const s = closeness(q, qCounts, e);
        if (s >= 0.5) scored.push({ e, s });
      }
      scored.sort((a, b) => b.s - a.s || a.e.street.localeCompare(b.e.street) || a.e.area.localeCompare(b.e.area));
      return scored.slice(0, limit).map(({ e }) => ({ street: e.street, area: e.area, outward: e.outward }));
    },
  };
}
