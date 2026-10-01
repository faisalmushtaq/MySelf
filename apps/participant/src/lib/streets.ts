import { parseStreetList, type StreetList } from "@myself/engine";

/**
 * The street lists this build carries, by the asset key a release names (D-53).
 *
 * Loaded only when someone says they don't know their postcode: the list is
 * twice the size of the postcode list and most people never need it. It is a
 * separate chunk of the app, so the service worker still precaches it and the
 * search works offline. A test holds each to the hash the release pins.
 */
export const STREET_LISTS: Record<string, () => Promise<string>> = {
  streets_west_yorkshire: () =>
    import("../../../../releases/assets/streets-west-yorkshire-2026-07.txt?raw").then((m) => m.default),
};

const loaded = new Map<string, Promise<StreetList | null>>();

/** The list for an asset key, parsed once; null when this build does not carry it (no matching, never a block). */
export function streetList(asset: string): Promise<StreetList | null> {
  const cached = loaded.get(asset);
  if (cached) return cached;
  const load = STREET_LISTS[asset];
  const list = load
    ? load().then(
        (text) => parseStreetList(text),
        // A chunk that fails to load leaves the question working as before —
        // the street is kept as typed — and is tried again next time.
        () => {
          loaded.delete(asset);
          return null;
        },
      )
    : Promise.resolve(null);
  loaded.set(asset, list);
  return list;
}
