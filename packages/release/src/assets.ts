import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Registries } from "./builder.js";

/**
 * Files a release carries besides its definitions, keyed as items name them
 * (D-52). Each entry is a deliberate choice of one dated file: a newer list is
 * a new file and a new entry here, never an edit to one a release already pins.
 */
export const ASSET_FILES: Record<string, string> = {
  postcodes_west_yorkshire: "releases/assets/postcodes-west-yorkshire-2026-09-07.txt",
  // OS Open Names, July 2026 edition (D-53); built by scripts/build-streets.mjs.
  streets_west_yorkshire: "releases/assets/streets-west-yorkshire-2026-07.txt",
};

/** The assets as a release pins them: path, content hash and size. Node only. */
export function releaseAssets(root: string = fileURLToPath(new URL("../../../", import.meta.url))): NonNullable<Registries["assets"]> {
  return Object.fromEntries(
    Object.entries(ASSET_FILES).map(([key, path]) => {
      const bytes = readFileSync(`${root}${path}`);
      return [key, { path, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length }];
    }),
  );
}
