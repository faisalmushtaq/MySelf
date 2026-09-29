import type { ItemDefinition, LogicExpr } from "@myself/schema";
import type { AnswerStore } from "./answers.js";
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

export interface WalkPosition {
  index: number; // index into units[] of the currently presented unit
}

export class Walker {
  constructor(
    private readonly units: PresentableUnit[],
    private readonly store: AnswerStore,
    private readonly allowBack: boolean,
    /** When the sitting started: what age conditions are judged against (D-51). */
    private readonly sessionStart?: Date,
  ) {}

  isVisible(index: number): boolean {
    const unit = this.units[index];
    if (!unit) return false;
    return unit.displayIf === undefined || evaluate(unit.displayIf, this.store, this.sessionStart);
  }

  /** All currently-visible units, in order (for progress computation). */
  visibleUnits(): number[] {
    return this.units.map((_, i) => i).filter((i) => this.isVisible(i));
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
