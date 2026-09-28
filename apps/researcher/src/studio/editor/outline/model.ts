import {
  protectedModule,
  shortText,
  type EditTier,
  type Issue,
  type Outline,
  type OutlineBlock,
  type OutlineQuestion,
  type OutlineSection,
  type QuestionTypeId,
} from "@myself/studio";
import type { Selection } from "../selection.js";

/**
 * The outline as rows: which nodes exist, which are shown, what each one says.
 *
 * Pure, and rebuilt from `outline(draft)` on every change, so the outline can
 * never show a survey the draft does not hold. Each node carries a signature
 * of everything its row draws; the rows are memoised on it, so a keystroke in
 * the centre editor re-renders the one row whose text changed rather than all
 * 150 of them.
 *
 * Node ids are the selection's own encoding wherever a node is selectable
 * (`welcome`, `section:<key>`, `block:<section>:<index>`, a question ID), so
 * "is this row selected" is one string comparison.
 */

export interface IssueCount {
  errors: number;
  warnings: number;
}

export const NO_ISSUES: IssueCount = Object.freeze({ errors: 0, warnings: 0 });

export interface IssueIndex {
  welcome: IssueCount;
  completion: IssueCount;
  survey: IssueCount;
  /** Issues located at a section itself (its title, its condition). */
  section: ReadonlyMap<string, IssueCount>;
  /** Keyed `<sectionKey> <refKey>`: a block's own issues. */
  block: ReadonlyMap<string, IssueCount>;
  /** Keyed by question ID. An option's issues count towards its question. */
  question: ReadonlyMap<string, IssueCount>;
}

function bump(map: Map<string, IssueCount>, key: string, severity: Issue["severity"]): void {
  const current = map.get(key) ?? { errors: 0, warnings: 0 };
  map.set(key, severity === "error" ? { ...current, errors: current.errors + 1 } : { ...current, warnings: current.warnings + 1 });
}

export function blockIssueKey(sectionKey: string, refKey: string): string {
  return `${sectionKey} ${refKey}`;
}

/** Every issue, filed under the node it belongs to. */
export function indexIssues(issues: readonly Issue[]): IssueIndex {
  const section = new Map<string, IssueCount>();
  const block = new Map<string, IssueCount>();
  const question = new Map<string, IssueCount>();
  const singles = { welcome: new Map<string, IssueCount>(), completion: new Map<string, IssueCount>(), survey: new Map<string, IssueCount>() };
  for (const issue of issues) {
    const at = issue.location;
    switch (at.kind) {
      case "question":
      case "option":
        if (at.itemKey) bump(question, at.itemKey, issue.severity);
        else if (at.sectionKey) bump(section, at.sectionKey, issue.severity);
        else bump(singles.survey, "", issue.severity);
        break;
      case "block":
        if (at.sectionKey && at.refKey) bump(block, blockIssueKey(at.sectionKey, at.refKey), issue.severity);
        else if (at.sectionKey) bump(section, at.sectionKey, issue.severity);
        else bump(singles.survey, "", issue.severity);
        break;
      case "section":
        if (at.sectionKey) bump(section, at.sectionKey, issue.severity);
        else bump(singles.survey, "", issue.severity);
        break;
      case "welcome":
      case "completion":
      case "survey":
        bump(singles[at.kind], "", issue.severity);
        break;
    }
  }
  return {
    welcome: singles.welcome.get("") ?? NO_ISSUES,
    completion: singles.completion.get("") ?? NO_ISSUES,
    survey: singles.survey.get("") ?? NO_ISSUES,
    section,
    block,
    question,
  };
}

export function addCounts(a: IssueCount, b: IssueCount): IssueCount {
  if (b.errors === 0 && b.warnings === 0) return a;
  return { errors: a.errors + b.errors, warnings: a.warnings + b.warnings };
}

export function hasIssues(c: IssueCount): boolean {
  return c.errors > 0 || c.warnings > 0;
}

/** "2 errors, 1 warning" — for screen readers and tooltips. */
export function describeCount(c: IssueCount): string {
  const parts: string[] = [];
  if (c.errors > 0) parts.push(`${c.errors} ${c.errors === 1 ? "error" : "errors"}`);
  if (c.warnings > 0) parts.push(`${c.warnings} ${c.warnings === 1 ? "warning" : "warnings"}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A character as search compares it: lower case, accents dropped ("É" → "e"). */
function fold(ch: string): string {
  return ch.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("en-GB");
}

/**
 * Where `query` occurs in `text`, as [start, end) ranges of the ORIGINAL text,
 * matching regardless of case and accents so "cafe" finds "Café". Ranges are
 * mapped back character by character, so a highlight never lands a letter off
 * when folding changed a character's length.
 */
export function findMatches(text: string, query: string): [number, number][] {
  const q = [...query.trim()].map(fold).join("");
  if (!q) return [];
  let folded = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]!);
    folded += f;
    for (let k = 0; k < f.length; k++) origin.push(i);
  }
  const out: [number, number][] = [];
  let from = 0;
  for (;;) {
    const at = folded.indexOf(q, from);
    if (at < 0) break;
    const start = origin[at]!;
    const end = origin[at + q.length - 1]! + 1;
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
    from = at + q.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export type NodeKind =
  | "welcome"
  | "section"
  | "block"
  | "question"
  | "add-question"
  | "add-section"
  | "completion"
  | "settings"
  | "archive"
  | "archived";

export interface QuestionInfo {
  itemKey: string;
  instrument: string;
  text: string;
  studioType: QuestionTypeId;
  required: OutlineQuestion["required"];
  hasCondition: boolean;
  identifying: boolean;
  tier: EditTier;
  /** 1-based, in the whole survey. */
  number: number;
  sectionKey: string;
  componentIndex: number;
}

export interface BlockInfo {
  sectionKey: string;
  componentIndex: number;
  instrument: string;
  refKey: string;
  name: string;
  tier: EditTier;
  /** A protected module that has been unlocked: still worth showing as such. */
  unlocked: boolean;
  hasCondition: boolean;
  /** "Shown only if …", when the block has a condition. */
  condition: string | null;
  questionCount: number;
  firstItemKey: string | null;
  lastItemKey: string | null;
}

export interface SectionInfo {
  key: string;
  title: string;
  index: number;
  hasCondition: boolean;
  questionCount: number;
  /** "Shown only if …", when the section has a condition. */
  condition: string | null;
  /** It holds a protected module, so it stays where it is until that is unlocked (ops `moveSection`). */
  fixed: boolean;
}

export interface AddInfo {
  sectionKey: string;
  /** The block it adds to, when it is a block's row rather than the section's. */
  componentIndex: number | null;
  /** Add straight after this question (the end of a block); absent for the section's end. */
  afterItemKey: string | null;
  /** Where the new question goes, in words, for the row's name and the type picker. */
  where: string;
}

export interface TreeNode {
  id: string;
  kind: NodeKind;
  /** aria-level: 1 for top-level rows. */
  level: number;
  parentId: string | null;
  /** The row's accessible name, in plain text. */
  label: string;
  expandable: boolean;
  expanded: boolean;
  /**
   * What its open/closed state is remembered under, when not its id. A
   * block's id is its position, which changes when a block before it moves;
   * its open state belongs to the block, so it is keyed by the block itself.
   */
  expandKey?: string;
  /** The children shown (none while collapsed or filtered away). */
  children: TreeNode[];
  selection: Selection | null;
  issues: IssueCount;
  /** Search matches in the row's main text and in its ID, [start, end). */
  textMatch: [number, number][];
  idMatch: [number, number][];
  question?: QuestionInfo;
  block?: BlockInfo;
  section?: SectionInfo;
  add?: AddInfo;
  archived?: { itemKey: string; text: string; sectionKey: string | null };
  /** Everything the row itself draws. Equal signatures draw identical rows. */
  sig: string;
  /** This row's signature and all its shown descendants'. */
  treeSig: string;
}

export interface TreeOptions {
  query: string;
  withProblems: boolean;
  withConditions: boolean;
  /** Rows the person expanded or collapsed; anything absent takes its default. */
  expanded: ReadonlyMap<string, boolean>;
  canEdit: boolean;
  /**
   * A section's condition in words ("Shown only if …"), or a block's when
   * `componentIndex` is given; null when there is none. Optional so the model
   * can be built without a draft (tests), when conditions read generically.
   */
  describeCondition?: (sectionKey: string, componentIndex?: number) => string | null;
}

export interface Tree {
  roots: TreeNode[];
  /** Every shown row, top to bottom — what arrow keys walk. */
  visible: TreeNode[];
  /** The ids of `visible`: the rows actually drawn. */
  shown: ReadonlySet<string>;
  /**
   * Every row built, INCLUDING those inside a collapsed section or block,
   * which are not drawn. Whether a row is on screen is `shown`, not this.
   */
  byId: ReadonlyMap<string, TreeNode>;
  filtering: boolean;
  /** Questions (live and archived) passing the search and filters. */
  matches: number;
}

/**
 * Whether a block is drawn with a header of its own. A licensed or protected
 * block always is — the lock has to be shown where it applies — and so is a
 * block shown only to some participants, whose condition covers every question
 * in it. Any other block's questions sit straight under the section: a
 * researcher thinks in sections and questions, not in the modules a survey
 * happens to be assembled from.
 */
export function blockHasHeader(block: Pick<OutlineBlock, "tier" | "hasCondition" | "instrument">): boolean {
  return block.tier !== "editable" || block.hasCondition || protectedModule(block.instrument) !== null;
}

export function blockExpandKey(sectionKey: string, refKey: string): string {
  return `blockx:${sectionKey} ${refKey}`;
}

/** The key a row's open/closed state is kept under. */
export function expandKeyOf(node: Pick<TreeNode, "id" | "expandKey">): string {
  return node.expandKey ?? node.id;
}

/** Expanded unless the person said otherwise: licensed and protected blocks start folded. */
export function defaultExpanded(kind: NodeKind, block?: Pick<BlockInfo, "tier">): boolean {
  if (kind === "archive") return false;
  if (kind === "block") return block?.tier === "editable";
  return true;
}

/** What a question with no text yet is called wherever it is listed: the outline, the section page, the checks. */
export const UNTITLED_QUESTION = "Untitled question";

export function buildTree(o: Outline, index: IssueIndex, opts: TreeOptions): Tree {
  const query = opts.query.trim();
  const filtering = query !== "" || opts.withProblems || opts.withConditions;
  const expandedOf = (id: string, kind: NodeKind, block?: BlockInfo) =>
    filtering ? true : (opts.expanded.get(id) ?? defaultExpanded(kind, block));
  const byId = new Map<string, TreeNode>();
  let matches = 0;

  /**
   * `allChildren`: every child built, shown or not. A collapsed row's children
   * are not in `node.children`, but they still belong to it (REVIEW FIX: their
   * `parentId` was left null, so a hidden row could not be traced to the
   * collapsed row it is inside — see `tabStopFor`).
   */
  const finish = (node: Omit<TreeNode, "sig" | "treeSig">, sigParts: (string | number | boolean)[], allChildren: TreeNode[] = node.children): TreeNode => {
    const sig = [node.kind, node.level, node.label, node.expandable, node.expanded, node.issues.errors, node.issues.warnings, ranges(node.textMatch), ranges(node.idMatch), opts.canEdit, ...sigParts].join("␟");
    const full = node as TreeNode;
    full.sig = sig;
    full.treeSig = node.children.length > 0 ? `${sig}␞${node.children.map((c) => c.treeSig).join("␞")}` : sig;
    // A question placed twice (a validation error) must still have one row per placement.
    let id = full.id;
    for (let n = 2; byId.has(id); n++) id = `${full.id}#${n}`;
    full.id = id;
    for (const child of allChildren) child.parentId = id;
    byId.set(id, full);
    return full;
  };

  const leafPasses = (count: IssueCount, textMatch: boolean, conditional: boolean) =>
    (!query || textMatch) && (!opts.withProblems || hasIssues(count)) && (!opts.withConditions || conditional);

  const roots: TreeNode[] = [];

  // Start screen
  {
    const label = "Start screen";
    const textMatch = findMatches(label, query);
    if (!filtering || leafPasses(index.welcome, textMatch.length > 0, false)) {
      roots.push(
        finish(
          {
            id: "welcome",
            kind: "welcome",
            level: 1,
            parentId: null,
            label,
            expandable: false,
            expanded: false,
            children: [],
            selection: { kind: "welcome" },
            issues: index.welcome,
            textMatch,
            idMatch: [],
          },
          [],
        ),
      );
    }
  }

  // Sections
  for (const section of o.sections) {
    const node = sectionNode(section);
    if (node) roots.push(node);
  }

  function sectionNode(section: OutlineSection): TreeNode | null {
    const id = `section:${section.key}`;
    const titleMatch = findMatches(section.title, query);
    const titleMatches = titleMatch.length > 0;
    const questionCount = section.blocks.reduce((n, b) => n + b.questions.length, 0);
    const children: TreeNode[] = [];
    let total = index.section.get(section.key) ?? NO_ISSUES;
    let anyChild = false;

    for (const block of section.blocks) {
      const blockIssues = index.block.get(blockIssueKey(section.key, block.refKey)) ?? NO_ISSUES;
      total = addCounts(total, blockIssues);
      const header = blockHasHeader(block);
      const info: BlockInfo = {
        sectionKey: section.key,
        componentIndex: block.componentIndex,
        instrument: block.instrument,
        refKey: block.refKey,
        name: block.name,
        tier: block.tier,
        unlocked: block.tier === "editable" && protectedModule(block.instrument) !== null,
        hasCondition: block.hasCondition,
        condition: block.hasCondition
          ? (opts.describeCondition?.(section.key, block.componentIndex) ?? "Shown only to some participants")
          : null,
        questionCount: block.questions.length,
        firstItemKey: block.questions[0]?.itemKey ?? null,
        lastItemKey: block.questions[block.questions.length - 1]?.itemKey ?? null,
      };
      const level = header ? 3 : 2;
      const questions: TreeNode[] = [];
      for (const q of block.questions) {
        const qIssues = index.question.get(q.itemKey) ?? NO_ISSUES;
        total = addCounts(total, qIssues);
        const textMatch = findMatches(q.text, query);
        const idMatch = findMatches(q.itemKey, query);
        const conditional = q.hasCondition || block.hasCondition || section.hasCondition;
        if (filtering && !leafPasses(qIssues, titleMatches || textMatch.length > 0 || idMatch.length > 0, conditional)) continue;
        if (filtering) matches += 1;
        questions.push(questionNode(q, info, level, qIssues, textMatch, idMatch));
      }
      if (header) {
        const nameMatch = findMatches(block.name, query);
        const passes =
          filtering &&
          (!query || nameMatch.length > 0 || findMatches(block.instrument, query).length > 0) &&
          (!opts.withProblems || hasIssues(blockIssues)) &&
          (!opts.withConditions || block.hasCondition || section.hasCondition);
        if (filtering && questions.length === 0 && !passes) continue;
        const addable = opts.canEdit && !filtering && block.tier === "editable" && info.lastItemKey !== null;
        const kids = [...questions];
        if (addable) kids.push(addNode(section, info, 3));
        const blockId = `block:${section.key}:${block.componentIndex}`;
        const expandKey = blockExpandKey(section.key, block.refKey);
        const expanded = expandedOf(expandKey, "block", info);
        children.push(
          finish(
            {
              id: blockId,
              kind: "block",
              level: 2,
              parentId: id,
              label: blockLabel(info),
              expandable: kids.length > 0 || block.questions.length > 0,
              expanded,
              expandKey,
              children: expanded ? kids : [],
              selection: { kind: "block", sectionKey: section.key, componentIndex: block.componentIndex },
              issues: blockIssues,
              textMatch: nameMatch,
              idMatch: [],
              block: info,
            },
            [info.tier, info.unlocked, info.hasCondition, info.questionCount, info.condition ?? ""],
            kids,
          ),
        );
        anyChild = true;
      } else {
        if (questions.length > 0) anyChild = true;
        children.push(...questions);
      }
    }

    const sectionPasses =
      (!query || titleMatches) && (!opts.withProblems || hasIssues(index.section.get(section.key) ?? NO_ISSUES)) && (!opts.withConditions || section.hasCondition);
    if (filtering && !anyChild && !sectionPasses) return null;
    if (opts.canEdit && !filtering) children.push(addNode(section, null, 2));

    const condition = section.hasCondition ? (opts.describeCondition?.(section.key) ?? "Shown only to some participants") : null;
    const info: SectionInfo = {
      key: section.key,
      title: section.title,
      index: section.index,
      hasCondition: section.hasCondition,
      questionCount,
      condition,
      fixed: section.blocks.some((b) => b.tier === "protected"),
    };
    const expanded = expandedOf(id, "section");
    return finish(
      {
        id,
        kind: "section",
        level: 1,
        parentId: null,
        label: section.title || "Untitled section",
        expandable: children.length > 0,
        expanded,
        children: expanded ? children : [],
        selection: { kind: "section", sectionKey: section.key },
        issues: total,
        textMatch: titleMatch,
        idMatch: [],
        section: info,
      },
      [questionCount, section.hasCondition, condition ?? "", info.fixed],
      children,
    );
  }

  function questionNode(
    q: OutlineQuestion,
    block: BlockInfo,
    level: number,
    issues: IssueCount,
    textMatch: [number, number][],
    idMatch: [number, number][],
  ): TreeNode {
    const n = q.position + 1;
    const info: QuestionInfo = {
      itemKey: q.itemKey,
      instrument: q.instrument,
      text: q.text,
      studioType: q.studioType,
      required: q.required,
      hasCondition: q.hasCondition,
      identifying: q.identifying,
      tier: q.tier,
      number: n,
      sectionKey: block.sectionKey,
      componentIndex: block.componentIndex,
    };
    return finish(
      {
        id: q.itemKey,
        kind: "question",
        level,
        parentId: null,
        label: q.text.trim() ? shortText(q.text, 90) : UNTITLED_QUESTION,
        expandable: false,
        expanded: false,
        children: [],
        selection: { kind: "question", itemKey: q.itemKey },
        issues,
        textMatch,
        idMatch,
        question: info,
      },
      [q.text, q.studioType, q.required, q.hasCondition, q.identifying, q.tier, n, block.componentIndex],
    );
  }

  function addNode(section: OutlineSection, block: BlockInfo | null, level: number): TreeNode {
    const where = block ? `after “${shortText(block.name, 40)}” in ${section.title}` : `at the end of ${section.title}`;
    return finish(
      {
        id: block ? `add:${section.key}:${block.componentIndex}` : `add:${section.key}`,
        kind: "add-question",
        level,
        parentId: null,
        label: block ? `Add a question to “${shortText(block.name, 40)}”` : `Add a question to ${section.title}`,
        expandable: false,
        expanded: false,
        children: [],
        selection: null,
        issues: NO_ISSUES,
        textMatch: [],
        idMatch: [],
        add: { sectionKey: section.key, componentIndex: block?.componentIndex ?? null, afterItemKey: block?.lastItemKey ?? null, where },
      },
      [where, block?.lastItemKey ?? ""],
    );
  }

  if (opts.canEdit && !filtering) {
    roots.push(
      finish(
        {
          id: "add-section",
          kind: "add-section",
          level: 1,
          parentId: null,
          label: "Add a section",
          expandable: false,
          expanded: false,
          children: [],
          selection: null,
          issues: NO_ISSUES,
          textMatch: [],
          idMatch: [],
        },
        [],
      ),
    );
  }

  for (const [id, kind, label, issues] of [
    ["completion", "completion", "Completion screen", index.completion],
    ["settings", "settings", "Survey settings", index.survey],
  ] as const) {
    const textMatch = findMatches(label, query);
    if (filtering && !leafPasses(issues, textMatch.length > 0, false)) continue;
    roots.push(
      finish(
        {
          id,
          kind,
          level: 1,
          parentId: null,
          label,
          expandable: false,
          expanded: false,
          children: [],
          selection: { kind: id },
          issues,
          textMatch,
          idMatch: [],
        },
        [],
      ),
    );
  }

  // Archived
  if (o.archived.length > 0) {
    const kids: TreeNode[] = [];
    for (const a of o.archived) {
      const textMatch = findMatches(a.text, query);
      const idMatch = findMatches(a.itemKey, query);
      if (filtering && (opts.withProblems || opts.withConditions || (textMatch.length === 0 && idMatch.length === 0))) continue;
      if (filtering) matches += 1;
      kids.push(
        finish(
          {
            id: a.itemKey,
            kind: "archived",
            level: 2,
            parentId: null,
            label: a.text.trim() ? shortText(a.text, 90) : UNTITLED_QUESTION,
            expandable: false,
            expanded: false,
            children: [],
            selection: { kind: "question", itemKey: a.itemKey },
            issues: NO_ISSUES,
            textMatch,
            idMatch,
            archived: a,
          },
          [a.text, a.sectionKey ?? ""],
        ),
      );
    }
    if (!filtering || kids.length > 0) {
      const expanded = expandedOf("archive", "archive");
      roots.push(
        finish(
          {
            id: "archive",
            kind: "archive",
            level: 1,
            parentId: null,
            label: `Archived (${o.archived.length})`,
            expandable: true,
            expanded,
            children: expanded ? kids : [],
            selection: null,
            issues: NO_ISSUES,
            textMatch: [],
            idMatch: [],
          },
          [o.archived.length],
          kids,
        ),
      );
    }
  }

  const visible: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      visible.push(node);
      if (node.expanded) walk(node.children);
    }
  };
  walk(roots);
  return { roots, visible, shown: new Set(visible.map((n) => n.id)), byId, filtering, matches };
}

/**
 * The row that should hold the tree's one tab stop (roving tabindex): the
 * current one while it is drawn; else the nearest drawn row it sits inside
 * (collapsing a section moves the stop to the section, as focus moves in any
 * tree); else the selected row if drawn; else the first row. Never a row that
 * is not drawn — then no row would have tabindex=0 and Tab would skip the tree.
 */
export function tabStopFor(tree: Pick<Tree, "shown" | "byId" | "visible">, active: string | null, selected: string | null): string | null {
  if (active && tree.shown.has(active)) return active;
  for (let node = active ? tree.byId.get(active) : undefined; node; node = node.parentId ? tree.byId.get(node.parentId) : undefined) {
    if (tree.shown.has(node.id)) return node.id;
  }
  if (selected && tree.shown.has(selected)) return selected;
  return tree.visible[0]?.id ?? null;
}

function ranges(r: [number, number][]): string {
  return r.map(([a, b]) => `${a}-${b}`).join(",");
}

/** A block header's name, with its lock in words. */
export function blockLabel(b: Pick<BlockInfo, "name" | "tier" | "unlocked">): string {
  return `${b.name} (${tierPhrase(b)})`;
}

export function tierPhrase(b: Pick<BlockInfo, "tier" | "unlocked">): string {
  if (b.tier === "locked") return "licensed — locked";
  if (b.tier === "protected") return "protected — unlock to edit";
  if (b.unlocked) return "unlocked for editing";
  return "shown only to some participants";
}

/**
 * The rows a selection sits under, outermost first — expanded when the
 * selection changes from elsewhere (a jump from the validation panel), so the
 * selected row is on screen.
 */
export function ancestorsOf(o: Outline, selection: Selection | null): string[] {
  if (!selection) return [];
  switch (selection.kind) {
    case "block":
      return [`section:${selection.sectionKey}`];
    case "question": {
      for (const section of o.sections) {
        for (const block of section.blocks) {
          if (!block.questions.some((q) => q.itemKey === selection.itemKey)) continue;
          const out = [`section:${section.key}`];
          if (blockHasHeader(block)) out.push(`block:${section.key}:${block.componentIndex}`);
          return out;
        }
      }
      return o.archived.some((a) => a.itemKey === selection.itemKey) ? ["archive"] : [];
    }
    default:
      return [];
  }
}

/** The first shown row whose label starts with `prefix` after `fromIndex`, wrapping — typeahead. */
export function typeahead(visible: readonly TreeNode[], fromIndex: number, prefix: string): number {
  const p = [...prefix].map(fold).join("");
  if (!p) return -1;
  for (let step = 1; step <= visible.length; step++) {
    const i = (fromIndex + step) % visible.length;
    const label = [...visible[i]!.label].map(fold).join("");
    if (label.startsWith(p)) return i;
  }
  return -1;
}
