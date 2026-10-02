import type { Outline } from "@myself/studio";
import type { DragItem, HoverTarget } from "./dnd.js";
import { blockHasHeader, type TreeNode } from "./model.js";
import type { DropEdge } from "./store.js";

/**
 * From "the pointer is over this row, in its upper or lower half" to what a
 * drop there means, and where to draw the line that says so.
 *
 * The line is drawn where the thing will actually land. A block dropped over a
 * question lands at a block boundary, never between two questions, so only the
 * rows at a boundary are targets for it; a question dropped at the top of
 * someone else's licensed block lands before the whole block, so the line is
 * drawn above the block's header rather than inside the group.
 */

export interface Hover {
  over: HoverTarget;
  /** The row the drop line is drawn on, and on which side. */
  indicator: { id: string; edge: DropEdge };
}

interface BlockFacts {
  sectionKey: string;
  componentIndex: number;
  instrument: string;
  header: boolean;
  first: string | null;
  last: string | null;
}

function blockOf(o: Outline, sectionKey: string, componentIndex: number): BlockFacts | null {
  const block = o.sections.find((s) => s.key === sectionKey)?.blocks.find((b) => b.componentIndex === componentIndex);
  if (!block) return null;
  return {
    sectionKey,
    componentIndex,
    instrument: block.instrument,
    header: blockHasHeader(block),
    first: block.questions[0]?.itemKey ?? null,
    last: block.questions[block.questions.length - 1]?.itemKey ?? null,
  };
}

const blockId = (b: { sectionKey: string; componentIndex: number }) => `block:${b.sectionKey}:${b.componentIndex}`;

export function resolveHover(o: Outline, node: TreeNode, upper: boolean, drag: DragItem, draggedInstrument: string | null): Hover | null {
  const edge: "before" | "after" = upper ? "before" : "after";
  switch (drag.kind) {
    case "question":
      return questionHover(o, node, edge, draggedInstrument);
    case "block":
      return blockHover(o, node, edge);
    case "section":
      return sectionHover(node, edge);
  }
}

function questionHover(o: Outline, node: TreeNode, edge: "before" | "after", instrument: string | null): Hover | null {
  switch (node.kind) {
    case "question": {
      const q = node.question!;
      const block = blockOf(o, q.sectionKey, q.componentIndex);
      // Someone else's block with a header (a licensed questionnaire): its top
      // edge is the block's top edge.
      if (block?.header && block.instrument !== instrument && edge === "before" && block.first === q.itemKey) {
        return { over: { kind: "block", sectionKey: block.sectionKey, componentIndex: block.componentIndex, edge: "before" }, indicator: { id: blockId(block), edge: "before" } };
      }
      return { over: { kind: "question", itemKey: q.itemKey, edge }, indicator: { id: node.id, edge } };
    }
    case "block": {
      const b = node.block!;
      // Below an open header is the block's first question: still "before the block".
      const e = edge === "after" && !node.expanded ? "after" : "before";
      return { over: { kind: "block", sectionKey: b.sectionKey, componentIndex: b.componentIndex, edge: e }, indicator: { id: node.id, edge: e } };
    }
    case "section":
      return { over: { kind: "section", sectionKey: node.section!.key, edge: "inside" }, indicator: { id: node.id, edge: "inside" } };
    case "add-question": {
      const add = node.add!;
      return { over: { kind: "add", sectionKey: add.sectionKey, componentIndex: add.componentIndex }, indicator: { id: node.id, edge: "before" } };
    }
    default:
      return null;
  }
}

function blockHover(o: Outline, node: TreeNode, edge: "before" | "after"): Hover | null {
  switch (node.kind) {
    case "block": {
      const b = node.block!;
      const e = edge === "after" && !node.expanded ? "after" : "before";
      return { over: { kind: "block", sectionKey: b.sectionKey, componentIndex: b.componentIndex, edge: e }, indicator: { id: node.id, edge: e } };
    }
    case "question": {
      const q = node.question!;
      const block = blockOf(o, q.sectionKey, q.componentIndex);
      if (!block) return null;
      // Only a block's edges are places a block can go.
      if (edge === "before" && block.first === q.itemKey && !block.header) {
        return { over: { kind: "block", sectionKey: block.sectionKey, componentIndex: block.componentIndex, edge: "before" }, indicator: { id: node.id, edge: "before" } };
      }
      if (edge === "after" && block.last === q.itemKey) {
        return { over: { kind: "block", sectionKey: block.sectionKey, componentIndex: block.componentIndex, edge: "after" }, indicator: { id: node.id, edge: "after" } };
      }
      return null;
    }
    case "section":
      return { over: { kind: "section", sectionKey: node.section!.key, edge: "inside" }, indicator: { id: node.id, edge: "inside" } };
    case "add-question": {
      const add = node.add!;
      return { over: { kind: "add", sectionKey: add.sectionKey, componentIndex: add.componentIndex }, indicator: { id: node.id, edge: "before" } };
    }
    default:
      return null;
  }
}

function sectionHover(node: TreeNode, edge: "before" | "after"): Hover | null {
  switch (node.kind) {
    case "section": {
      // An open section's header is followed by its questions, so only its top edge is between sections.
      const e = edge === "after" && !node.expanded ? "after" : "before";
      return { over: { kind: "section", sectionKey: node.section!.key, edge: e }, indicator: { id: node.id, edge: e } };
    }
    case "welcome":
      return { over: { kind: "start" }, indicator: { id: node.id, edge: "after" } };
    case "add-section":
    case "completion":
    case "settings":
    case "archive":
      return node.level === 1 ? { over: { kind: "end" }, indicator: { id: node.id, edge: "before" } } : null;
    default:
      return null;
  }
}

/** What a row being dragged is, as the planner sees it; null for rows that can't be dragged. */
export function dragItemOf(node: TreeNode): DragItem | null {
  if (node.kind === "question" && node.question) return { kind: "question", itemKey: node.question.itemKey };
  if (node.kind === "block" && node.block) return { kind: "block", sectionKey: node.block.sectionKey, componentIndex: node.block.componentIndex };
  if (node.kind === "section" && node.section) return { kind: "section", sectionKey: node.section.key };
  return null;
}
