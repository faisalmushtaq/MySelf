import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { outline, summariseIssues, type Issue } from "@myself/studio";
import { Icon } from "../ui/icons.js";
import { Button, EmptyState, IconButton, InfoTip, Spinner } from "../ui/kit.js";
import { useEditor } from "./context.js";
import { VALIDATION_PANEL_ID, VALIDATION_TOGGLE_ID } from "./Toolbar.js";
import { IssueText } from "./node/controls.js";
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
  // Each count in its own colour — errors red, warnings amber — with the words saying the same.
  const parts = [
    counts.errors > 0 ? <span key="e" className="sto-vp-sum-err">{plural(counts.errors, "error")}</span> : null,
    counts.warnings > 0 ? <span key="w" className="sto-vp-sum-warn">{plural(counts.warnings, "warning")}</span> : null,
  ].filter(Boolean);
  const summary = !ctx.issuesFresh ? (
    "Checking…"
  ) : total === 0 ? (
    "No errors or warnings"
  ) : (
    <>
      {parts[0]}
      {parts.length > 1 ? (
        <span className="sto-vp-sum-sep" aria-hidden="true">
          ·
        </span>
      ) : null}
      {parts[1]}
    </>
  );

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
        <div className="sto-vp-title">
          <h2 id="sto-vp-title" ref={heading} tabIndex={-1}>
            Checks
          </h2>
          <InfoTip
            label="checks"
            text="Errors must be fixed before publishing; warnings don’t block it. Branching only shows or hides questions based on earlier answers, so every path moves forward — these checks cover conditions that point at later or missing questions."
          />
        </div>
        <p className="sto-vp-summary" role="status">
          {!ctx.issuesFresh ? <Spinner /> : null}
          {summary}
        </p>
        <IconButton icon="close" label="Close checks" onClick={close} />
      </header>
      <div className="sto-vp-body">
        {total === 0 ? (
          <EmptyState icon="check" title="All checks passed">
            <p>Nothing blocks publishing.</p>
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

/**
 * One severity's issues, grouped by the place they are about (in survey
 * order): the place as a quiet line, then a row per issue — its icon, its
 * message and a way to it.
 */
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
        {title} <span className="sto-vp-count">{count}</span>
      </h3>
      {groups.map((g) => (
        <div key={g.id} className="sto-vp-group">
          <h4>
            <span className="sto-vp-place">{g.label}</span>
            {g.context ? <span className="sto-vp-context"> in {g.context}</span> : null}
          </h4>
          <ul>
            {g.issues.map((issue, i) => {
              const word = fieldWord(issue.location.field);
              return (
                <li key={`${issue.code}:${i}`}>
                  <Icon name={severity === "error" ? "error" : "warning"} size={16} />
                  <span className="sto-vp-message">
                    <IssueText issue={issue} label="this check" />
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => onGo(issue)} aria-label={`Go to ${word ? `the ${word} of ` : ""}${g.label}`}>
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
