import { z } from "zod";
import { REGION_AREAS, REGION_OUTWARDS } from "./address-outwards.js";

/**
 * The address finder's rules (D-81): what the iPad may ask, what is asked of
 * Ideal Postcodes, how its answers are read, and how much may be spent.
 *
 * Separate from the function for the same reason as relay-policy.ts: nothing
 * here touches Firebase, a network or a key, so every rule can be tested.
 */

/**
 * The postcode districts with addresses in Yorkshire and the Humber (D-83;
 * West Yorkshire only until then): every live postcode in the region's fifteen
 * councils, from the ONS Postcode Directory (generated, address-outwards.ts).
 * Suggestions are limited to these, so a child only ever sees addresses in the
 * region. A few districts cross its edge (BB18 or S40, say), so an address just
 * outside can appear; the postcode check on the iPad then says so, as for any
 * postcode outside the list.
 */
export const ADDRESS_OUTWARDS: readonly string[] = REGION_OUTWARDS;

/**
 * The postcode areas most of the region lies in, if Ideal Postcodes refuses the
 * district list: the areas of the region's districts, without those it only
 * touches at its edge (Lancashire's BB and LA, Teesside's TS, County Durham's
 * DL, Lincoln's LN, Oldham's OL).
 */
export const ADDRESS_AREAS = REGION_AREAS.filter((a) => !["BB", "DL", "LA", "LN", "OL", "TS"].includes(a)).join(",");

/** Middle of Yorkshire and the Humber (near York), and far enough to cover it: nearer addresses first. */
export const ADDRESS_BIAS = "-1.25,53.95,110000";

export const SUGGESTIONS = 6;
const SUGGESTION_ID = /^[A-Za-z0-9_|.:-]{1,80}$/;

/** What an iPad may send: what has been typed so far, or the id of the suggestion chosen. */
export const addressRequest = z.union([
  z.object({ study: z.string().max(64).optional(), search: z.string().min(3).max(100) }).strict(),
  z.object({ study: z.string().max(64).optional(), pick: z.string().regex(SUGGESTION_ID) }).strict(),
]);
export type AddressRequest = z.infer<typeof addressRequest>;

/** What has been typed, tidied for a search: 3 to 100 characters with a letter or number in it, or null. */
export function searchText(input: string): string | null {
  const text = input.replace(/\s+/g, " ").trim();
  return text.length >= 3 && text.length <= 100 && /[A-Za-z0-9]/.test(text) ? text : null;
}

/** The query for suggestions: limited to the region's districts, or its postcode areas as the second try. */
export function suggestParams(query: string, narrow: "districts" | "areas"): Record<string, string> {
  return {
    query,
    limit: String(SUGGESTIONS),
    context: "GBR",
    ...(narrow === "districts" ? { postcode_outward: ADDRESS_OUTWARDS.join(",") } : { postcode_area: ADDRESS_AREAS }),
    bias_lonlat: ADDRESS_BIAS,
  };
}

export interface Suggestion {
  id: string;
  label: string;
}

/** Ideal Postcodes' suggestions as the iPad shows them: its own wording, as it advises. */
export function suggestionsFrom(hits: unknown): Suggestion[] {
  if (!Array.isArray(hits)) return [];
  return hits
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
    .filter((h) => typeof h["id"] === "string" && SUGGESTION_ID.test(h["id"]) && typeof h["suggestion"] === "string" && h["suggestion"].trim() !== "")
    .slice(0, SUGGESTIONS)
    .map((h) => ({ id: h["id"] as string, label: (h["suggestion"] as string).replace(/\s+/g, " ").trim().slice(0, 200) }));
}

/** Royal Mail's towns are in capitals: "LEEDS" is "Leeds", "SOWERBY BRIDGE" is "Sowerby Bridge". */
export function townCase(town: string): string {
  const small = new Set(["on", "upon", "in", "le", "by", "under", "the", "de"]);
  return town
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

/** A chosen address, in the item's own keys (D-52, D-53): house, street, postcode, area, district, and its UPRN. */
export interface FoundAddress {
  house: string;
  street: string;
  postcode: string;
  area: string;
  postcodeDistrict: string;
  uprn: string;
}

/**
 * An Ideal Postcodes address record in the address question's own terms.
 *
 * The house is the flat, building name and number ("Flat 3, 24"; "Rose
 * Cottage"); the street is the thoroughfare, or the locality for an address
 * without one. The area is said the way the street list says it ("Headingley,
 * Leeds"). The UPRN is kept as a string: it can exceed what a number holds.
 */
export function addressFrom(record: unknown): FoundAddress | null {
  if (!record || typeof record !== "object") return null;
  const a = record as Record<string, unknown>;
  const text = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : typeof a[k] === "number" ? String(a[k]) : "");
  const postcode = text("postcode").toUpperCase();
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$/.test(postcode)) return null;
  const house = [text("sub_building_name"), text("building_name"), text("building_number")].filter(Boolean).join(", ");
  const thoroughfare = [text("dependant_thoroughfare"), text("thoroughfare")].filter(Boolean).join(", ");
  const locality = text("dependant_locality");
  const town = text("post_town") ? townCase(text("post_town")) : "";
  const street = thoroughfare || locality || text("line_1");
  const area = [thoroughfare ? locality : "", town].filter((x, i, all) => x && all.indexOf(x) === i).join(", ");
  const uprn = text("uprn");
  return {
    house: (house || (thoroughfare ? "" : text("line_1"))).slice(0, 60),
    street: street.slice(0, 100),
    postcode,
    area,
    postcodeDistrict: postcode.split(" ")[0]!,
    uprn: /^\d{1,12}$/.test(uprn) ? uprn : "",
  };
}

export type Outcome = { kind: "found" } | { kind: "not-found" } | { kind: "refused-filter" } | { kind: "unavailable"; reason: "no-credit" | "limit" | "key" | "provider" };

/** What an answer from Ideal Postcodes means. Its own code is read first, as its documentation asks. */
export function outcomeOf(status: number, body: unknown): Outcome {
  const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "number" ? (body as { code: number }).code : null;
  if (status === 200 && code === 2000) return { kind: "found" };
  if (status === 404) return { kind: "not-found" };
  // A filter it would not take (too many districts, say): worth asking again more broadly.
  if (status === 400 && (code === 40014 || code === 40016 || code === 4000 || code === 4001)) return { kind: "refused-filter" };
  if (code === 4020) return { kind: "unavailable", reason: "no-credit" };
  if (code === 4021) return { kind: "unavailable", reason: "limit" };
  if (status === 401 || status === 403 || code === 4010 || code === 4011 || code === 4015) return { kind: "unavailable", reason: "key" };
  return { kind: "unavailable", reason: "provider" };
}

/**
 * How much may be asked, per iPad and per study, per day.
 *
 * A chosen address costs a lookup; suggestions are free, but Ideal Postcodes
 * suspends accounts that ask for many without choosing, so they are capped too.
 * An iPad does a handful of sittings a day, each needing one address; the
 * study's ceiling is the bill's ceiling. Unset variables mean these defaults.
 */
export const ADDRESS_LIMITS = {
  lookupsPerDevice: Number(process.env["MYSELF_ADDRESS_DEVICE_DAILY_LIMIT"] ?? 40),
  suggestionsPerDevice: Number(process.env["MYSELF_ADDRESS_DEVICE_DAILY_LIMIT"] ?? 40) * 25,
  lookupsPerStudy: Number(process.env["MYSELF_ADDRESS_DAILY_LIMIT"] ?? 1500),
  suggestionsPerStudy: Number(process.env["MYSELF_ADDRESS_DAILY_LIMIT"] ?? 1500) * 10,
};

export type Kind = "lookup" | "suggestion";

/** Whether one more of a kind is allowed, given what has been used today. */
export function withinLimits(kind: Kind, device: number, study: number, limits = ADDRESS_LIMITS): "yes" | "device" | "study" {
  const [perDevice, perStudy] =
    kind === "lookup" ? [limits.lookupsPerDevice, limits.lookupsPerStudy] : [limits.suggestionsPerDevice, limits.suggestionsPerStudy];
  if (device >= perDevice) return "device";
  if (study >= perStudy) return "study";
  return "yes";
}
