import type { ItemDefinition, ItemRef, LogicExpr } from "@myself/schema";
import { refKey, type AnswerLookup, type AnswerStore } from "./answers.js";
import { evaluate } from "./evaluate.js";

/**
 * Presentation walker: given a flattened, ordered list of presentable units
 * (built once from a release manifest), decide what is visible for the
 * current answer state and where "next" and "back" land.
 *
 * Pure and deterministic: identical results on device and server, and
 * re-runnable against recorded events for regression testing.
 */

export interface PresentableUnit {
  /** Stable identity for paradata: instrument key + item key + revision. */
  instrument: string;
  item: ItemDefinition;
  sectionKey: string;
  /** Conjunction of section-, component- and item-level display conditions. */
  displayIf?: LogicExpr | undefined;
  /**
   * Set when this position is a narrative module (MyStory) rather than a
   * question. The unit still carries an item, so display conditions, ordering,
   * back navigation and timing all work the way they do everywhere else — the
   * only thing that differs is what gets drawn when the walker arrives here.
   *
   * The item is a marker, never a response slot: nothing the module produces
   * can populate an answer, which is what keeps "a model cannot fabricate a
   * participant's response" structural rather than a matter of care.
   */
  narrative?: { protocol: string; version: string };
}

/** What deciding visibility needs of a unit: which item it is, and when it shows. */
export type VisibilityUnit = Pick<PresentableUnit, "instrument" | "displayIf"> & { item: Pick<ItemDefinition, "key"> };

export interface Visibility {
  /** Per unit, in order: whether it is shown for this answer state. */
  visible: boolean[];
  /**
   * "<instrument>.<item>" of every item that no visible unit shows. Whatever
   * the store holds for these is stale — given before an earlier answer
   * changed — and counts as absent everywhere downstream.
   */
  hidden: Set<string>;
}

/**
 * Which units are shown for an answer state, in one ordered pass.
 *
 * CASCADING. Each condition is evaluated against the answers with every
 * hidden unit's answer taken out, so hiding a question also hides whatever
 * depended on it, and so on down the chain. Without this, a participant who
 * said Yes to "do you speak another language?", ticked Polish, then went back
 * and said No was still asked about their Polish, because the tick was still
 * in the store.
 *
 * One pass in administered order is enough because the publish gate refuses a
 * condition on anything asked later (the dependency audit). A condition on an
 * item that is not a unit here — or, in a release older than that rule, on a
 * later one — reads the store as it is.
 *
 * The device, the Studio preview and ingest all decide visibility here, so a
 * question is shown, reviewed, counted and exported by the same rule.
 */
export function computeVisibility(units: readonly VisibilityUnit[], store: AnswerLookup, asOf?: Date): Visibility {
  const shown = new Set<string>();
  const hidden = new Set<string>();
  // An item placed more than once counts as shown if any placement is.
  const masked = (ref: ItemRef) => {
    const key = refKey(ref);
    return hidden.has(key) && !shown.has(key);
  };
  const view: AnswerLookup = {
    get: (ref) => (masked(ref) ? undefined : store.get(ref)),
    isAnswered: (ref) => !masked(ref) && store.isAnswered(ref),
  };
  const visible = units.map((unit) => {
    const on = unit.displayIf === undefined || evaluate(unit.displayIf, view, asOf);
    (on ? shown : hidden).add(`${unit.instrument}.${unit.item.key}`);
    return on;
  });
  for (const key of shown) hidden.delete(key);
  return { visible, hidden };
}

export interface WalkPosition {
  index: number; // index into units[] of the currently presented unit
}

interface WalkState {
  version: number;
  visibility: Visibility;
  answers?: AnswerStore;
}

export class Walker {
  /**
   * Visibility for one answer state. The store is mutated in place, so this is
   * keyed on its version and recomputed only after a write: one pass over the
   * units per answer, however often next, back and progress ask.
   */
  private state: WalkState | undefined;

  constructor(
    private readonly units: PresentableUnit[],
    private readonly store: AnswerStore,
    private readonly allowBack: boolean,
    /** When the sitting started: what age conditions are judged against (D-51). */
    private readonly sessionStart?: Date,
  ) {}

  private current(): WalkState {
    const version = this.store.version;
    if (this.state?.version !== version) {
      this.state = { version, visibility: computeVisibility(this.units, this.store, this.sessionStart) };
    }
    return this.state;
  }

  isVisible(index: number): boolean {
    return this.current().visibility.visible[index] === true;
  }

  /** All currently-visible units, in order (for progress computation). */
  visibleUnits(): number[] {
    const { visible } = this.current().visibility;
    return this.units.map((_, i) => i).filter((i) => visible[i]);
  }

  /**
   * The answers as the visible survey stands: the store without answers to
   * hidden questions. What pipes, cross-checks and option limits read, so a
   * stale answer can no more surface in a sentence than it can open a branch.
   */
  visibleAnswers(): AnswerStore {
    const state = this.current();
    state.answers ??= this.store.without(state.visibility.hidden);
    return state.answers;
  }

  /** First visible unit, or null for an empty assessment. */
  first(): number | null {
    for (let i = 0; i < this.units.length; i++) if (this.isVisible(i)) return i;
    return null;
  }

  /** Next visible unit after `from`, or null when the assessment ends. */
  next(from: number): number | null {
    for (let i = from + 1; i < this.units.length; i++) if (this.isVisible(i)) return i;
    return null;
  }

  /** Previous visible unit, or null (start reached or back disabled). */
  back(from: number): number | null {
    if (!this.allowBack) return null;
    for (let i = from - 1; i >= 0; i--) if (this.isVisible(i)) return i;
    return null;
  }

  /**
   * Section-based progress (docs/04: segments, not misleading percentages).
   * Returns the ordered list of section keys currently reachable and the
   * position of the active one.
   */
  sectionProgress(current: number): { sections: string[]; activeIndex: number } {
    const seen: string[] = [];
    let activeIndex = 0;
    for (const i of this.visibleUnits()) {
      const key = this.units[i]!.sectionKey;
      if (seen[seen.length - 1] !== key) seen.push(key);
      if (i === current) activeIndex = seen.length - 1;
    }
    return { sections: seen, activeIndex };
  }
}
