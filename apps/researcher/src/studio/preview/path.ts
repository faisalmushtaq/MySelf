import { Walker, type AnswerStore, type AnswerValue, type PresentableUnit } from "@myself/engine";
import type { LogicExpr, ResponseScale } from "@myself/schema";
import { START_FINISH, START_REVIEW, type StartAt, type StateMessage, type Visibility } from "./protocol.js";

/**
 * The path through a survey, as the preview reports it — docs/16 §5.6.
 *
 * Pure, and shared by both sides of the frame boundary: the frame works out
 * visibility from its answer store with the participant engine's own Walker,
 * and the Studio turns that report into the rows of its path panel. Nothing
 * here re-implements a condition. "Hidden" means exactly what it means on a
 * participant's iPad, because it is the same `evaluate` deciding it.
 */

/** A unit's stable key: `<instrument>.<item key>`, the same key the answer store uses. */
export const unitKeyOf = (unit: PresentableUnit): string => `${unit.instrument}.${unit.item.key}`;

/**
 * Per unit: hidden when its conditions are not met by the answers so far;
 * otherwise shown if it has been on screen in this run, or not reached.
 *
 * "Hidden" is judged now, for every unit, including ones further on. A
 * condition on a question not yet answered is not met — the engine treats an
 * unanswered target as false — so a branch that depends on a later answer
 * reads as hidden until that answer is given. The path panel says which
 * answers a hidden unit is waiting on, so that is visible rather than
 * surprising.
 */
export function computeVisibility(
  units: PresentableUnit[],
  store: AnswerStore,
  visited: ReadonlySet<string>,
  /** When the sitting started: what age conditions are judged against (D-51). */
  sessionStart?: Date,
): Record<string, Visibility> {
  const walker = new Walker(units, store, true, sessionStart);
  const out: Record<string, Visibility> = {};
  units.forEach((unit, i) => {
    const key = unitKeyOf(unit);
    out[key] = !walker.isVisible(i) ? "hidden" : visited.has(key) ? "shown" : "not_reached";
  });
  return out;
}

/** Longest answer the panel shows before shortening. */
export const ANSWER_CHARS = 60;

export function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Every answer in the store, as the participant's own review screen would read
 * it back, shortened for a panel row. Skips and declines use the words the
 * participant saw, so the panel never invents its own vocabulary for them.
 */
export function answerSummaries(
  units: PresentableUnit[],
  store: AnswerStore,
  scales: Map<string, ResponseScale>,
  describe: (value: AnswerValue | undefined, scale: ResponseScale | undefined) => string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const unit of units) {
    const item = unit.item;
    const record = store.get({ instrument: unit.instrument, item: item.key, revision: item.revision });
    if (!record) continue;
    const key = unitKeyOf(unit);
    if (record.status === "answered") {
      const scale = "scale" in item ? scales.get(item.scale) : undefined;
      out[key] = shorten(describe(record.value, scale) ?? "Answered, left empty", ANSWER_CHARS);
    } else if (record.status === "skipped") {
      out[key] = "Left blank";
    } else if (record.status === "declined") {
      out[key] = "Prefer not to say";
    }
  }
  return out;
}

/** The question keys a condition reads, in the order it mentions them, once each. */
export function conditionTargets(expr: LogicExpr | undefined): string[] {
  const seen = new Set<string>();
  const walk = (e: LogicExpr) => {
    switch (e.op) {
      case "all":
      case "any":
        e.args.forEach(walk);
        return;
      case "not":
        walk(e.arg);
        return;
      default:
        seen.add(`${e.target.item.instrument}.${e.target.item.item}`);
    }
  };
  if (expr) walk(expr);
  return [...seen];
}

export type PathState = "current" | "answered" | "shown" | "hidden" | "not_reached";

export interface PathEntry {
  index: number;
  itemKey: string;
  sectionKey: string;
  state: PathState;
  /** The answer, as read back; kept when the question is now hidden. */
  answer: string | null;
  /** Hidden rows only: the answers the condition reads, and what they are now. */
  drivers: { itemKey: string; answer: string | null }[];
}

/**
 * The path panel's rows, from the frame's last report.
 *
 * Before the first report (the frame is still loading) nothing has happened,
 * so everything is "not reached" rather than guessed at.
 */
export function pathEntries(units: PresentableUnit[], state: StateMessage | null): PathEntry[] {
  return units.map((unit, index) => {
    const itemKey = unitKeyOf(unit);
    const answer = state?.answers[itemKey] ?? null;
    const visibility = state?.visibility[itemKey] ?? "not_reached";
    const isCurrent = state?.phase === "running" && state.index === index;
    const stateOf: PathState = isCurrent
      ? "current"
      : visibility === "hidden"
        ? "hidden"
        : answer !== null
          ? "answered"
          : visibility === "shown"
            ? "shown"
            : "not_reached";
    const drivers =
      visibility === "hidden"
        ? conditionTargets(unit.displayIf).map((key) => ({ itemKey: key, answer: state?.answers[key] ?? null }))
        : [];
    return { index, itemKey, sectionKey: unit.sectionKey, state: stateOf, answer, drivers };
  });
}

export type StartPoint =
  | { kind: "start" }
  | { kind: "running"; index: number }
  | { kind: "finished" }
  | { kind: "review" };

/**
 * Where a load begins. An item key the release does not have — deleted in the
 * editor since the choice was made — falls back to the start screen rather
 * than to some other question the researcher did not ask for.
 */
export function resolveStart(units: PresentableUnit[], startAt: StartAt, hasReview: boolean): StartPoint {
  if (startAt === null || startAt === "") return { kind: "start" };
  if (startAt === START_FINISH) return { kind: "finished" };
  if (startAt === START_REVIEW) return hasReview ? { kind: "review" } : { kind: "finished" };
  const index = units.findIndex((u) => unitKeyOf(u) === startAt);
  return index < 0 ? { kind: "start" } : { kind: "running", index };
}

/**
 * Where to pick the run up after the draft changed under it: the screen the
 * frame last reported, so a researcher editing the wording of the question in
 * front of them stays on it.
 *
 * `undefined` means "not known" (no report yet, an error, or a question the
 * new draft no longer has), and the caller starts from the chosen starting
 * point instead. The start screen is a place like any other and answers `null`
 * — it used to fall through to the chosen starting point, so a researcher
 * handed back to the start screen was moved to the "Start from…" question by
 * an unrelated edit.
 */
export function restartPoint(state: StateMessage | null, unitKeys: ReadonlySet<string>): StartAt | undefined {
  if (state === null) return undefined;
  switch (state.phase) {
    case "finished":
      return START_FINISH;
    case "review":
      return START_REVIEW;
    case "start":
      return null;
    case "error":
      return undefined;
    default:
      // running, and the check-in and pace screens, which report the question they lead to.
      return state.itemKey && unitKeys.has(state.itemKey) ? state.itemKey : undefined;
  }
}

/**
 * A problem line split into the field it is about and what is wrong, when it
 * leads with a field path ("composition.sections.0.key: Required"). A plain
 * sentence that happens to contain a colon — flatten's "manifest
 * inconsistency: …", a gate refusal — is not a path, and is left whole.
 */
export function problemParts(line: string): { path: string | null; message: string } {
  const at = line.indexOf(": ");
  const path = at > 0 ? line.slice(0, at) : "";
  return path && !/\s/.test(path) ? { path, message: line.slice(at + 2) } : { path: null, message: line };
}

/** Consecutive runs of units in one section, in order — how both the path and "Start from…" group. */
export function sectionRuns(
  units: PresentableUnit[],
  sectionTitles: Map<string, string>,
): { sectionKey: string; title: string; indices: number[] }[] {
  const runs: { sectionKey: string; title: string; indices: number[] }[] = [];
  units.forEach((unit, index) => {
    const last = runs[runs.length - 1];
    if (last && last.sectionKey === unit.sectionKey) last.indices.push(index);
    else runs.push({ sectionKey: unit.sectionKey, title: sectionTitles.get(unit.sectionKey) ?? unit.sectionKey, indices: [index] });
  });
  return runs;
}

/**
 * A unit as a researcher would recognise it in a list: its question, or for
 * the screens flattening adds, what the screen is.
 */
export function unitLabel(unit: PresentableUnit, instrumentNames: Map<string, string>, max = 90): string {
  const key = unit.item.key;
  if (unit.narrative) return "Story conversation (MyStory)";
  if (key.startsWith("__instructions_")) {
    return `Instructions: ${instrumentNames.get(unit.instrument) ?? unit.instrument}`;
  }
  const stem = unit.item.stem.text.trim();
  return stem ? shorten(stem, max) : `Untitled question (${unitKeyOf(unit)})`;
}
