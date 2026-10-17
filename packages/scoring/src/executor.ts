import type { ScoringDefinition } from "@myself/schema";

/**
 * Declarative scoring executor. Consumes CANONICAL item codes (never legacy),
 * never mutates its input, and returns derived outputs separately — raw
 * responses are never overwritten (design principle; docs/06 §4).
 *
 * Missing handling: null = not available (any non-answered status). Sums and
 * means require `minValid` non-missing inputs; `prorate` scales a qualifying
 * partial sum to the full item count (rounded to nearest integer), which is
 * the standard SDQ-style proration rule.
 */

export type ItemValues = Record<string, number | null>;

export interface ScoringResult {
  outputs: Record<string, number | string | null>;
  /** Per-output count of non-missing contributing items (audit aid). */
  validCounts: Record<string, number>;
  warnings: string[];
}

export interface ScoringOptions {
  /**
   * Item key -> the codes its scale offers. A value that is not one of them is
   * scored as missing, with a warning: an SDQ item recorded as 7 is not a
   * very high 2, it is a value nobody could have chosen, and adding it in
   * would put a number on a subscale that the instrument cannot produce. The
   * stored response is untouched — only the score reads it as missing.
   * Items not listed here are taken as they come.
   */
  codes?: Record<string, readonly number[]>;
}

export function executeScoring(def: ScoringDefinition, input: ItemValues, options: ScoringOptions = {}): ScoringResult {
  const working: ItemValues = { ...input };
  const outputs: Record<string, number | string | null> = {};
  const validCounts: Record<string, number> = {};
  const warnings: string[] = [];

  for (const [item, codes] of Object.entries(options.codes ?? {})) {
    const v = working[item];
    if (v === null || v === undefined || codes.includes(v)) continue;
    warnings.push(`value ${v} for '${item}' is not a code of its scale; scored as missing`);
    working[item] = null;
  }

  const read = (key: string): number | null => {
    if (key in working) return working[key] ?? null;
    const out = outputs[key];
    return typeof out === "number" ? out : null;
  };

  for (const step of def.steps) {
    switch (step.op) {
      case "recode": {
        for (const item of step.items) {
          const v = working[item];
          if (v === null || v === undefined) continue;
          const mapped = step.map[String(v)];
          if (mapped === undefined) {
            warnings.push(`recode: value ${v} for '${item}' not in map; set to null`);
            working[item] = null;
          } else {
            working[item] = mapped;
          }
        }
        break;
      }
      case "reverse": {
        for (const item of step.items) {
          const v = working[item];
          if (v !== null && v !== undefined) working[item] = step.maxPlusMin - v;
        }
        break;
      }
      case "sum": {
        const values = step.items.map(read).filter((v): v is number => v !== null);
        validCounts[step.output] = values.length;
        if (values.length < step.minValid) {
          outputs[step.output] = null;
          warnings.push(`sum '${step.output}': ${values.length} valid < minValid ${step.minValid}`);
        } else if (step.prorate && values.length < step.items.length) {
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          outputs[step.output] = Math.round(mean * step.items.length);
        } else if (values.length < step.items.length) {
          outputs[step.output] = null;
          warnings.push(`sum '${step.output}': incomplete without proration`);
        } else {
          outputs[step.output] = values.reduce((a, b) => a + b, 0);
        }
        break;
      }
      case "mean": {
        const values = step.items.map(read).filter((v): v is number => v !== null);
        validCounts[step.output] = values.length;
        outputs[step.output] =
          values.length >= step.minValid ? values.reduce((a, b) => a + b, 0) / values.length : null;
        if (values.length < step.minValid)
          warnings.push(`mean '${step.output}': ${values.length} valid < minValid ${step.minValid}`);
        break;
      }
      case "lookup": {
        const v = read(step.input);
        if (v === null) {
          outputs[step.output] = null;
        } else {
          const mapped = step.table[String(v)];
          if (mapped === undefined) {
            outputs[step.output] = null;
            warnings.push(`lookup '${step.output}': value ${v} not in table`);
          } else {
            outputs[step.output] = mapped;
          }
        }
        break;
      }
      case "classify": {
        const v = read(step.input);
        if (v === null) {
          outputs[step.output] = null;
        } else {
          const band = step.bands.find((b) => v >= b.min && v <= b.max);
          if (!band) {
            outputs[step.output] = null;
            warnings.push(`classify '${step.output}': value ${v} outside all bands`);
          } else {
            outputs[step.output] = band.label;
          }
        }
        break;
      }
    }
  }

  return { outputs, validCounts, warnings };
}
