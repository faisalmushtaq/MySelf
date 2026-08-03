import { summariseNumbers, type NumericSummary } from "@myself/store";
import type { Row } from "./filter.js";

/**
 * Following people, not sittings.
 *
 * The wide table has one row per sitting, which is the right shape for
 * screening and the wrong shape for the question the study is actually asking.
 * These turn it back into people: what one person's waves look like, and how a
 * measure moves across waves for everyone who has more than one.
 *
 * The wave-by-wave means below are deliberately computed over the *returning*
 * sample only. Comparing wave 2 against everyone who ever did a wave 1 mixes
 * change with attrition, and the two are not separable after the fact.
 */

export interface WaveSummary {
  wave: number;
  n: number;
  summary: NumericSummary;
}

export function participantWaves(rows: Row[], participantId: string): Row[] {
  return rows
    .filter((r) => r["participant_id"] === participantId)
    .sort((a, b) => Number(a["wave"] ?? 0) - Number(b["wave"] ?? 0));
}

/** Everyone with more than one sitting in the rows given. */
export function returningIds(rows: Row[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = String(r["participant_id"] ?? "");
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();
}

/** Wave-by-wave distribution of one numeric column, returners only. */
export function byWave(rows: Row[], key: string): WaveSummary[] {
  const returning = new Set(returningIds(rows));
  const waves = new Map<number, number[]>();
  for (const r of rows) {
    if (!returning.has(String(r["participant_id"] ?? ""))) continue;
    const value = r[key];
    if (typeof value !== "number") continue;
    const wave = Number(r["wave"] ?? 0);
    const list = waves.get(wave);
    if (list) list.push(value);
    else waves.set(wave, [value]);
  }
  return [...waves.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wave, values]) => ({ wave, n: values.length, summary: summariseNumbers(values) }));
}

/** Individual change on one measure between a person's first and last wave. */
export function individualChange(rows: Row[], key: string): { participantId: string; from: number; to: number; change: number }[] {
  const out: { participantId: string; from: number; to: number; change: number }[] = [];
  for (const id of returningIds(rows)) {
    const waves = participantWaves(rows, id).filter((r) => typeof r[key] === "number");
    const first = waves[0];
    const last = waves[waves.length - 1];
    if (!first || !last || first === last) continue;
    const from = first[key] as number;
    const to = last[key] as number;
    out.push({ participantId: id, from, to, change: to - from });
  }
  return out.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}
