import { createContext, memo, useContext, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { QUESTION_TYPES, type QuestionTypeId } from "@myself/studio";
import { Icon, type IconName } from "../../ui/icons.js";
import { VisuallyHidden } from "../../ui/kit.js";
import { rowDomId } from "./keys.js";
import { describeCount, hasIssues, tierPhrase, type IssueCount, type TreeNode } from "./model.js";
import { useRowState, type RowStore } from "./store.js";

/**
 * One outline row, as a WAI-ARIA treeitem.
 *
 * Memoised on the node's signature: a row re-renders only when something it
 * draws changed, or when its own selected / focused / drop state did (read
 * from the row store, not passed down). Everything a row does is sent to the
 * outline through a context whose functions never change identity, so the
 * handlers are never the reason a row re-renders.
 */

export interface RowHandlers {
  activate: (id: string) => void;
  toggle: (id: string) => void;
  openMenu: (id: string, anchor: HTMLElement) => void;
  dragStart: (id: string, e: ReactDragEvent<HTMLElement>) => void;
  dragEnd: () => void;
}

export const RowContext = createContext<{ handlers: RowHandlers; store: RowStore; canEdit: boolean } | null>(null);

export const TYPE_ICONS: Record<QuestionTypeId, IconName> = {
  short_text: "type-short",
  long_text: "type-long",
  single_choice: "type-single",
  dropdown: "type-dropdown",
  yes_no: "type-yesno",
  rating: "type-rating",
  slider: "type-slider",
  multiple_choice: "type-multi",
  number: "type-number",
  date: "type-date",
  info: "type-info",
  consent: "type-consent",
  ladder: "type-ladder",
  form_fields: "type-fields",
  rank_group: "type-rank",
};

const TYPE_LABELS = new Map(QUESTION_TYPES.map((t) => [t.id, t.label]));

/** Text with the search matches marked. */
export function Highlight({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{withPipes(text)}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(<span key={`t${i}`}>{withPipes(text.slice(at, a))}</span>);
    out.push(
      <mark key={`m${i}`} className="sto-mark">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) out.push(<span key="end">{withPipes(text.slice(at))}</span>);
  return <>{out}</>;
}

/**
 * Piped placeholders (`{first_name}`) drawn as placeholders, so a researcher
 * sees at a glance that the participant will see their own answer there.
 */
function withPipes(text: string): ReactNode {
  if (!text.includes("{")) return text;
  const parts = text.split(/(\{[a-z][a-z0-9_]*\})/g);
  return parts.map((p, i) =>
    /^\{[a-z][a-z0-9_]*\}$/.test(p) ? (
      <span key={i} className="sto-pipe">
        {p}
      </span>
    ) : (
      p
    ),
  );
}

export function IssueMarker({ count, id }: { count: IssueCount; id?: string }) {
  if (!hasIssues(count)) return null;
  const error = count.errors > 0;
  return (
    <span id={id} className={`sto-issue ${error ? "sto-issue-error" : "sto-issue-warn"}`} title={describeCount(count)}>
      <Icon name={error ? "error" : "warning"} size={14} />
      <span aria-hidden="true">{count.errors + count.warnings}</span>
      <VisuallyHidden>{describeCount(count)}</VisuallyHidden>
    </span>
  );
}

function rowIcon(node: TreeNode): IconName {
  switch (node.kind) {
    case "welcome":
      return "welcome";
    case "completion":
      return "flag";
    case "settings":
      return "settings";
    case "section":
      return "section";
    case "block":
      return node.block?.tier === "editable" ? (node.block.unlocked ? "unlock" : "branch") : "lock";
    case "question":
      return node.question ? TYPE_ICONS[node.question.studioType] : "type-info";
    case "add-question":
    case "add-section":
      return "plus";
    case "archive":
    case "archived":
      return "archive";
  }
}

function draggable(node: TreeNode, canEdit: boolean): boolean {
  if (!canEdit) return false;
  if (node.kind === "question") return node.question?.tier === "editable";
  if (node.kind === "block") return node.block?.tier !== "protected";
  if (node.kind === "section") return !node.section?.fixed;
  return false;
}

function hasMenu(node: TreeNode, canEdit: boolean): boolean {
  return canEdit && (node.kind === "question" || node.kind === "section" || node.kind === "block" || node.kind === "archived");
}

// Named `Item`, not `TreeItem`: inside a named function expression its own
// name is the UNmemoised function, so recursing through it would re-render
// every child of a section whenever the section itself changed.
export const TreeItem = memo(
  function Item({ node }: { node: TreeNode }) {
    const ctx = useContext(RowContext)!;
    const { handlers, store, canEdit } = ctx;
    const state = useRowState(store, node.id);
    const dom = rowDomId(node.id);
    const labelId = `${dom}-l`;
    const descId = `${dom}-d`;
    const issueId = `${dom}-i`;
    const canDrag = draggable(node, canEdit);
    const menu = hasMenu(node, canEdit);
    const isAdd = node.kind === "add-question" || node.kind === "add-section";

    const onRowClick = (e: ReactMouseEvent) => {
      if ((e.target as HTMLElement).closest(".sto-more, .sto-chev")) return;
      handlers.activate(node.id);
    };

    const described = [descId, hasIssues(node.issues) ? issueId : null].filter(Boolean).join(" ");
    const classes = [
      "sto-row",
      `sto-row-${node.kind}`,
      state.selected ? "is-selected" : "",
      state.drop ? `drop-${state.drop}` : "",
      state.refused ? "drop-refused" : "",
      canDrag ? "is-draggable" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <li
        role="treeitem"
        id={dom}
        className="sto-item"
        data-row-id={node.id}
        aria-level={node.level}
        aria-expanded={node.expandable ? node.expanded : undefined}
        aria-selected={node.selection ? state.selected : undefined}
        aria-labelledby={labelId}
        aria-describedby={described || undefined}
        tabIndex={state.active ? 0 : -1}
      >
        <div
          className={classes}
          style={{ ["--sto-level" as string]: node.level }}
          draggable={canDrag || undefined}
          onDragStart={canDrag ? (e) => handlers.dragStart(node.id, e) : undefined}
          onDragEnd={canDrag ? handlers.dragEnd : undefined}
          onClick={onRowClick}
          onContextMenu={
            menu
              ? (e) => {
                  e.preventDefault();
                  const button = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(".sto-more");
                  handlers.openMenu(node.id, button ?? (e.currentTarget as HTMLElement));
                }
              : undefined
          }
        >
          {canDrag ? (
            <span className="sto-grip" aria-hidden="true">
              <Icon name="grip" size={14} />
            </span>
          ) : null}
          {node.expandable ? (
            <span
              className="sto-chev"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                handlers.toggle(node.id);
              }}
            >
              <Icon name={node.expanded ? "chevron-down" : "chevron-right"} size={16} />
            </span>
          ) : (
            <span className="sto-chev-space" aria-hidden="true" />
          )}
          <span className={`sto-icon${isAdd ? " sto-icon-add" : ""}`} aria-hidden="true">
            <Icon name={rowIcon(node)} size={16} />
          </span>
          <RowText node={node} labelId={labelId} descId={descId} />
          <IssueMarker count={node.issues} id={issueId} />
          {menu ? (
            <button
              type="button"
              tabIndex={-1}
              className="st-iconbtn st-iconbtn-ghost st-iconbtn-sm sto-more"
              aria-label={`Actions for ${node.label}`}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                handlers.openMenu(node.id, e.currentTarget);
              }}
            >
              <Icon name="more" size={16} />
            </button>
          ) : null}
        </div>
        {node.expanded && node.children.length > 0 ? (
          <ul role="group" className="sto-group">
            {node.children.map((child) => (
              <TreeItem key={child.id} node={child} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  },
  (a, b) => a.node.treeSig === b.node.treeSig && a.node.id === b.node.id,
);

function RowText({ node, labelId, descId }: { node: TreeNode; labelId: string; descId: string }) {
  switch (node.kind) {
    case "question": {
      const q = node.question!;
      return (
        <span className="sto-main">
          <span className="sto-text" id={labelId}>
            {q.text.trim() ? <Highlight text={q.text} ranges={node.textMatch} /> : <em>(No question text yet)</em>}
          </span>
          <span className="sto-meta sto-meta-line" id={descId}>
            <VisuallyHidden>{TYPE_LABELS.get(q.studioType) ?? "Question"}, question {q.number}, ID </VisuallyHidden>
            <span className="sto-num" aria-hidden="true">
              {q.number}
            </span>
            <code className="sto-id" title={q.itemKey}>
              <Highlight text={q.itemKey} ranges={node.idMatch} />
            </code>
            {q.required === "hard" ? <span className="sto-flag">Required</span> : null}
            {q.hasCondition ? (
              <span className="sto-flag">
                <Icon name="branch" size={12} />
                Condition
              </span>
            ) : null}
            {q.identifying ? (
              <span className="sto-flag">
                <Icon name="user" size={12} />
                Identifying
              </span>
            ) : null}
          </span>
        </span>
      );
    }
    case "section": {
      const s = node.section!;
      return (
        <span className="sto-main">
          <span className="sto-text sto-text-strong" id={labelId}>
            <Highlight text={node.label} ranges={node.textMatch} />
          </span>
          <span className="sto-meta" id={descId}>
            <span>{s.questionCount === 1 ? "1 question" : `${s.questionCount} questions`}</span>
            {s.condition ? (
              <span className="sto-flag sto-flag-wrap" title={s.condition}>
                <Icon name="branch" size={12} />
                {s.condition}
              </span>
            ) : null}
            {s.fixed ? <VisuallyHidden>. Holds a protected module, so its place is fixed</VisuallyHidden> : null}
          </span>
        </span>
      );
    }
    case "block": {
      const b = node.block!;
      return (
        <span className="sto-main">
          <span className="sto-text sto-text-strong" id={labelId}>
            <Highlight text={b.name} ranges={node.textMatch} />
            <VisuallyHidden> ({tierPhrase(b)})</VisuallyHidden>
          </span>
          <span className="sto-meta" id={descId}>
            {b.tier !== "editable" || b.unlocked ? (
              <span className={`sto-tier sto-tier-${b.tier}`} aria-hidden="true">
                {capitalise(tierPhrase(b))}
              </span>
            ) : null}
            <span>{b.questionCount === 1 ? "1 question" : `${b.questionCount} questions`}</span>
            {b.condition ? (
              <span className="sto-flag sto-flag-wrap" title={b.condition}>
                <Icon name="branch" size={12} />
                {b.condition}
              </span>
            ) : null}
          </span>
        </span>
      );
    }
    case "archived": {
      const a = node.archived!;
      return (
        <span className="sto-main">
          <span className="sto-text" id={labelId}>
            <Highlight text={a.text} ranges={node.textMatch} />
          </span>
          <span className="sto-meta" id={descId}>
            <VisuallyHidden>Archived question, ID </VisuallyHidden>
            <code className="sto-id">
              <Highlight text={a.itemKey} ranges={node.idMatch} />
            </code>
          </span>
        </span>
      );
    }
    case "add-question":
      return (
        <span className="sto-main">
          <span className="sto-text sto-text-add" id={labelId}>
            <span aria-hidden="true">Add question</span>
            <VisuallyHidden>{node.label}</VisuallyHidden>
          </span>
        </span>
      );
    case "add-section":
      return (
        <span className="sto-main">
          <span className="sto-text sto-text-add" id={labelId}>
            Add section
          </span>
        </span>
      );
    default:
      return (
        <span className="sto-main">
          <span className="sto-text sto-text-strong" id={labelId}>
            <Highlight text={node.label} ranges={node.textMatch} />
          </span>
        </span>
      );
  }
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
