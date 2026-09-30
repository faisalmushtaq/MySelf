import { releaseManifest, type ReleaseManifest } from "@myself/schema";
import rawManifest from "../../../../releases/ybm_nd2026_standard_r9.0.0.manifest.json";

/**
 * The release built into this app: r9.0.0.
 *
 * What a device runs when the study has made no version active from the
 * dashboard, or cannot be reached and nothing newer is stored (D-54,
 * `versions.ts`). A new release cut in this repository is bundled by changing
 * the import above.
 */
export const bundledManifest: ReleaseManifest = releaseManifest.parse(rawManifest);
