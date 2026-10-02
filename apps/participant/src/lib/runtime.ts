import {
  responseScale,
  scoringDefinition,
  type ReleaseManifest,
  type ResponseScale,
  type ScoringDefinition,
} from "@myself/schema";
import { flattenManifest, type FlattenedRelease } from "./flatten.js";
import type { ReleaseSource } from "./releases.js";
import { wordCount } from "./timing.js";

/**
 * Everything the screens derive from one release, derived once.
 *
 * App.tsx used to compute all of this at module load from the one manifest
 * compiled in. A release can now arrive at the start screen, and a resumed
 * sitting is rendered under the release it started with, so the same derivation
 * has to be available for any verified manifest — and has to be the SAME
 * derivation, line for line, or the built-in release would render differently
 * from the way it always has.
 */
export interface Runtime {
  manifest: ReleaseManifest;
  /** The content hash every sitting started under this runtime is stamped with. */
  hash: string;
  releaseKey: string;
  version: string;
  source: ReleaseSource;
  flattened: FlattenedRelease;
  scaleMap: Map<string, ResponseScale>;
  /**
   * Scoring frozen into this release, so a `score` pipe can tell a participant
   * something about what they just answered (D-33). Same definitions the server
   * will recompute from, so a screen and an export can never disagree. Handed to
   * `useScoringDefinitions` whenever this runtime is the one on screen.
   */
  scoring: Map<string, ScoringDefinition>;
  effort: ReleaseManifest["composition"]["effort"];
  codeRule: ReleaseManifest["composition"]["participantCode"];
  contact: ReleaseManifest["composition"]["contact"];
  finishScreen: ReleaseManifest["composition"]["screens"][string] | undefined;
  reviewScreen: ReleaseManifest["composition"]["screens"][string] | undefined;
  /** `<instrument>.<item>` of the unit at a position. Positions mean nothing across releases. */
  unitKeyOf: (i: number) => string;
  /**
   * How much reading a screen actually puts in front of someone — stem, lede,
   * and any consent statements. The too-fast threshold scales with it, so a
   * four-word battery item is not held to the same clock as a paragraph.
   */
  wordsAt: (i: number) => number;
}

/** Throws only if the manifest cannot be laid out, which verification has already ruled out. */
export function buildRuntime(manifest: ReleaseManifest, source: ReleaseSource = "built-in"): Runtime {
  const flattened = flattenManifest(manifest);
  const scaleMap = new Map<string, ResponseScale>(
    Object.entries(manifest.scales).map(([k, v]) => [k, responseScale.parse(v)]),
  );
  const scoring = new Map(Object.entries(manifest.scoring).map(([k, v]) => [k, scoringDefinition.parse(v)]));

  const unitKeyOf = (i: number): string => {
    const u = flattened.units[i];
    return u ? `${u.instrument}.${u.item.key}` : "";
  };

  const wordsAt = (i: number): number => {
    const item = flattened.units[i]?.item;
    if (!item) return 0;
    const statements = item.responseType === "checkbox_set" ? item.statements.map((st) => st.text.text) : [];
    return wordCount(item.stem.text, item.lede?.text, ...statements);
  };

  return {
    manifest,
    hash: manifest.hash ?? "",
    releaseKey: manifest.release.key,
    version: manifest.release.version,
    source,
    flattened,
    scaleMap,
    scoring,
    effort: manifest.composition.effort,
    codeRule: manifest.composition.participantCode,
    contact: manifest.composition.contact,
    finishScreen: manifest.composition.screens["finish"],
    reviewScreen: manifest.composition.screens["review"],
    unitKeyOf,
    wordsAt,
  };
}
