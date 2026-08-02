import type { ItemRef, ResponseStatus } from "@myself/schema";

/**
 * The engine's view of a session's answers. Values are the *current* state
 * materialised from append-only events; the engine never mutates history.
 */

export type AnswerValue =
  | { kind: "choice"; code: number }
  | { kind: "multi"; codes: number[] }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "date"; iso: string }
  | { kind: "fields"; values: Record<string, string> }
  | {
      kind: "group_rank";
      /** option code -> { group key, rank within group (1-based) if ranked } */
      assignments: Record<number, { group: string; rank?: number }>;
    }
  | { kind: "checkboxes"; checked: string[] };

export interface AnswerRecord {
  status: ResponseStatus;
  value?: AnswerValue;
}

export const refKey = (ref: ItemRef): string => `${ref.instrument}.${ref.item}`;

export class AnswerStore {
  private readonly answers = new Map<string, AnswerRecord>();

  set(ref: ItemRef, record: AnswerRecord): void {
    this.answers.set(refKey(ref), record);
  }

  get(ref: ItemRef): AnswerRecord | undefined {
    return this.answers.get(refKey(ref));
  }

  isAnswered(ref: ItemRef): boolean {
    return this.get(ref)?.status === "answered";
  }
}
