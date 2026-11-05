import { parsePostcodeList, type PostcodeList } from "@myself/engine";
import westYorkshire from "../../../../releases/assets/postcodes-west-yorkshire-2026-09-07.txt?raw";

/**
 * The postcode lists this build carries, by the asset key a release names
 * (D-52). Carried by the build, so the check works with no network and no
 * postcode leaves the device. A test holds each to the hash the release pins,
 * so the app can never check against a list other than the one published.
 *
 * West Yorkshire's is in the app itself, as it always was. Yorkshire and the
 * Humber's (D-83) is more than twice the size, so it is a separate chunk of the
 * app, loaded when an address question first needs it — still precached by the
 * service worker, so it works offline.
 */
export const POSTCODE_LISTS: Record<string, () => Promise<string>> = {
  postcodes_west_yorkshire: () => Promise.resolve(westYorkshire),
  postcodes_yorkshire_humber: () =>
    import("../../../../releases/assets/postcodes-yorkshire-humber-2026-09-07.txt?raw").then((m) => m.default),
};

const parsed = new Map<string, PostcodeList>();
const loading = new Map<string, Promise<PostcodeList | null>>();

/** The list for an asset key if it is already loaded; null otherwise (no check, never a block). */
export function postcodeList(asset: string): PostcodeList | null {
  if (!parsed.has(asset) && asset === "postcodes_west_yorkshire") parsed.set(asset, parsePostcodeList(westYorkshire));
  return parsed.get(asset) ?? null;
}

/** The list for an asset key, loaded and parsed once; null when this build does not carry it. */
export function loadPostcodeList(asset: string): Promise<PostcodeList | null> {
  const ready = postcodeList(asset);
  if (ready) return Promise.resolve(ready);
  const inFlight = loading.get(asset);
  if (inFlight) return inFlight;
  const load = POSTCODE_LISTS[asset];
  const list = load
    ? load().then(
        (text) => {
          const l = parsePostcodeList(text);
          parsed.set(asset, l);
          return l;
        },
        // A chunk that fails to load leaves the question working without a check, and is tried again next time.
        () => {
          loading.delete(asset);
          return null;
        },
      )
    : Promise.resolve(null);
  loading.set(asset, list);
  return list;
}
