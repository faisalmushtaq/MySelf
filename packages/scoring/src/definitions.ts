import type { z } from "zod";
import type { scoringDefinition } from "@myself/schema";

/**
 * YBM scoring definitions. All consume CANONICAL codes (the crosswalk handles
 * legacy 1-based codings upstream). `verified: false` marks rules transcribed
 * from standard published practice that must still be checked against the
 * licensed scoring documentation before instrument approval — the platform
 * never presents unverified scoring as authoritative.
 */

export type ScoringInput = z.input<typeof scoringDefinition>;

const q = (ns: number[]): string[] => ns.map((n) => `q${n}`);

/** SDQ self-report: canonical 0-2 codes; 5 reverse items; subscale sums with
 * standard >=3-of-5 proration; total difficulties = sum of 4 problem subscales. */
export const scoreSdq25S: ScoringInput = {
  key: "score.sdq25_s",
  version: "1.0.0",
  instrument: "sdq25_s",
  instrumentVersion: "1.0",
  steps: [
    { op: "reverse", items: q([7, 11, 14, 21, 25]), maxPlusMin: 2 },
    { op: "sum", items: q([3, 8, 13, 16, 24]), output: "emotional", minValid: 3, prorate: true },
    { op: "sum", items: q([5, 7, 12, 18, 22]), output: "conduct", minValid: 3, prorate: true },
    { op: "sum", items: q([2, 10, 15, 21, 25]), output: "hyperactivity", minValid: 3, prorate: true },
    { op: "sum", items: q([6, 11, 14, 19, 23]), output: "peer", minValid: 3, prorate: true },
    { op: "sum", items: q([1, 4, 9, 17, 20]), output: "prosocial", minValid: 3, prorate: true },
    { op: "sum", items: ["emotional", "conduct", "hyperactivity", "peer"], output: "total_difficulties", minValid: 4 },
  ],
  provenance:
    "Standard youthinmind SDQ scoring (0-2 coding, reverse items 7/11/14/21/25, subscale proration >=3 items, total difficulties excludes prosocial). Verify against the youthinmind scoring sheet before approval.",
  verified: false,
};

/** RCADS-25: canonical 0-3 codes; plain subscale + total sums (T-score norms
 * are a later, versioned addition once the official tables are filed). */
export const scoreRcads25: ScoringInput = {
  key: "score.rcads25",
  version: "1.0.0",
  instrument: "rcads25",
  instrumentVersion: "1.0",
  steps: [
    { op: "sum", items: q([1, 4, 8, 10, 13, 15, 16, 18, 19, 21]), output: "depression", minValid: 10 },
    { op: "sum", items: q([2, 3, 5, 6, 7, 9, 11, 12, 14, 17, 20, 22, 23, 24, 25]), output: "anxiety", minValid: 15 },
    { op: "sum", items: ["depression", "anxiety"], output: "total", minValid: 2 },
  ],
  provenance:
    "Ebesutani et al. (2012) RCADS-25 raw-score structure. Item-to-subscale allocation and official missing-data/T-score rules to be verified against rcads.ucla.edu materials before approval.",
  verified: false,
};

/** SWEMWBS: raw sum 7-35. The published raw->metric conversion table must be
 * transcribed from the licensed Warwick scoring documentation — deliberately
 * NOT reproduced from memory here (no invented constants). */
export const scoreSwemwbs: ScoringInput = {
  key: "score.swemwbs",
  version: "1.0.0",
  instrument: "swemwbs",
  instrumentVersion: "1.0",
  steps: [{ op: "sum", items: q([1, 2, 3, 4, 5, 6, 7]), output: "raw_total", minValid: 7 }],
  provenance:
    "SWEMWBS raw total (all 7 items required, per standard guidance). The metric-conversion lookup step is intentionally absent until the licensed conversion table is filed and transcribed (then added as version 1.1.0).",
  verified: false,
};

/** STAI-5 state: plain sum of the 5 items (all anxiety-present phrasing). */
export const scoreStai5: ScoringInput = {
  key: "score.stai5",
  version: "1.0.0",
  instrument: "stai5_s",
  instrumentVersion: "1.0",
  steps: [{ op: "sum", items: q([1, 2, 3, 4, 5]), output: "state_anxiety", minValid: 5 }],
  provenance: "Zsido et al. (2020) STAI-5: sum of five 1-4 items. Verify no reverse-scored items against the publication before approval.",
  verified: false,
};

/** BIS/BAS 12-item YBM subset: subscale sums in the administered coding
 * (1 = very true .. 4 = very false). Direction handling per Carver & White is
 * deliberately deferred to verification — the administered subset's scoring
 * convention (whether to reverse so higher = more of trait) must be fixed
 * against the source study before approval. */
export const scoreBisbas12: ScoringInput = {
  key: "score.bisbas12_ybm",
  version: "1.0.0",
  instrument: "bisbas12_ybm",
  instrumentVersion: "1.0",
  steps: [
    { op: "sum", items: ["bis1", "bis2", "bis3", "bis4"], output: "bis_raw", minValid: 4 },
    { op: "sum", items: ["rr1", "rr2", "rr3", "rr4"], output: "bas_reward_raw", minValid: 4 },
    { op: "sum", items: ["dr1", "dr2", "dr3", "dr4"], output: "bas_drive_raw", minValid: 4 },
  ],
  provenance:
    "Raw sums in administered coding (1=very true .. 4=very false); outputs suffixed _raw to signal direction is NOT yet normalised. Carver & White (1994) reverse-scoring convention for this subset to be verified before approval (A-22).",
  verified: false,
};

/** EHI-SF: item recode to -100..100 (canonical right-first anchors), mean LQ,
 * Veale (2014) classification bands pending verification. */
export const scoreEhiSf: ScoringInput = {
  key: "score.ehi_sf",
  version: "1.0.0",
  instrument: "ehi_sf",
  instrumentVersion: "1.0",
  steps: [
    {
      op: "recode",
      items: ["writing", "throwing", "toothbrush", "spoon"],
      map: { "1": 100, "2": 50, "3": 0, "4": -50, "5": -100 },
    },
    { op: "mean", items: ["writing", "throwing", "toothbrush", "spoon"], output: "lq", minValid: 4 },
    {
      // Veale (2014) reports left-handed ≤ -60, right-handed ≥ +60, mixed in
      // between. The wording here is what a participant reads back, so it is
      // plain rather than clinical (D-33).
      op: "classify",
      input: "lq",
      bands: [
        { label: "strongly left-handed", min: -100, max: -90 },
        { label: "left-handed", min: -89.999, max: -60 },
        { label: "mixed-handed, leaning left", min: -59.999, max: -20 },
        { label: "mixed-handed", min: -19.999, max: 19.999 },
        { label: "mixed-handed, leaning right", min: 20, max: 59.999 },
        { label: "right-handed", min: 60, max: 89.999 },
        { label: "strongly right-handed", min: 90, max: 100 },
      ],
      output: "lq_band",
    },
  ],
  provenance:
    "EHI-SF laterality quotient as the mean of items scored 100..-100 (canonical right-first anchors; positive = right-handed). Band labels follow Veale (2014) cutoffs (left ≤ -60, right ≥ +60) with the mixed range split for participant-facing wording only — the cutoffs themselves are unchanged and lq is the analysed variable (D-33).",
  verified: false,
};

export const allScoring: ScoringInput[] = [
  scoreSdq25S,
  scoreRcads25,
  scoreSwemwbs,
  scoreStai5,
  scoreBisbas12,
  scoreEhiSf,
];
