import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { outline, summariseIssues, type Issue } from "@myself/studio";
import { Icon } from "../ui/icons.js";
import { Button, EmptyState, IconButton, Spinner } from "../ui/kit.js";
import { useEditor } from "./context.js";
import { VALIDATION_PANEL_ID, VALIDATION_TOGGLE_ID } from "./Toolbar.js";
import { groupIssues, selectionFor, type IssueGroup } from "./validation/select.js";
import "./validation.css";

/**
 * Every problem with the draft, in one list, with a way to each.
 *
 * A drawer beside the editor rather than a modal: a researcher works through
 * the list, jumping to each problem and fixing it, and needs the editor live
 * while they do. It takes focus when it opens and gives it back when it
 * closes; Escape closes it. The issues are the ones the toolbar counts and
 * publishing is judged by — validation runs once, in the editor context.
 */
export function ValidationPanel() {
  const { validationOpen } = useEditor();
  return validationOpen ? <Panel /> : null;
}

/** Field names as a researcher would call them, for "Go to" buttons' names. */
const FIELD_WORDS: Record<string, string> = {
  stem: "question text",
  lede: "introduction",
  moreInfo: "more information",
  variable: "reporting label",
  key: "question ID",
  responseType: "question type",
  required: "required setting",
  identifying: "identifying setting",
  options: "options",
  statements: "statements",
  groups: "groups",
  fields: "fields",
  min: "minimum",
  step: "step",
  rungs: "rungs",
  pattern: "answer format",
  minYear: "earliest year",
  minAgeYears: "age limits",
  maxSelections: "most selections",
  maxChars: "length limit",
  scale: "options",
  displayIf: "condition",
  crossChecks: "answer checks",
  limitOptions: "options offered",
  title: "title",
  components: "blocks",
  items: "questions",
};

function fieldWord(field: string | undefined): string | null {
  if (!field) return null;
  if (field.startsWith("participantCode")) return "participant code";
  if (field.startsWith("screens")) return "completion text";
  return FIELD_WORDS[field] ?? null;
}

function Panel() {
  const ctx = useEditor();
  const o = useMemo(() => outline(ctx.draft), [ctx.draft]);
  const grouped = useMemo(() => groupIssues(ctx.issues, o), [ctx.issues, o]);
  const counts = summariseIssues(ctx.issues);
  const panel = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const opener = useRef<Element | null>(null);
  const returnFocus = useRef(true);

  // Sit below the toolbar, whatever the banners above it add up to.
  useLayoutEffect(() => {
    const place = () => {
      const bar = document.querySelector(".sto-toolbar");
      const top = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
      panel.current?.style.setProperty("--sto-vp-top", `${top}px`);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, []);

  useEffect(() => {
    opener.current = document.activeElement;
    heading.current?.focus();
    return () => {
      if (!returnFocus.current) return;
      const back = opener.current instanceof HTMLElement && opener.current.isConnected ? opener.current : document.getElementById(VALIDATION_TOGGLE_ID);
      back?.focus();
    };
  }, []);

  const close = () => {
    returnFocus.current = true;
    ctx.setValidationOpen(false);
  };

  const goTo = (issue: Issue) => {
    const field = issue.location.field;
    ctx.select(selectionFor(issue, o), field ? { field } : undefined);
    // On a narrow screen the sheet covers the editor, and on any screen it
    // covers the settings panel: if the field the editor moves to ends up
    // underneath, get out of the way rather than leave it hidden.
    const check = () => {
      const node = panel.current;
      if (!node) return;
      const hide = () => {
        returnFocus.current = false;
        ctx.setValidationOpen(false);
      };
      if (window.matchMedia("(max-width: 760px)").matches) {
        hide();
        return;
      }
      const el = document.activeElement;
      if (!el || el === document.body || node.contains(el)) return;
      const box = node.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom) hide();
    };
    window.setTimeout(check, 180);
    window.setTimeout(check, 500);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  const total = counts.errors + counts.warnings;
  const summary = !ctx.issuesFresh
    ? "Checking…"
    : total === 0
      ? "No problems"
      : [counts.errors > 0 ? plural(counts.errors, "error") : null, counts.warnings > 0 ? plural(counts.warnings, "warning") : null]
          .filter(Boolean)
          .join(" · ");

  return (
    <section
      ref={panel}
      id={VALIDATION_PANEL_ID}
      role="dialog"
      aria-modal="false"
      aria-labelledby="sto-vp-title"
      className="sto-vp"
      onKeyDown={onKeyDown}
    >
      <header className="sto-vp-head">
        <h2 id="sto-vp-title" ref={heading} tabIndex={-1}>
          Checks
        </h2>
        <IconButton icon="close" label="Close checks" onClick={close} />
      </header>
      <div className="sto-vp-body">
        <p className={`sto-vp-summary${counts.errors > 0 ? " has-errors" : counts.warnings > 0 ? " has-warnings" : ""}`} role="status">
          {!ctx.issuesFresh ? <Spinner /> : <Icon name={counts.errors > 0 ? "error" : total > 0 ? "warning" : "check"} size={18} />}
          <strong>{summary}</strong>
        </p>
        <p className="sto-vp-lede">Errors must be fixed before publishing. Warnings are worth a look but don&rsquo;t block it.</p>
        <p className="sto-vp-lede sto-vp-quiet">
          Branching in MySelf shows or hides questions based on earlier answers, so every path moves forward to the end; the
          checks below cover conditions that point at later or missing questions.
        </p>
        {total === 0 ? (
          <EmptyState icon="check" title="Everything checks out">
            <p>Nothing stops this draft being published.</p>
          </EmptyState>
        ) : (
          <>
            {grouped.errors.length > 0 ? <IssueList title="Errors" count={counts.errors} groups={grouped.errors} severity="error" onGo={goTo} /> : null}
            {grouped.warnings.length > 0 ? (
              <IssueList title="Warnings" count={counts.warnings} groups={grouped.warnings} severity="warning" onGo={goTo} />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

export function IssueList({
  title,
  count,
  groups,
  severity,
  onGo,
}: {
  title: string;
  count: number;
  groups: IssueGroup[];
  severity: "error" | "warning";
  onGo: (issue: Issue) => void;
}) {
  return (
    <section className={`sto-vp-sev sto-vp-${severity}`} aria-labelledby={`sto-vp-${severity}`}>
      <h3 id={`sto-vp-${severity}`}>
        <Icon name={severity === "error" ? "error" : "warning"} size={16} />
        {title} <span className="sto-vp-count">{count}</span>
      </h3>
      {groups.map((g) => (
        <div key={g.id} className="sto-vp-group">
          <h4>
            {g.label}
            {g.context ? <span className="sto-vp-context"> in {g.context}</span> : null}
          </h4>
          <ul>
            {g.issues.map((issue, i) => {
              const word = fieldWord(issue.location.field);
              return (
                <li key={`${issue.code}:${i}`}>
                  <span className="sto-vp-message">{issue.message}</span>
                  <Button size="sm" variant="secondary" onClick={() => onGo(issue)} aria-label={`Go to ${word ? `the ${word} of ` : ""}${g.label}`}>
                    Go to
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
