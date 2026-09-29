/**
 * Postcodes, for the home-address question (D-52).
 *
 * The survey checks a postcode against a list shipped with the release — every
 * West Yorkshire postcode in use, with the council ward and district it lies
 * in — so the check works with no network, which is the normal case in a
 * school, and no postcode leaves the device to be looked up.
 *
 * A postcode that is not in the list is never refused: the participant is
 * asked to check it, and whatever they then give is kept. The list can be out
 * of date (new streets), and a child who lives outside the area still has an
 * address.
 */

export interface PostcodeArea {
  ward: string;
  district: string;
}

export interface PostcodeList {
  /** Postcodes in the list. */
  readonly size: number;
  /** The area a postcode lies in, or null if it is not in the list. */
  lookup(postcode: string): PostcodeArea | null;
}

/**
 * A postcode in its standard form — upper case, one space before the last three
 * characters — or null when the input is not the shape of a UK postcode.
 * "ls62aa", " LS6  2AA " and "ls6 2aa" are all "LS6 2AA".
 */
export function normalisePostcode(input: string): string | null {
  const compact = input.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/**
 * Read a list in the format scripts/build-postcodes.mjs writes: comment lines,
 * "@area <n> <ward>|<district>" lines, then "<outward> <inward>[=<n>] …" lines
 * where an inward code without "=<n>" is in the same area as the one before it.
 */
export function parsePostcodeList(text: string): PostcodeList {
  const areas: PostcodeArea[] = [];
  const index = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("@area ")) {
      const m = /^@area (\d+) (.+)\|(.+)$/.exec(line);
      if (!m) throw new Error(`postcode list: unreadable area line '${line}'`);
      areas[Number(m[1])] = { ward: m[2]!, district: m[3]! };
      continue;
    }
    const [outward, ...inwards] = line.split(" ");
    let area = -1;
    for (const part of inwards) {
      const [inward, n] = part.split("=");
      if (n !== undefined) area = Number(n);
      if (!inward || !areas[area]) throw new Error(`postcode list: '${outward} ${part}' has no area`);
      index.set(`${outward} ${inward}`, area);
    }
  }
  return {
    size: index.size,
    lookup(postcode: string) {
      const normal = normalisePostcode(postcode);
      if (normal === null) return null;
      const area = index.get(normal);
      return area === undefined ? null : areas[area]!;
    },
  };
}
