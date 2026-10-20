import { timeGridRows, type AnswerLookup, type PresentableUnit, type TimeGridRow } from "@myself/engine";
import type { ItemDefinition, ResponseScale } from "@myself/schema";

/**
 * A time grid's rows for this sitting, and the option list they are named
 * from: the source question as the walk places it, its scale, and the answer
 * the visible survey holds for it. The survey screen draws these rows and the
 * review reads the answer back with them, so both name the same apps.
 */
export function gridRowsFor(
  item: ItemDefinition,
  units: readonly PresentableUnit[],
  scales: ReadonlyMap<string, ResponseScale>,
  answers: AnswerLookup,
): { rows: TimeGridRow[]; scale: ResponseScale | undefined } {
  if (item.responseType !== "time_grid") return { rows: [], scale: undefined };
  const from = item.rowsFrom;
  const source = units.find((u) => u.instrument === from.instrument && u.item.key === from.item && !u.narrative)?.item;
  const scale = source && "scale" in source ? scales.get(source.scale) : undefined;
  if (!source || !scale) return { rows: [], scale };
  const record = answers.get(from);
  const answer = record?.status === "answered" ? record.value : undefined;
  return { rows: timeGridRows(from, source, scale.options, answer), scale };
}
