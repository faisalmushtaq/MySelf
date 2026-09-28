import { shortText, type Issue, type Outline } from "@myself/studio";
import type { Selection } from "../selection.js";

/**
 * From a validation issue to the place it is about.
 *
 * Validation locates every issue precisely (contract.ts `IssueLocation`); this
 * turns that location into an editor selection — the node "Go to" opens — and
 * sorts issues into the order a participant would meet them, so the panel reads
 * top to bottom like the survey does.
 */

/**
 * The node an issue is about. An option's issue opens its question (options
 * are edited there); a block's opens the block, found by its instrument in the
 * section since a location names the instrument, not the position; anything
 * about the survey as a whole opens the survey settings.
 */
export function selectionFor(issue: Issue, outline?: Outline): Selection {
  const at = issue.location;
  switch (at.kind) {
    case "question":
    case "option":
      if (at.itemKey) return { kind: "question", itemKey: at.itemKey };
      return at.sectionKey ? { kind: "section", sectionKey: at.sectionKey } : { kind: "settings" };
    case "block": {
      if (!at.sectionKey) return { kind: "settings" };
      const block = outline?.sections.find((s) => s.key === at.sectionKey)?.blocks.find((b) => b.refKey === at.refKey);
      return block ? { kind: "block", sectionKey: at.sectionKey, componentIndex: block.componentIndex } : { kind: "section", sectionKey: at.sectionKey };
    }
    case "section":
      return at.sectionKey ? { kind: "section", sectionKey: at.sectionKey } : { kind: "settings" };
    case "welcome":
      return { kind: "welcome" };
    case "completion":
      return { kind: "completion" };
    case "survey":
      return { kind: "settings" };
  }
}

export interface IssueGroup {
  /** Stable key for the list. */
  id: string;
  /** Where, in words: "Start screen", a section's title, a block's name, a question's text and ID. */
  label: string;
  /** The section a question or block is in, when the label is one. */
  context: string | null;
  issues: Issue[];
}

export interface GroupedIssues {
  errors: IssueGroup[];
  warnings: IssueGroup[];
}

interface Place {
  id: string;
  label: string;
  context: string | null;
  order: number;
}

/**
 * Issues by severity, then by place in survey order: start, each section and
 * its questions, completion, survey. `before` is the version the draft is
 * checked against: a question removed from the draft outright (not archived)
 * is headed by its text from there, rather than by its ID alone.
 */
export function groupIssues(issues: readonly Issue[], outline: Outline, before?: Outline | null): GroupedIssues {
  const questionPlace = new Map<string, { text: string; section: string; order: number }>();
  const sectionPlace = new Map<string, { title: string; order: number }>();
  const blockPlace = new Map<string, { name: string; section: string; order: number }>();
  const STEP = 100_000;
  outline.sections.forEach((section, i) => {
    const base = (i + 1) * STEP;
    sectionPlace.set(section.key, { title: section.title, order: base });
    let n = 0;
    for (const block of section.blocks) {
      // Just before its first question: a block's own problems (its condition,
      // its order) read before those of the questions in it.
      blockPlace.set(`${section.key}\u0000${block.refKey}`, { name: block.name, section: section.title, order: base + 0.5 + n });
      for (const q of block.questions) questionPlace.set(q.itemKey, { text: q.text, section: section.title, order: base + 1 + n++ });
    }
  });
  const end = (outline.sections.length + 1) * STEP;
  const archived = new Map(outline.archived.map((a) => [a.itemKey, a.text]));
  let removed: Map<string, string> | null = null;
  const removedText = (itemKey: string): string | undefined => {
    if (!before) return undefined;
    removed ??= new Map(before.sections.flatMap((s) => s.blocks.flatMap((b) => b.questions.map((q) => [q.itemKey, q.text] as const))));
    return removed.get(itemKey);
  };

  const placeOf = (issue: Issue): Place => {
    const at = issue.location;
    if ((at.kind === "question" || at.kind === "option") && at.itemKey) {
      const q = questionPlace.get(at.itemKey);
      if (q) {
        const said = q.text.trim() ? `“${shortText(q.text, 70)}”` : "Untitled question";
        return { id: `q:${at.itemKey}`, label: `${said} (${at.itemKey})`, context: q.section, order: q.order };
      }
      const text = archived.get(at.itemKey);
      const gone = text === undefined ? removedText(at.itemKey) : undefined;
      return {
        id: `q:${at.itemKey}`,
        label:
          text !== undefined
            ? `“${shortText(text, 70)}” (${at.itemKey}, archived)`
            : gone?.trim()
              ? `“${shortText(gone, 70)}” (${at.itemKey})`
              : `Question ${at.itemKey}`,
        context: null,
        order: end - 1,
      };
    }
    if (at.kind === "block" && at.sectionKey && at.refKey) {
      const b = blockPlace.get(`${at.sectionKey}\u0000${at.refKey}`);
      if (b) return { id: `b:${at.sectionKey}:${at.refKey}`, label: `“${shortText(b.name, 70)}”`, context: b.section, order: b.order };
    }
    if ((at.kind === "section" || at.kind === "block" || at.kind === "question" || at.kind === "option") && at.sectionKey) {
      const s = sectionPlace.get(at.sectionKey);
      return { id: `s:${at.sectionKey}`, label: s ? `Section: ${s.title}` : `Section ${at.sectionKey}`, context: null, order: s?.order ?? end - 2 };
    }
    if (at.kind === "welcome") return { id: "welcome", label: "Start screen", context: null, order: 0 };
    if (at.kind === "completion") return { id: "completion", label: "Completion screen", context: null, order: end };
    return { id: "survey", label: "The whole survey", context: null, order: end + 1 };
  };

  const group = (severity: Issue["severity"]): IssueGroup[] => {
    const groups = new Map<string, IssueGroup & { order: number }>();
    for (const issue of issues) {
      if (issue.severity !== severity) continue;
      const place = placeOf(issue);
      const existing = groups.get(place.id);
      if (existing) existing.issues.push(issue);
      else groups.set(place.id, { id: place.id, label: place.label, context: place.context, issues: [issue], order: place.order });
    }
    return [...groups.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...g }) => g);
  };

  return { errors: group("error"), warnings: group("warning") };
}
