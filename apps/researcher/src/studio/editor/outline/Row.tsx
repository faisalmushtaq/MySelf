import { createContext, memo, useContext, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { QUESTION_TYPES, type QuestionTypeId } from "@myself/studio";
import { Icon, type IconName } from "../../ui/icons.js";
import { VisuallyHidden } from "../../ui/kit.js";
import { rowDomId } from "./keys.js";
import { UNTITLED_QUESTION, describeCount, hasIssues, tierPhrase, type IssueCount, type TreeNode } from "./model.js";
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
  time_grid: "type-time",
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
    <span id={id} className={`sto-ind sto-issue ${error ? "sto-issue-error" : "sto-issue-warn"}`} data-tip={capitalise(describeCount(count))}>
      <Icon name={error ? "error" : "warning"} size={14} />
      <span aria-hidden="true">{count.errors + count.warnings}</span>
      <VisuallyHidden>{describeCount(count)}</VisuallyHidden>
    </span>
  );
}

/**
 * A trailing indicator: a 14px icon whose name is on hover (a CSS tooltip, so
 * 150 rows carry no tooltip state) and, for screen readers, in the row's
 * description — the icon itself is decorative.
 */
function Indicator({ icon, tip }: { icon: IconName | "asterisk"; tip: string }) {
  return (
    <span className="sto-ind" data-tip={tip} aria-hidden="true">
      {icon === "asterisk" ? (
        <svg viewBox="0 0 20 20" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true" focusable="false" className="st-icon">
          <path d="M10 4.5v11M5.2 7.25l9.6 5.5M5.2 12.75l9.6-5.5" />
        </svg>
      ) : (
        <Icon name={icon} size={14} />
      )}
    </span>
  );
}

function rowIcon(node: TreeNode): IconName {
  switch (node.kind) {
    case "welcome":
      return "welcome";
    case "completion":
      return "flag";
    case "mystory":
      return "story";
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

    const hasDesc = node.kind === "question" || node.kind === "section" || node.kind === "block" || node.kind === "archived";
    const described = [hasDesc ? descId : null, hasIssues(node.issues) ? issueId : null].filter(Boolean).join(" ");
    const header = isHeader(node);
    const classes = [
      "sto-row",
      `sto-row-${node.kind}`,
      header ? "is-header" : "",
      idOnlyMatch(node) ? "has-id-match" : "",
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
        className={`sto-item sto-item-${node.kind}`}
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
          // Sections are headers and their rows sit flush beneath them; only a
          // block's own questions step in, under the block's name.
          style={{ ["--sto-indent" as string]: `${Math.max(0, node.level - 2) * 24}px` }}
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
          {header ? null : (
            <span className={`sto-icon${isAdd ? " sto-icon-add" : ""}`} aria-hidden="true" data-tip={iconTip(node)}>
              <Icon name={rowIcon(node)} size={node.kind === "block" ? 14 : 16} />
            </span>
          )}
          <span className="sto-main">
            <RowText node={node} labelId={labelId} descId={descId} />
            {node.expandable ? (
              <span
                className="sto-chev"
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.toggle(node.id);
                }}
              >
                <Icon name={node.expanded ? "chevron-down" : "chevron-right"} size={14} />
              </span>
            ) : null}
          </span>
          <Trailing node={node} issueId={issueId} />
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
          ) : isAdd ? null : (
            <span className="sto-more-space" aria-hidden="true" />
          )}
        </div>
        {node.expanded && node.children.length > 0 ? (
          <ul role="group" className={`sto-group sto-group-${node.kind}`}>
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

/**
 * The search found this row by its ID alone, so the ID is shown (with the
 * match marked) — otherwise its text, already on the row, says why it is here.
 */
function idOnlyMatch(node: TreeNode): boolean {
  return node.idMatch.length > 0 && node.textMatch.length === 0;
}

/** Sections and the archive are drawn as quiet group headers rather than rows with an icon. */
function isHeader(node: TreeNode): boolean {
  return node.kind === "section" || node.kind === "archive";
}

/** What a block's lock (or branch) means, on hover; the row's name says it for screen readers. */
function iconTip(node: TreeNode): string | undefined {
  if (node.kind !== "block" || !node.block) return undefined;
  const b = node.block;
  if (b.tier === "editable" && !b.unlocked && b.condition) return b.condition;
  return capitalise(tierPhrase(b));
}

const count = (n: number) => (n === 1 ? "1 question" : `${n} questions`);

/**
 * The right-hand end of a row: a question's number and ID (on hover and
 * selection), its indicators, its problems, and for a group its size. Icons
 * only; what each means is on hover and in the row's description.
 */
function Trailing({ node, issueId }: { node: TreeNode; issueId: string }) {
  const issues = <IssueMarker count={node.issues} id={issueId} />;
  switch (node.kind) {
    case "question": {
      const q = node.question!;
      return (
        <span className="sto-trail">
          <span className="sto-qmeta" aria-hidden="true">
            {idOnlyMatch(node) ? (
              <code className="sto-id" title={q.itemKey}>
                <Highlight text={q.itemKey} ranges={node.idMatch} />
              </code>
            ) : null}
            <span className="sto-num">{q.number}</span>
          </span>
          {q.required === "hard" ? <Indicator icon="asterisk" tip="Required" /> : null}
          {q.hasCondition ? <Indicator icon="branch" tip="Has a condition" /> : null}
          {q.identifying ? <Indicator icon="user" tip="Identifying" /> : null}
          {issues}
        </span>
      );
    }
    case "archived":
      return (
        <span className="sto-trail">
          <span className="sto-qmeta" aria-hidden="true">
            <code className="sto-id" title={node.archived!.itemKey}>
              <Highlight text={node.archived!.itemKey} ranges={node.idMatch} />
            </code>
          </span>
        </span>
      );
    case "section": {
      const s = node.section!;
      return (
        <span className="sto-trail">
          {s.condition ? <Indicator icon="branch" tip={s.condition} /> : null}
          {issues}
          <span className="sto-count" aria-hidden="true">
            {s.questionCount}
          </span>
        </span>
      );
    }
    case "block": {
      const b = node.block!;
      return (
        <span className="sto-trail">
          {b.condition && b.tier !== "editable" ? <Indicator icon="branch" tip={b.condition} /> : null}
          {issues}
          <span className="sto-count" aria-hidden="true">
            {b.questionCount}
          </span>
        </span>
      );
    }
    case "archive":
      return (
        <span className="sto-trail">
          <span className="sto-count" aria-hidden="true">
            {node.label.replace(/\D+/g, "")}
          </span>
        </span>
      );
    default:
      return hasIssues(node.issues) ? <span className="sto-trail">{issues}</span> : null;
  }
}

/**
 * The row's name (its accessible name, by id) and, visually hidden, its
 * description: everything the trailing icons and hover-only meta show, in
 * words, so nothing is only seen.
 */
function RowText({ node, labelId, descId }: { node: TreeNode; labelId: string; descId: string }) {
  switch (node.kind) {
    case "question": {
      const q = node.question!;
      const flags = [q.required === "hard" ? "required" : null, q.hasCondition ? "has a condition" : null, q.identifying ? "identifying" : null].filter(Boolean);
      return (
        <>
          <span className="sto-text" id={labelId} title={q.text.trim() || undefined}>
            {q.text.trim() ? <Highlight text={q.text} ranges={node.textMatch} /> : <em>{UNTITLED_QUESTION}</em>}
          </span>
          <span id={descId} className="st-sr">
            {TYPE_LABELS.get(q.studioType) ?? "Question"}, question {q.number}, ID {q.itemKey}
            {flags.length > 0 ? `, ${flags.join(", ")}` : ""}
          </span>
        </>
      );
    }
    case "section": {
      const s = node.section!;
      return (
        <>
          <span className="sto-text" id={labelId}>
            <Highlight text={node.label} ranges={node.textMatch} />
          </span>
          <span id={descId} className="st-sr">
            {count(s.questionCount)}
            {s.condition ? `. ${s.condition}` : ""}
            {s.fixed ? ". Holds a protected module, so its place is fixed" : ""}
          </span>
        </>
      );
    }
    case "block": {
      const b = node.block!;
      return (
        <>
          <span className="sto-text" id={labelId} title={b.name}>
            <Highlight text={b.name} ranges={node.textMatch} />
            <VisuallyHidden> ({tierPhrase(b)})</VisuallyHidden>
          </span>
          <span id={descId} className="st-sr">
            {count(b.questionCount)}
            {b.condition ? `. ${b.condition}` : ""}
          </span>
        </>
      );
    }
    case "archived": {
      const a = node.archived!;
      return (
        <>
          <span className="sto-text" id={labelId} title={a.text}>
            <Highlight text={a.text} ranges={node.textMatch} />
          </span>
          <span id={descId} className="st-sr">Archived question, ID {a.itemKey}</span>
        </>
      );
    }
    case "archive":
      return (
        <span className="sto-text" id={labelId}>
          Archived
          <VisuallyHidden> {node.label.slice("Archived".length).trim()}</VisuallyHidden>
        </span>
      );
    case "add-question":
      return (
        <span className="sto-text sto-text-add" id={labelId}>
          <span aria-hidden="true">Add question</span>
          <VisuallyHidden>{node.label}</VisuallyHidden>
        </span>
      );
    case "add-section":
      return (
        <span className="sto-text sto-text-add" id={labelId}>
          Add section
        </span>
      );
    default:
      return (
        <span className="sto-text" id={labelId}>
          <Highlight text={node.label} ranges={node.textMatch} />
        </span>
      );
  }
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
