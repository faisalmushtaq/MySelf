import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  addQuestion,
  addSection,
  archiveQuestion,
  deleteQuestion,
  describeCondition,
  duplicateQuestion,
  moveBlock,
  moveQuestion,
  moveSection,
  outline as outlineOf,
  questionType,
  removeBlock,
  removeSection,
  restoreQuestion,
  shortText,
  type Outline as OutlineModel,
  type QuestionTypeId,
  type StudioDraft,
} from "@myself/studio";
import type { LogicExpr } from "@myself/schema";
import { ConfirmDialog } from "../ui/dialog.js";
import { Icon } from "../ui/icons.js";
import { Button, IconButton, Kbd, VisuallyHidden } from "../ui/kit.js";
import { useEditor } from "./context.js";
import { actionsFor, type ActionId, type ActionSpec } from "./outline/actions.js";
import { describeMoved, keyboardBlockMove, keyboardQuestionMove, keyboardSectionMove, planDrop, type DragItem, type DropPlan, type MoveOp } from "./outline/dnd.js";
import { dragItemOf, resolveHover } from "./outline/hover.js";
import { isTextEntry, rowDomId } from "./outline/keys.js";
import {
  ancestorsOf,
  blockExpandKey,
  blockHasHeader,
  buildTree,
  expandKeyOf,
  indexIssues,
  typeahead,
  type Tree,
  type TreeNode,
} from "./outline/model.js";
import { MoveDialog } from "./outline/MoveDialog.js";
import { RowContext, TreeItem, type RowHandlers } from "./outline/Row.js";
import { RowMenu } from "./outline/RowMenu.js";
import { RowStore } from "./outline/store.js";
import { TypePicker } from "./outline/TypePicker.js";
import { encodeSelection } from "./selection.js";
import "./outline.css";

/**
 * The survey outline: every screen, section, block and question in the order
 * participants meet them, as a keyboard-navigable tree (WAI-ARIA tree pattern)
 * with search, filters, adding, moving (drag, Alt+Arrow or a menu) and the
 * actions each row allows.
 *
 * Built for a 150-question survey edited for hours: the tree is derived from
 * the draft with `outline()` and rebuilt on every change, but each row is
 * memoised on a signature of what it draws, and per-row state (selected,
 * focused, drop line) lives in a small store the rows subscribe to — so typing
 * in the centre editor re-renders one row, not the outline.
 *
 * Every change goes through `ctx.run` and one of the model's operations, which
 * decide what is allowed; the outline only offers what they will accept, and
 * says why when something isn't available.
 */

type Pending =
  | { kind: "picker"; sectionKey: string; afterItemKey: string | null; where: string }
  | { kind: "move"; node: TreeNode }
  | { kind: "confirm"; title: string; body: ReactNode; confirmLabel: string; destructive: boolean; run: () => void };

interface MenuState {
  id: string;
  anchor: HTMLElement;
  items: ActionSpec[];
  label: string;
}

function applyMove(d: StudioDraft, move: MoveOp): StudioDraft {
  switch (move.op) {
    case "question":
      return moveQuestion(d, move.itemKey, move.to).draft;
    case "block":
      return moveBlock(d, move.from, move.to).draft;
    case "section":
      return moveSection(d, move.sectionKey, move.toIndex).draft;
  }
}

const quote = (text: string, max = 60) => `“${shortText(text || "(no text yet)", max)}”`;

export function Outline() {
  const ctx = useEditor();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const { draft, canEdit } = ctx;

  const o = useMemo(() => outlineOf(draft), [draft]);
  const counts = useMemo(() => draft.composition.sections.map((s) => s.components.length), [draft]);
  const index = useMemo(() => indexIssues(ctx.issues), [ctx.issues]);
  const describe = useMemo(() => conditionDescriber(draft), [draft]);

  const [query, setQuery] = useState("");
  // Typing in the search box stays responsive however long filtering takes.
  const deferredQuery = useDeferredValue(query);
  const [withProblems, setWithProblems] = useState(false);
  const [withConditions, setWithConditions] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [dragNote, setDragNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const tree = useMemo(
    () => buildTree(o, index, { query: deferredQuery, withProblems, withConditions, expanded, canEdit, describeCondition: describe }),
    [o, index, deferredQuery, withProblems, withConditions, expanded, canEdit, describe],
  );
  const treeRef = useRef<Tree>(tree);
  treeRef.current = tree;
  const outlineRef = useRef<OutlineModel>(o);
  outlineRef.current = o;
  const countsRef = useRef(counts);
  countsRef.current = counts;

  const [store] = useState(() => new RowStore());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusAfter = useRef<string | null>(null);
  const scrollTo = useRef<string | null>(null);

  // ── Selection: mark it, open what it is inside, bring it into view ───────
  const selectedId = encodeSelection(ctx.selection);
  useLayoutEffect(() => {
    store.set({ selected: selectedId });
  }, [store, selectedId]);

  const expand = useCallback((ids: string[]) => {
    const t = treeRef.current;
    const closed = ids.map((id) => t.byId.get(id)).filter((n): n is TreeNode => n?.expanded === false);
    if (closed.length === 0) return;
    setExpanded((prev) => {
      const next = new Map(prev);
      for (const node of closed) next.set(expandKeyOf(node), true);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    expand(ancestorsOf(outlineRef.current, ctxRef.current.selection));
    scrollTo.current = selectedId;
  }, [selectedId, expand]);

  useEffect(() => {
    // The tab stop follows the tree: never on a row that has gone.
    const active = store.active;
    if (!active || !tree.byId.has(active)) {
      const fallback = selectedId && tree.byId.has(selectedId) ? selectedId : (tree.visible[0]?.id ?? null);
      store.set({ active: fallback });
    }
    const target = scrollTo.current;
    if (target && tree.byId.has(target)) {
      scrollTo.current = null;
      store.set({ active: target });
      document.getElementById(rowDomId(target))?.querySelector(":scope > .sto-row")?.scrollIntoView({ block: "nearest" });
    }
    const focus = focusAfter.current;
    if (focus && tree.byId.has(focus)) {
      focusAfter.current = null;
      store.set({ active: focus });
      const el = document.getElementById(rowDomId(focus));
      el?.focus();
      el?.querySelector(":scope > .sto-row")?.scrollIntoView({ block: "nearest" });
    }
  }, [tree, store, selectedId]);

  const focusRow = useCallback(
    (id: string | undefined) => {
      if (!id) return;
      store.set({ active: id });
      const el = document.getElementById(rowDomId(id));
      el?.focus();
    },
    [store],
  );

  // ── Changes ──────────────────────────────────────────────────────────────
  const runMove = useCallback(
    (move: MoveOp, focus: boolean) => {
      const c = ctxRef.current;
      const out: { draft?: StudioDraft } = {};
      const label = move.op === "question" ? "Move question" : move.op === "block" ? "Move block" : "Move section";
      const ok = c.run(label, (d) => (out.draft = applyMove(d, move)));
      if (!ok || !out.draft) return;
      const after = outlineOf(out.draft);
      const said = describeMoved(after, move);
      if (said) c.announce(said);
      const id = move.op === "question" ? move.itemKey : move.op === "section" ? `section:${move.sectionKey}` : `block:${move.to.sectionKey}:${move.to.index}`;
      if (move.op === "question") expand(ancestorsOf(after, { kind: "question", itemKey: move.itemKey }));
      if (move.op === "block") {
        expand([`section:${move.to.sectionKey}`]);
        // A block's position is part of how it is selected; keep it selected where it went.
        const sel = c.selection;
        if (sel?.kind === "block" && sel.sectionKey === move.from.sectionKey && sel.componentIndex === move.from.componentIndex) {
          c.select({ kind: "block", sectionKey: move.to.sectionKey, componentIndex: move.to.index });
        }
      }
      if (focus) focusAfter.current = id;
      else store.set({ active: id });
    },
    [expand, store],
  );

  const addQuestionOf = useCallback((typeId: QuestionTypeId, target: { sectionKey: string; afterItemKey: string | null; where: string }) => {
    const c = ctxRef.current;
    const type = questionType(typeId);
    const out: { itemKey?: string } = {};
    const ok = c.run(`Add ${type.label.toLowerCase()} question`, (d) => {
      const r = addQuestion(d, {
        sectionKey: target.sectionKey,
        typeId,
        ...(target.afterItemKey ? { afterItemKey: target.afterItemKey } : {}),
        ...(c.reserved ? { reserved: c.reserved } : {}),
      });
      out.itemKey = r.itemKey;
      return r.draft;
    });
    if (!ok || !out.itemKey) return;
    c.select({ kind: "question", itemKey: out.itemKey }, { field: "stem" });
    c.announce(`Added a ${type.label.toLowerCase()} question ${target.where}. Type its text.`);
  }, []);

  const addSectionAt = useCallback((index?: number) => {
    const c = ctxRef.current;
    const out: { key?: string } = {};
    const ok = c.run("Add section", (d) => {
      const r = addSection(d, { title: "New section", ...(index !== undefined ? { index } : {}) });
      out.key = r.sectionKey;
      return r.draft;
    });
    if (!ok || !out.key) return;
    c.select({ kind: "section", sectionKey: out.key }, { field: "title" });
    c.announce("Added a section called “New section”. Give it a title.");
  }, []);

  /**
   * The row to select once `id` is gone: the next row in the same section,
   * else the one before it — so the selection stays where the person was
   * working instead of jumping to another part of the survey.
   */
  const neighbourOf = useCallback((id: string): TreeNode | null => {
    const t = treeRef.current;
    const topOf = (n: TreeNode): string => {
      let node = n;
      while (node.parentId) node = t.byId.get(node.parentId) ?? node;
      return node.id;
    };
    const i = t.visible.findIndex((n) => n.id === id);
    const self = t.visible[i];
    if (!self) return null;
    const home = topOf(self);
    const fits = (n: TreeNode | undefined): n is TreeNode =>
      !!n && !!n.selection && n.id !== id && !n.id.startsWith(`${id}#`) && n.parentId !== id && topOf(n) === home;
    for (let k = i + 1; k < t.visible.length; k++) if (fits(t.visible[k])) return t.visible[k]!;
    for (let k = i - 1; k >= 0; k--) if (fits(t.visible[k])) return t.visible[k]!;
    // A whole section going: the row above it.
    for (let k = i - 1; k >= 0; k--) if (t.visible[k]!.selection && t.visible[k]!.parentId !== id) return t.visible[k]!;
    return null;
  }, []);

  /**
   * Called before something is removed; the function it returns is called once
   * the removal has gone through. The neighbour is found first, while the row
   * is still in the tree, and chosen only if the removal happened — a refused
   * one leaves the selection alone.
   */
  const prepareRemoval = useCallback(
    (id: string) => {
      const c = ctxRef.current;
      const wasSelected = encodeSelection(c.selection) === id;
      const next = neighbourOf(id);
      return () => {
        if (wasSelected) c.select(next?.selection ?? null);
        if (next) focusAfter.current = next.id;
      };
    },
    [neighbourOf],
  );

  const runAction = useCallback(
    (action: ActionId, node: TreeNode) => {
      const c = ctxRef.current;
      const o = outlineRef.current;
      const q = node.question;
      const b = node.block;
      const s = node.section;
      const a = node.archived;
      switch (action) {
        case "rename":
          if (s) c.select({ kind: "section", sectionKey: s.key }, { field: "title" });
          return;
        case "add-question":
          if (s) setPending({ kind: "picker", sectionKey: s.key, afterItemKey: null, where: `at the end of ${s.title}` });
          return;
        case "add-question-after":
          if (q) setPending({ kind: "picker", sectionKey: q.sectionKey, afterItemKey: q.itemKey, where: `after ${quote(q.text, 40)}` });
          else if (b?.lastItemKey) setPending({ kind: "picker", sectionKey: b.sectionKey, afterItemKey: b.lastItemKey, where: `after “${shortText(b.name, 40)}”` });
          return;
        case "add-section-after":
          if (s) addSectionAt(s.index + 1);
          return;
        case "duplicate": {
          if (!q) return;
          const out: { itemKey?: string } = {};
          const ok = c.run("Duplicate question", (d) => {
            const r = duplicateQuestion(d, q.itemKey, c.reserved ? { reserved: c.reserved } : {});
            out.itemKey = r.itemKey;
            return r.draft;
          });
          if (ok && out.itemKey) {
            c.select({ kind: "question", itemKey: out.itemKey });
            c.announce(`Copied ${quote(q.text)} as ${out.itemKey}, straight after it.`);
          }
          return;
        }
        case "move-up":
        case "move-down": {
          const dir = action === "move-up" ? -1 : 1;
          const move = q
            ? keyboardQuestionMove(o, q.itemKey, dir)
            : b
              ? keyboardBlockMove(o, countsRef.current, b.sectionKey, b.componentIndex, dir)
              : s
                ? keyboardSectionMove(o, s.key, dir)
                : null;
          if (move) runMove(move, true);
          return;
        }
        case "move-to-section":
        case "restore-into":
          setPending({ kind: "move", node });
          return;
        case "archive":
          if (!q) return;
          setPending({
            kind: "confirm",
            title: "Archive this question?",
            confirmLabel: "Archive question",
            destructive: false,
            body: (
              <>
                <p className="stp-flush">
                  {quote(q.text)} ({q.itemKey}) stops being asked from the next version you publish.
                </p>
                <p>
                  Answers already collected are kept and stay readable, and its ID stays reserved, so it can never be given to
                  a different question. You can restore it from <strong>Archived</strong> at any time.
                </p>
              </>
            ),
            run: () => {
              const done = prepareRemoval(q.itemKey);
              if (c.run("Archive question", (d) => archiveQuestion(d, q.itemKey, c.actor()).draft)) {
                done();
                c.announce(`Archived ${quote(q.text)}. It is listed under Archived.`);
              }
            },
          });
          return;
        case "delete":
          if (!q) return;
          setPending({
            kind: "confirm",
            title: "Delete this question?",
            confirmLabel: "Delete question",
            destructive: true,
            body: (
              <p className="stp-flush">
                {quote(q.text)} ({q.itemKey}) has never been published, so no answers have been collected with it. Deleting
                removes it from the draft. Undo brings it back while you&rsquo;re still in the editor.
              </p>
            ),
            run: () => {
              const done = prepareRemoval(q.itemKey);
              if (c.run("Delete question", (d) => deleteQuestion(d, q.itemKey, { published: c.publishedItemKeys }).draft)) {
                done();
                c.announce(`Deleted ${quote(q.text)}.`);
              }
            },
          });
          return;
        case "remove-section":
          if (!s) return;
          setPending({
            kind: "confirm",
            title: "Delete this section?",
            confirmLabel: "Delete section",
            destructive: true,
            body: <p className="stp-flush">“{s.title}” has nothing in it. Deleting it removes it from the draft.</p>,
            run: () => {
              const done = prepareRemoval(`section:${s.key}`);
              if (c.run("Delete section", (d) => removeSection(d, s.key).draft)) {
                done();
                c.announce(`Deleted the section “${s.title}”.`);
              }
            },
          });
          return;
        case "remove-block":
          if (!b) return;
          setPending({
            kind: "confirm",
            title: `Remove “${shortText(b.name, 50)}”?`,
            confirmLabel: "Remove block",
            destructive: true,
            body: (
              <>
                <p className="stp-flush">
                  All {b.questionCount === 1 ? "1 question" : `${b.questionCount} questions`} in it are archived: participants
                  stop seeing them from the next version you publish.
                </p>
                <p>
                  Answers already collected are kept and stay readable, and every question can be restored from{" "}
                  <strong>Archived</strong>
                  {b.tier === "locked" ? " — restoring any one of them brings back the whole questionnaire, in its validated order" : ""}.
                </p>
              </>
            ),
            run: () => {
              const done = prepareRemoval(`block:${b.sectionKey}:${b.componentIndex}`);
              if (c.run("Remove block", (d) => removeBlock(d, b.sectionKey, b.componentIndex, c.actor()).draft)) {
                done();
                c.announce(`Removed “${b.name}”. Its questions are listed under Archived.`);
              }
            },
          });
          return;
        case "restore": {
          if (!a) return;
          const out: { itemKey?: string } = {};
          const ok = c.run("Restore question", (d) => {
            const r = restoreQuestion(d, a.itemKey);
            out.itemKey = r.itemKey;
            return r.draft;
          });
          if (ok && out.itemKey) {
            c.select({ kind: "question", itemKey: out.itemKey });
            c.announce(`Restored ${quote(a.text)}.`);
          }
          return;
        }
        case "delete-archived":
          if (!a) return;
          setPending({
            kind: "confirm",
            title: "Delete this archived question for good?",
            confirmLabel: "Delete permanently",
            destructive: true,
            body: (
              <p className="stp-flush">
                {quote(a.text)} ({a.itemKey}) was never published, so no answers were collected with it. It is removed from the
                draft entirely. Undo brings it back while you&rsquo;re still in the editor.
              </p>
            ),
            run: () => {
              const done = prepareRemoval(a.itemKey);
              if (c.run("Delete archived question", (d) => deleteQuestion(d, a.itemKey, { published: c.publishedItemKeys }).draft)) {
                done();
                c.announce(`Deleted ${quote(a.text)} for good.`);
              }
            },
          });
          return;
      }
    },
    [addSectionAt, prepareRemoval, runMove],
  );

  const openMenu = useCallback(
    (id: string, anchor: HTMLElement) => {
      const c = ctxRef.current;
      if (!c.canEdit) return;
      const node = treeRef.current.byId.get(id);
      if (!node) return;
      const items = actionsFor(node, { draft: c.draft, outline: outlineRef.current, counts: countsRef.current, published: c.publishedItemKeys });
      if (items.length === 0) return;
      store.set({ active: id });
      setMenu({ id, anchor, items, label: `Actions for ${node.label}` });
    },
    [store],
  );

  const closeMenu = useCallback(
    (restore: boolean) => {
      setMenu((m) => {
        if (m && restore) window.setTimeout(() => focusRow(m.id), 0);
        return null;
      });
    },
    [focusRow],
  );

  // ── Rows' handlers: stable, so they never make a row re-render ───────────
  const dragRef = useRef<{ item: DragItem; instrument: string | null } | null>(null);
  const planRef = useRef<DropPlan | null>(null);

  const handlers = useMemo<RowHandlers>(
    () => ({
      activate: (id) => {
        const node = treeRef.current.byId.get(id);
        if (!node) return;
        store.set({ active: id });
        const c = ctxRef.current;
        if (node.kind === "add-question" && node.add) {
          setPending({ kind: "picker", sectionKey: node.add.sectionKey, afterItemKey: node.add.afterItemKey, where: node.add.where });
        } else if (node.kind === "add-section") {
          addSectionAt();
        } else if (node.kind === "archive") {
          setExpanded((prev) => new Map(prev).set(expandKeyOf(node), !node.expanded));
        } else if (node.selection) {
          c.select(node.selection);
        }
      },
      toggle: (id) => {
        const node = treeRef.current.byId.get(id);
        if (!node || !node.expandable || treeRef.current.filtering) return;
        setExpanded((prev) => new Map(prev).set(expandKeyOf(node), !node.expanded));
      },
      openMenu,
      dragStart: (id, e) => {
        const node = treeRef.current.byId.get(id);
        const item = node ? dragItemOf(node) : null;
        if (!node || !item || !ctxRef.current.canEdit) {
          e.preventDefault();
          return;
        }
        dragRef.current = { item, instrument: node.question?.instrument ?? node.block?.instrument ?? null };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", node.label);
        setMenu(null);
        setDragging(true);
      },
      dragEnd: () => {
        dragRef.current = null;
        planRef.current = null;
        store.set({ drop: null });
        setDragging(false);
        setDragNote(null);
      },
    }),
    [store, openMenu, addSectionAt],
  );

  const rowContext = useMemo(() => ({ handlers, store, canEdit }), [handlers, store, canEdit]);

  // ── Dragging over the outline ────────────────────────────────────────────
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    autoScroll(rootRef.current, e.clientY);
    const rowEl = (e.target as Element).closest<HTMLElement>("[data-row-id]");
    const node = rowEl ? tree.byId.get(rowEl.dataset["rowId"] ?? "") : undefined;
    const box = rowEl?.querySelector(":scope > .sto-row")?.getBoundingClientRect();
    const hover = node && box ? resolveHover(o, node, e.clientY < box.top + box.height / 2, drag.item, drag.instrument) : null;
    const plan = hover ? planDrop(o, counts, drag.item, hover.over) : null;
    if (!hover || !plan) {
      e.dataTransfer.dropEffect = "none";
      planRef.current = null;
      store.set({ drop: null });
      setDragNote(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    planRef.current = plan;
    store.set({ drop: plan.move ? { id: hover.indicator.id, edge: hover.indicator.edge, refused: !!plan.refusal } : null });
    setDragNote(plan.refusal);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.preventDefault();
    const plan = planRef.current;
    handlers.dragEnd();
    // A refused drop still runs: the operation's own words say why.
    if (plan?.move) runMove(plan.move, false);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
      planRef.current = null;
      store.set({ drop: null });
      setDragNote(null);
    }
  };

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const moveByKeyboard = (node: TreeNode, dir: -1 | 1) => {
    if (!ctx.canEdit) {
      ctx.announce(ctx.readOnlyReason ?? "This draft can't be changed.");
      return;
    }
    const move =
      node.kind === "question" && node.question
        ? keyboardQuestionMove(o, node.question.itemKey, dir)
        : node.kind === "block" && node.block
          ? keyboardBlockMove(o, counts, node.block.sectionKey, node.block.componentIndex, dir)
          : node.kind === "section" && node.section
            ? keyboardSectionMove(o, node.section.key, dir)
            : null;
    if (!move) {
      if (node.kind === "question" || node.kind === "block" || node.kind === "section") {
        ctx.announce(dir < 0 ? "It is already at the start of the survey." : "It is already at the end of the survey.");
      }
      return;
    }
    runMove(move, true);
  };

  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const id = target.dataset["rowId"] ?? "";
    const i = tree.visible.findIndex((n) => n.id === id);
    const node = tree.visible[i];
    if (!node) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveByKeyboard(node, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
      e.preventDefault();
      openMenu(node.id, target.querySelector<HTMLElement>(":scope > .sto-row .sto-more") ?? target);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(tree.visible[i + 1]?.id);
        return;
      case "ArrowUp":
        e.preventDefault();
        focusRow(tree.visible[i - 1]?.id);
        return;
      case "Home":
        e.preventDefault();
        focusRow(tree.visible[0]?.id);
        return;
      case "End":
        e.preventDefault();
        focusRow(tree.visible[tree.visible.length - 1]?.id);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (node.expandable && !node.expanded) handlers.toggle(node.id);
        else if (node.expanded) focusRow(node.children[0]?.id);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (node.expandable && node.expanded && !tree.filtering) handlers.toggle(node.id);
        else if (node.parentId) focusRow(node.parentId);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        handlers.activate(node.id);
        return;
      default:
        // Typeahead: jump to the next row starting with what is typed.
        if (e.key.length === 1 && e.key !== "/" && e.key !== "?" && /\S/.test(e.key)) {
          const now = Date.now();
          typed.current = { text: now - typed.current.at < 700 ? typed.current.text + e.key : e.key, at: now };
          const j = typeahead(tree.visible, typed.current.text.length > 1 ? i - 1 : i, typed.current.text);
          if (j >= 0) {
            e.preventDefault();
            focusRow(tree.visible[j]!.id);
          }
        }
    }
  };

  // "/" focuses the search, from anywhere that isn't a text box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTextEntry(e.target) || document.getElementById("root")?.hasAttribute("inert")) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── The header's "Add question": after the selection, else at the end ───
  const addTarget = (): { sectionKey: string; afterItemKey: string | null; where: string } | null => {
    const sel = ctx.selection;
    if (sel?.kind === "question") {
      for (const s of o.sections) {
        for (const b of s.blocks) {
          const q = b.questions.find((x) => x.itemKey === sel.itemKey);
          if (q) return { sectionKey: s.key, afterItemKey: q.itemKey, where: `after ${quote(q.text, 40)}` };
        }
      }
    }
    if (sel?.kind === "section" || sel?.kind === "block") {
      const s = o.sections.find((x) => x.key === sel.sectionKey);
      if (s) {
        const block = sel.kind === "block" ? s.blocks.find((b) => b.componentIndex === sel.componentIndex) : null;
        const last = block?.questions[block.questions.length - 1];
        if (last && block) return { sectionKey: s.key, afterItemKey: last.itemKey, where: `after “${shortText(block.name, 40)}”` };
        return { sectionKey: s.key, afterItemKey: null, where: `at the end of ${s.title}` };
      }
    }
    const last = o.sections[o.sections.length - 1];
    return last ? { sectionKey: last.key, afterItemKey: null, where: `at the end of ${last.title}` } : null;
  };

  const setAll = (open: boolean) => {
    const next = new Map<string, boolean>();
    for (const s of o.sections) {
      next.set(`section:${s.key}`, open);
      for (const b of s.blocks) if (blockHasHeader(b)) next.set(blockExpandKey(s.key, b.refKey), open);
    }
    next.set("archive", open);
    setExpanded(next);
  };

  const filtering = tree.filtering;
  const problemCount = ctx.issues.length;
  const status = filtering
    ? tree.matches === 0
      ? "No questions match."
      : `${tree.matches === 1 ? "1 question matches" : `${tree.matches} questions match`}.`
    : "";

  return (
    <div
      ref={rootRef}
      className={`sto-outline${dragging ? " is-dragging" : ""}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
    >
      <div className="sto-head">
        <div className="sto-search">
          <Icon name="search" size={16} />
          <input
            ref={searchRef}
            type="search"
            className="st-input sto-search-input"
            placeholder="Search questions by text or ID"
            aria-label="Search questions by text or ID"
            aria-keyshortcuts="/"
            aria-controls="sto-tree"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                focusRow(tree.visible[0]?.id);
              }
            }}
          />
          {query ? (
            <IconButton icon="close" size="sm" label="Clear the search" onClick={() => setQuery("")} />
          ) : (
            <span className="sto-search-key" aria-hidden="true">
              <Kbd>/</Kbd>
            </span>
          )}
        </div>
        <div className="sto-chips" role="group" aria-label="Show only">
          <button type="button" className="sto-chip" aria-pressed={withProblems} onClick={() => setWithProblems((v) => !v)}>
            <Icon name={withProblems ? "check" : "warning"} size={14} />
            With problems
            {problemCount > 0 ? <span className="sto-chip-count">{problemCount}</span> : null}
          </button>
          <button type="button" className="sto-chip" aria-pressed={withConditions} onClick={() => setWithConditions((v) => !v)}>
            <Icon name={withConditions ? "check" : "branch"} size={14} />
            With conditions
          </button>
        </div>
        <div className="sto-actions">
          {canEdit ? (
            <Button
              size="sm"
              variant="primary"
              icon="plus"
              onClick={() => {
                const target = addTarget();
                if (target) setPending({ kind: "picker", ...target });
              }}
            >
              Add question
            </Button>
          ) : (
            <span />
          )}
          <span className="sto-tools-end">
            <IconButton icon="chevron-down" size="sm" label="Expand all" onClick={() => setAll(true)} disabled={filtering} />
            <IconButton icon="chevron-right" size="sm" label="Collapse all" onClick={() => setAll(false)} disabled={filtering} />
          </span>
        </div>
        {dragNote ? (
          <p className="sto-dragnote" role="note">
            <Icon name="warning" size={14} /> {dragNote}
          </p>
        ) : null}
        <p className="st-sr" role="status">
          {status}
        </p>
      </div>

      {tree.visible.length === 0 ? (
        <div className="sto-empty">
          <p>
            {deferredQuery.trim() ? <>No questions match &ldquo;{deferredQuery.trim()}&rdquo;</> : "Nothing matches these filters"}
            {withProblems && !deferredQuery.trim() ? " — no question has a problem." : "."}
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setQuery("");
              setWithProblems(false);
              setWithConditions(false);
            }}
          >
            Show everything
          </Button>
        </div>
      ) : (
        <RowContext.Provider value={rowContext}>
          <ul
            id="sto-tree"
            role="tree"
            aria-label="Survey outline"
            aria-describedby="sto-tree-help"
            className="sto-tree"
            onKeyDown={onTreeKeyDown}
            onFocus={(e) => {
              const id = (e.target as HTMLElement).dataset["rowId"];
              if (id) store.set({ active: id });
            }}
          >
            {tree.roots.map((node) => (
              <TreeItem key={node.id} node={node} />
            ))}
          </ul>
        </RowContext.Provider>
      )}
      <p id="sto-tree-help" className="st-sr">
        Arrow keys move between rows; Right and Left open and close. Enter opens a row in the editor.
        {canEdit ? " Alt with Up or Down moves the question, block or section. Shift+F10 lists its actions." : ""}
      </p>

      {menu ? (
        <RowMenu
          label={menu.label}
          items={menu.items}
          anchor={menu.anchor}
          onClose={closeMenu}
          onChoose={(action) => {
            const node = tree.byId.get(menu.id);
            setMenu(null);
            // Back on the row first, so a dialog this opens returns focus there.
            focusRow(menu.id);
            if (node) runAction(action, node);
          }}
        />
      ) : null}

      {pending?.kind === "picker" ? (
        <TypePicker
          where={pending.where}
          onClose={() => setPending(null)}
          onChoose={(typeId) => {
            const target = pending;
            setPending(null);
            addQuestionOf(typeId, target);
          }}
        />
      ) : null}

      {pending?.kind === "move" ? <MovePending node={pending.node} o={o} counts={counts} onDone={() => setPending(null)} runMove={runMove} /> : null}

      {pending?.kind === "confirm" ? (
        <ConfirmDialog
          title={pending.title}
          body={pending.body}
          confirmLabel={pending.confirmLabel}
          destructive={pending.destructive}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const run = pending.run;
            setPending(null);
            run();
          }}
        />
      ) : null}
      <VisuallyHidden>{dragging ? "Dragging. Drop on a row to move there." : ""}</VisuallyHidden>
    </div>
  );
}

/** "Move to section…" for a question or block, or "Restore into section…" for an archived question. */
function MovePending({
  node,
  o,
  counts,
  onDone,
  runMove,
}: {
  node: TreeNode;
  o: OutlineModel;
  counts: readonly number[];
  onDone: () => void;
  runMove: (move: MoveOp, focus: boolean) => void;
}) {
  const ctx = useEditor();
  if (node.kind === "archived" && node.archived) {
    const a = node.archived;
    return (
      <MoveDialog
        title="Restore into which section?"
        intro={`${quote(a.text)} goes back at the end of the section you choose, with the same ID.`}
        sections={o.sections}
        current={null}
        confirmLabel="Restore here"
        onClose={onDone}
        onMove={(sectionKey) => {
          onDone();
          const out: { itemKey?: string } = {};
          const ok = ctx.run("Restore question", (d) => {
            const r = restoreQuestion(d, a.itemKey, { sectionKey });
            out.itemKey = r.itemKey;
            return r.draft;
          });
          if (ok && out.itemKey) {
            ctx.select({ kind: "question", itemKey: out.itemKey });
            ctx.announce(`Restored ${quote(a.text)} into ${o.sections.find((s) => s.key === sectionKey)?.title ?? sectionKey}.`);
          }
        }}
      />
    );
  }
  if (node.question) {
    const q = node.question;
    return (
      <MoveDialog
        title="Move to which section?"
        intro={`${quote(q.text)} moves to the end of the section you choose. Its ID stays ${q.itemKey}, so its answers stay in the same column.`}
        sections={o.sections}
        current={q.sectionKey}
        confirmLabel="Move here"
        onClose={onDone}
        onMove={(sectionKey) => {
          onDone();
          const target = o.sections.find((s) => s.key === sectionKey);
          const size = target ? target.blocks.reduce((n, b) => n + b.questions.length, 0) : 0;
          runMove({ op: "question", itemKey: q.itemKey, to: { sectionKey, index: size } }, true);
        }}
      />
    );
  }
  if (node.block) {
    const b = node.block;
    return (
      <MoveDialog
        title="Move the block to which section?"
        intro={`“${shortText(b.name, 60)}” moves, whole, to the end of the section you choose.`}
        sections={o.sections}
        current={b.sectionKey}
        confirmLabel="Move here"
        onClose={onDone}
        onMove={(sectionKey) => {
          onDone();
          const target = o.sections.find((s) => s.key === sectionKey);
          runMove({ op: "block", from: { sectionKey: b.sectionKey, componentIndex: b.componentIndex }, to: { sectionKey, index: target ? (counts[target.index] ?? 0) : 0 } }, true);
        }}
      />
    );
  }
  return null;
}

/**
 * Conditions in words, worked out once per draft and only for the sections
 * and blocks that have one — describing a condition walks the survey, which
 * is worth doing once, not on every row render.
 */
function conditionDescriber(draft: StudioDraft): (sectionKey: string, componentIndex?: number) => string | null {
  const cache = new Map<string, string | null>();
  return (sectionKey, componentIndex) => {
    const key = componentIndex === undefined ? sectionKey : `${sectionKey}:${componentIndex}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const section = draft.composition.sections.find((s) => s.key === sectionKey);
    const holder = componentIndex === undefined ? section : section?.components[componentIndex];
    const expr = (holder as { displayIf?: unknown } | undefined)?.displayIf as LogicExpr | undefined;
    let text: string | null = null;
    if (expr) {
      try {
        text = describeCondition(expr, draft);
      } catch {
        text = "Shown only to some participants";
      }
    }
    cache.set(key, text);
    return text;
  };
}

/** Scroll the outline while a drag is held near its top or bottom edge. */
function autoScroll(root: HTMLElement | null, y: number) {
  const scroller = (root?.closest(".ste-left") as HTMLElement | null) ?? null;
  const scrolls = scroller && scroller.scrollHeight > scroller.clientHeight && getComputedStyle(scroller).overflowY !== "visible";
  const top = scrolls ? scroller.getBoundingClientRect().top : 0;
  const bottom = scrolls ? scroller.getBoundingClientRect().bottom : window.innerHeight;
  const zone = 56;
  // Below the sticky search header, which covers the top of the scroller.
  const head = root?.querySelector<HTMLElement>(".sto-head")?.getBoundingClientRect().bottom ?? top;
  const upper = Math.max(top, head);
  let delta = 0;
  if (y < upper + zone) delta = -Math.ceil((upper + zone - y) / 4);
  else if (y > bottom - zone) delta = Math.ceil((y - (bottom - zone)) / 4);
  if (delta === 0) return;
  if (scrolls) scroller.scrollTop += delta;
  else window.scrollBy(0, delta);
}
