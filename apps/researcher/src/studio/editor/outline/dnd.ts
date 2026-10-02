import { moveBlock, moveQuestion, moveSection, shortText, type Outline, type OutlineSection, type StudioDraft } from "@myself/studio";
import { questionName } from "./model.js";

/**
 * Where a drag, or Alt+Arrow, puts something — as the operation that does it.
 *
 * Pure, so the arithmetic that is easy to get wrong by one is tested rather
 * than tried: `moveQuestion` counts positions among the section's questions
 * WITHOUT the one moving, `moveBlock` counts components after the block has
 * been taken out, and `moveSection` names the index it ends at. A drop in the
 * place something already is gives no operation at all, rather than an undo
 * step that changes nothing.
 *
 * The operations themselves still decide. A plan that the model will refuse
 * (the middle of a licensed questionnaire) says so in `refusal`, so the drop
 * indicator can show it before anything is dropped; dropping anyway runs the
 * operation, which gives its own reason.
 */

export type DragItem =
  | { kind: "question"; itemKey: string }
  | { kind: "block"; sectionKey: string; componentIndex: number }
  | { kind: "section"; sectionKey: string };

/** What the pointer is over, and on which side of it. */
export type HoverTarget =
  | { kind: "question"; itemKey: string; edge: "before" | "after" }
  | { kind: "block"; sectionKey: string; componentIndex: number; edge: "before" | "after" }
  /** A section header: `inside` is "into this section, at the end". */
  | { kind: "section"; sectionKey: string; edge: "before" | "after" | "inside" }
  /** An "Add question" row: the end of its section, or of its block. */
  | { kind: "add"; sectionKey: string; componentIndex: number | null }
  | { kind: "start" }
  | { kind: "end" };

export type MoveOp =
  | { op: "question"; itemKey: string; to: { sectionKey: string; index: number } }
  | { op: "block"; from: { sectionKey: string; componentIndex: number }; to: { sectionKey: string; index: number } }
  | { op: "section"; sectionKey: string; toIndex: number };

/** Carry out a planned move with the model's own operation (which may refuse it with a StudioOpError). */
export function applyMove(d: StudioDraft, move: MoveOp): StudioDraft {
  switch (move.op) {
    case "question":
      return moveQuestion(d, move.itemKey, move.to).draft;
    case "block":
      return moveBlock(d, move.from, move.to).draft;
    case "section":
      return moveSection(d, move.sectionKey, move.toIndex).draft;
  }
}

export interface DropPlan {
  /** Null when the drop leaves everything where it is. */
  move: MoveOp | null;
  /** Why the model will refuse this, when that is knowable in advance. */
  refusal: string | null;
}

/** `components[i]`: how many components section i has (screens included), for block indices. */
export type ComponentCounts = readonly number[];

interface SeqEntry {
  itemKey: string;
  instrument: string;
  componentIndex: number;
  blockName: string;
}

function seqOf(section: OutlineSection): SeqEntry[] {
  return section.blocks.flatMap((b) =>
    b.questions.map((q) => ({ itemKey: q.itemKey, instrument: q.instrument, componentIndex: b.componentIndex, blockName: b.name })),
  );
}

function sectionByKey(o: Outline, key: string): OutlineSection | undefined {
  return o.sections.find((s) => s.key === key);
}

function locate(o: Outline, itemKey: string): { section: OutlineSection; seq: SeqEntry[]; index: number } | null {
  for (const section of o.sections) {
    const seq = seqOf(section);
    const index = seq.findIndex((e) => e.itemKey === itemKey);
    if (index >= 0) return { section, seq, index };
  }
  return null;
}

/** Position of a block's first question in its section's sequence, and one past its last. */
function blockSpan(seq: SeqEntry[], componentIndex: number, section: OutlineSection): { start: number; end: number } {
  const start = seq.findIndex((e) => e.componentIndex === componentIndex);
  if (start >= 0) {
    let end = start;
    while (end < seq.length && seq[end]!.componentIndex === componentIndex) end++;
    return { start, end };
  }
  // A block with no questions shown (its form is missing): where it would start.
  const before = section.blocks.filter((b) => b.componentIndex < componentIndex).reduce((n, b) => n + b.questions.length, 0);
  return { start: before, end: before };
}

/**
 * The refusal `moveQuestion` would give for landing at `index` among `without`:
 * between two questions of the same block that is not the question's own.
 */
function middleOfBlock(without: SeqEntry[], index: number, instrument: string): SeqEntry | null {
  const prev = without[index - 1];
  const next = without[index];
  if (prev && next && prev.componentIndex === next.componentIndex && prev.instrument !== instrument) return prev;
  return null;
}

function middleRefusal(text: string, block: SeqEntry): string {
  return `“${questionName(text, 50)}” can’t go in the middle of “${block.blockName}”: a question stays with its own block. Drop it before or after the block.`;
}

function questionText(o: Outline, itemKey: string): string {
  for (const s of o.sections) for (const b of s.blocks) for (const q of b.questions) if (q.itemKey === itemKey) return q.text;
  return itemKey;
}

// ---------------------------------------------------------------------------
// Dragging
// ---------------------------------------------------------------------------

export function planDrop(o: Outline, counts: ComponentCounts, drag: DragItem, over: HoverTarget): DropPlan | null {
  switch (drag.kind) {
    case "question":
      return planQuestion(o, drag.itemKey, over);
    case "block":
      return planBlock(o, counts, drag, over);
    case "section":
      return planSection(o, drag.sectionKey, over);
  }
}

function planQuestion(o: Outline, itemKey: string, over: HoverTarget): DropPlan | null {
  const from = locate(o, itemKey);
  if (!from) return null;
  const moving = from.seq[from.index]!;
  let target: OutlineSection | undefined;
  let gap: number;
  switch (over.kind) {
    case "question": {
      const at = locate(o, over.itemKey);
      if (!at) return null;
      target = at.section;
      gap = over.edge === "before" ? at.index : at.index + 1;
      break;
    }
    case "block": {
      target = sectionByKey(o, over.sectionKey);
      if (!target) return null;
      const span = blockSpan(seqOf(target), over.componentIndex, target);
      gap = over.edge === "before" ? span.start : span.end;
      break;
    }
    case "section":
      target = sectionByKey(o, over.sectionKey);
      if (!target) return null;
      gap = seqOf(target).length;
      break;
    case "add": {
      target = sectionByKey(o, over.sectionKey);
      if (!target) return null;
      const seq = seqOf(target);
      gap = over.componentIndex === null ? seq.length : blockSpan(seq, over.componentIndex, target).end;
      break;
    }
    default:
      return null;
  }
  const same = target.key === from.section.key;
  if (same && (gap === from.index || gap === from.index + 1)) return { move: null, refusal: null };
  const index = same && gap > from.index ? gap - 1 : gap;
  const without = seqOf(target).filter((e) => e.itemKey !== itemKey);
  const middle = middleOfBlock(without, index, moving.instrument);
  return {
    move: { op: "question", itemKey, to: { sectionKey: target.key, index } },
    refusal: middle ? middleRefusal(questionText(o, itemKey), middle) : null,
  };
}

function planBlock(
  o: Outline,
  counts: ComponentCounts,
  drag: { sectionKey: string; componentIndex: number },
  over: HoverTarget,
): DropPlan | null {
  const source = sectionByKey(o, drag.sectionKey);
  if (!source) return null;
  let target: OutlineSection | undefined;
  let slot: number;
  const blockOf = (sectionKey: string, itemKey: string) => {
    const s = sectionByKey(o, sectionKey);
    return s?.blocks.find((b) => b.questions.some((q) => q.itemKey === itemKey)) ?? null;
  };
  switch (over.kind) {
    case "question": {
      const at = locate(o, over.itemKey);
      if (!at) return null;
      target = at.section;
      const block = blockOf(at.section.key, over.itemKey);
      if (!block) return null;
      slot = over.edge === "before" ? block.componentIndex : block.componentIndex + 1;
      break;
    }
    case "block":
      target = sectionByKey(o, over.sectionKey);
      slot = over.edge === "before" ? over.componentIndex : over.componentIndex + 1;
      break;
    case "section":
      target = sectionByKey(o, over.sectionKey);
      slot = target ? (counts[target.index] ?? 0) : 0;
      break;
    case "add":
      target = sectionByKey(o, over.sectionKey);
      slot = over.componentIndex === null ? (target ? (counts[target.index] ?? 0) : 0) : over.componentIndex + 1;
      break;
    default:
      return null;
  }
  if (!target) return null;
  const same = target.key === source.key;
  if (same && (slot === drag.componentIndex || slot === drag.componentIndex + 1)) return { move: null, refusal: null };
  const index = same && slot > drag.componentIndex ? slot - 1 : slot;
  return {
    move: { op: "block", from: { sectionKey: drag.sectionKey, componentIndex: drag.componentIndex }, to: { sectionKey: target.key, index } },
    refusal: null,
  };
}

function planSection(o: Outline, sectionKey: string, over: HoverTarget): DropPlan | null {
  const from = o.sections.findIndex((s) => s.key === sectionKey);
  if (from < 0) return null;
  let gap: number;
  switch (over.kind) {
    case "section": {
      const at = sectionByKey(o, over.sectionKey);
      if (!at) return null;
      gap = over.edge === "before" ? at.index : at.index + 1;
      break;
    }
    case "question": {
      const at = locate(o, over.itemKey);
      if (!at) return null;
      gap = at.section.index + 1;
      break;
    }
    case "block":
    case "add": {
      const at = sectionByKey(o, over.sectionKey);
      if (!at) return null;
      gap = at.index + 1;
      break;
    }
    case "start":
      gap = 0;
      break;
    case "end":
      gap = o.sections.length;
      break;
  }
  if (gap === from || gap === from + 1) return { move: null, refusal: null };
  return { move: { op: "section", sectionKey, toIndex: gap > from ? gap - 1 : gap }, refusal: null };
}

// ---------------------------------------------------------------------------
// Alt+Arrow
// ---------------------------------------------------------------------------

/**
 * One step up or down for a question: past its neighbour in the section, or
 * into the end (start) of the section before (after) at the edge. A step that
 * would land inside another block goes past the whole block instead, since a
 * question can only sit before or after someone else's block — so holding
 * Alt+Down walks a question through a section without ever being refused for
 * the middle of a questionnaire. Null at the very start or end of the survey.
 */
export function keyboardQuestionMove(o: Outline, itemKey: string, direction: -1 | 1): MoveOp | null {
  const from = locate(o, itemKey);
  if (!from) return null;
  const moving = from.seq[from.index]!;
  const without = from.seq.filter((e) => e.itemKey !== itemKey);
  let index = from.index + direction;
  let section = from.section;
  let seq = without;
  if (index < 0 || index > without.length) {
    const next = o.sections[section.index + direction];
    if (!next) return null;
    section = next;
    seq = seqOf(next);
    index = direction < 0 ? seq.length : 0;
  }
  const middle = middleOfBlock(seq, index, moving.instrument);
  if (middle) {
    const span = blockSpan(seq, middle.componentIndex, section);
    index = direction < 0 ? span.start : span.end;
  }
  return { op: "question", itemKey, to: { sectionKey: section.key, index } };
}

/** One step for a block: past its neighbouring component, or into the section before/after. */
export function keyboardBlockMove(
  o: Outline,
  counts: ComponentCounts,
  sectionKey: string,
  componentIndex: number,
  direction: -1 | 1,
): MoveOp | null {
  const source = sectionByKey(o, sectionKey);
  if (!source) return null;
  const size = counts[source.index] ?? 0;
  const from = { sectionKey, componentIndex };
  if (direction < 0 && componentIndex > 0) return { op: "block", from, to: { sectionKey, index: componentIndex - 1 } };
  if (direction > 0 && componentIndex < size - 1) return { op: "block", from, to: { sectionKey, index: componentIndex + 1 } };
  const next = o.sections[source.index + direction];
  if (!next) return null;
  return { op: "block", from, to: { sectionKey: next.key, index: direction < 0 ? (counts[next.index] ?? 0) : 0 } };
}

export function keyboardSectionMove(o: Outline, sectionKey: string, direction: -1 | 1): MoveOp | null {
  const from = o.sections.findIndex((s) => s.key === sectionKey);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= o.sections.length) return null;
  return { op: "section", sectionKey, toIndex: to };
}

// ---------------------------------------------------------------------------
// The undo step's name
// ---------------------------------------------------------------------------

/**
 * The undo label for a move, naming what moves: "Move “Gender”".
 *
 * REVIEW FIX: every move used to be labelled "Move question" (or "Move
 * block"/"Move section"), and the draft history merges consecutive steps with
 * the same label made within 1.2 s (so typing is one step, not one per key).
 * Moving one question and then, a moment later, another — Alt+Down, Down,
 * Alt+Down — was therefore ONE undo step, and Ctrl+Z silently put both back.
 * Naming the thing keeps repeated moves of the same question one step
 * (holding Alt+Down doesn't flood the history) while a move of anything else
 * is a step of its own.
 */
export function moveLabel(o: Outline, move: MoveOp): string {
  switch (move.op) {
    case "question":
      // With the ID: many questions start with the same words ("How much time
      // do you usually spend on …"), so the text alone would still merge.
      return `Move “${questionName(questionText(o, move.itemKey), 30)}” (${move.itemKey})`;
    case "block": {
      const block = sectionByKey(o, move.from.sectionKey)?.blocks.find((b) => b.componentIndex === move.from.componentIndex);
      return `Move “${shortText(block?.name ?? "the block", 40)}”`;
    }
    case "section":
      return `Move section “${shortText(sectionByKey(o, move.sectionKey)?.title ?? move.sectionKey, 40)}”`;
  }
}

// ---------------------------------------------------------------------------
// Saying where something ended up
// ---------------------------------------------------------------------------

/**
 * Where a moved thing now is, read from the outline AFTER the move — so the
 * sentence is true even when the model placed it somewhere other than asked.
 * "Moved “How sleepy…” to position 3 of 7 in Sleep".
 */
export function describeMoved(o: Outline, move: MoveOp): string | null {
  switch (move.op) {
    case "question": {
      const at = locate(o, move.itemKey);
      if (!at) return null;
      return `Moved “${questionName(questionText(o, move.itemKey), 50)}” to position ${at.index + 1} of ${at.seq.length} in ${at.section.title}`;
    }
    case "block": {
      const section = sectionByKey(o, move.to.sectionKey);
      if (!section) return null;
      const i = section.blocks.findIndex((b) => b.componentIndex === move.to.index);
      const block = section.blocks[i];
      if (!block) return null;
      return `Moved “${shortText(block.name, 50)}” to position ${i + 1} of ${section.blocks.length} in ${section.title}`;
    }
    case "section": {
      const i = o.sections.findIndex((s) => s.key === move.sectionKey);
      if (i < 0) return null;
      return `Moved the section “${o.sections[i]!.title}” to position ${i + 1} of ${o.sections.length}`;
    }
  }
}
