import { parsePostcodeList, type PostcodeList } from "@myself/engine";
import westYorkshire from "../../../../releases/assets/postcodes-west-yorkshire-2026-09-07.txt?raw";

/**
 * The postcode lists this build carries, by the asset key a release names
 * (D-52). Bundled, so the check works with no network and no postcode leaves
 * the device. A test holds each to the hash the release pins, so the app can
 * never check against a list other than the one that was published.
 */
export const POSTCODE_LISTS: Record<string, string> = {
  postcodes_west_yorkshire: westYorkshire,
};

const parsed = new Map<string, PostcodeList>();

/** The list for an asset key, parsed once; null when this build does not carry it (no check, never a block). */
export function postcodeList(asset: string): PostcodeList | null {
  const cached = parsed.get(asset);
  if (cached) return cached;
  const text = POSTCODE_LISTS[asset];
  if (text === undefined) return null;
  const list = parsePostcodeList(text);
  parsed.set(asset, list);
  return list;
}
