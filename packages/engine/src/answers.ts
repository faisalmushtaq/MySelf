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
  | { kind: "checkboxes"; checked: string[] }
  | {
      kind: "time_grid";
      /** option code -> total minutes; null for a row shown but left empty */
      minutes: Record<string, number | null>;
    };

export interface AnswerRecord {
  status: ResponseStatus;
  value?: AnswerValue;
}

export const refKey = (ref: ItemRef): string => `${ref.instrument}.${ref.item}`;

/**
 * Read-only access to answers: what display logic, cross-checks and pipes
 * need. An AnswerStore is one; so is the masked view the walker evaluates
 * against, in which answers to hidden questions are absent.
 */
export interface AnswerLookup {
  get(ref: ItemRef): AnswerRecord | undefined;
  isAnswered(ref: ItemRef): boolean;
}

export class AnswerStore implements AnswerLookup {
  private readonly answers = new Map<string, AnswerRecord>();
  private writes = 0;

  set(ref: ItemRef, record: AnswerRecord): void {
    this.answers.set(refKey(ref), record);
    this.writes += 1;
  }

  /**
   * Changes on every write. The store is mutated in place on the device, so
   * this is how a reader holding a derived view (the walker's visibility)
   * knows it is out of date.
   */
  get version(): number {
    return this.writes;
  }

  /** A copy without the answers to the given items ("<instrument>.<item>"). */
  without(keys: ReadonlySet<string>): AnswerStore {
    const copy = new AnswerStore();
    for (const [key, record] of this.answers) if (!keys.has(key)) copy.answers.set(key, record);
    return copy;
  }

  get(ref: ItemRef): AnswerRecord | undefined {
    return this.answers.get(refKey(ref));
  }

  isAnswered(ref: ItemRef): boolean {
    return this.get(ref)?.status === "answered";
  }
}
