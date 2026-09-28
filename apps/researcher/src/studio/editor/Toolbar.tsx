import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { diffDrafts, summariseIssues, type StudioDraft } from "@myself/studio";
import { usePresence, type SaveState } from "../data/index.js";
import { formatTime, toDate, versionLabel } from "../format.js";
import { Link, useRoute, type Route } from "../router.js";
import { Dialog } from "../ui/dialog.js";
import { Icon } from "../ui/icons.js";
import { IconButton, Kbd, Spinner, Tooltip, VisuallyHidden } from "../ui/kit.js";
import { useToast } from "../ui/toast.js";
import { useEditor } from "./context.js";
import { isTextEntry, modKey } from "./outline/keys.js";
import "./toolbar.css";

/**
 * The editor's toolbar: which survey this is and what is live, whether the
 * work is saved, undo and redo, whether anything is wrong, who else is here,
 * and the two ways out — Preview and Publish.
 *
 * Every state is said in words (and usually an icon), never by colour alone,
 * and the save status sits in a polite live region so a screen-reader user
 * hears "Saved" or "Save failed" without having to go looking.
 */

export const VALIDATION_TOGGLE_ID = "sto-validation-toggle";
export const VALIDATION_PANEL_ID = "sto-validation";

export function Toolbar() {
  const ctx = useEditor();
  const [shortcuts, setShortcuts] = useState(false);
  useEditorShortcuts(() => setShortcuts(true));
  const title = ctx.draft.composition.title;

  return (
    <div className="sto-toolbar" role="region" aria-label="Survey toolbar">
      <div className="sto-tb-id">
        <h1 className="sto-title" title={title}>
          {title}
        </h1>
        <div className="sto-tb-meta">
          <LiveVersion />
          <DraftStatus />
        </div>
      </div>
      <div className="sto-tb-actions">
        <SaveStatus />
        <UndoRedo />
        <span className="sto-tb-sep" aria-hidden="true" />
        <ValidationBadge />
        {ctx.playground ? null : <Presence />}
        <PreviewLink />
        <PublishButton />
        <Tooltip text="Keyboard shortcuts (?)">
          <button
            type="button"
            className="st-iconbtn st-iconbtn-ghost st-iconbtn-md sto-help"
            aria-label="Keyboard shortcuts"
            aria-haspopup="dialog"
            aria-keyshortcuts="?"
            onClick={() => setShortcuts(true)}
          >
            ?
          </button>
        </Tooltip>
      </div>
      {shortcuts ? <ShortcutsDialog playground={ctx.playground} onClose={() => setShortcuts(false)} /> : null}
    </div>
  );
}

// ── What is live, and whether the draft differs ─────────────────────────

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "28 Sep" this year, "28 Sep 2025" otherwise. */
function publishedOn(d: Date | null): string | null {
  if (!d) return null;
  return (d.getFullYear() === new Date().getFullYear() ? shortDate : longDate).format(d);
}

function LiveVersion() {
  const ctx = useEditor();
  const active = ctx.survey?.active ?? ctx.published?.active ?? null;
  if (!active) {
    return ctx.publishedStatus === "loading" ? <span>Checking what&rsquo;s live…</span> : <span>Not published yet</span>;
  }
  const on = publishedOn(toDate(active.publishedAt));
  return (
    <span className="sto-live">
      <Icon name="flag" size={14} />
      <span>
        Live: <strong>{versionLabel(active.version)}</strong>
        {on ? ` · published ${on}` : ""}
      </span>
    </span>
  );
}

const DIFF_DELAY_MS = 900;

/**
 * Whether the draft differs from the live version. Comparing a 150-question
 * survey takes tens of milliseconds, so it runs once typing has paused rather
 * than on every keystroke, and keeps saying the last answer meanwhile.
 */
function useMatchesLive(draft: StudioDraft, baseline: StudioDraft | null, ready: boolean): boolean | null {
  const [result, setResult] = useState<{ draft: StudioDraft; baseline: StudioDraft | null; same: boolean } | null>(null);
  useEffect(() => {
    if (!ready || !baseline) return;
    if (result && result.draft === draft && result.baseline === baseline) return;
    const timer = window.setTimeout(() => {
      setResult({ draft, baseline, same: diffDrafts(baseline, draft).bump === null });
    }, result ? DIFF_DELAY_MS : 150);
    return () => window.clearTimeout(timer);
  }, [draft, baseline, ready, result]);
  if (!result || result.baseline !== baseline) return null;
  // REVIEW FIX: "keeps saying the last answer meanwhile" meant that for a
  // second after the first change to a draft that matched, the toolbar still
  // said "Draft matches the live version" — untrue, about the one thing a
  // publisher reads it for. "Has changes" can stand while typing continues (it
  // is almost always still true, and flickering would be worse); "matches"
  // is only said of the draft it was worked out for.
  if (result.same && result.draft !== draft) return null;
  return result.same;
}

function DraftStatus() {
  const ctx = useEditor();
  const baseline = ctx.published?.baseline ?? null;
  const same = useMatchesLive(ctx.draft, baseline, ctx.publishedStatus === "ready");
  if (ctx.publishedStatus !== "ready" || !baseline) return null;
  if (same === null) return <span>Comparing with the live version…</span>;
  return same ? (
    <span className="sto-draft-same">
      <Icon name="check" size={14} /> Draft matches the live version
    </span>
  ) : (
    <span className="sto-draft-changed">
      <Icon name="info" size={14} /> Draft has changes not yet published
    </span>
  );
}

// ── Saving ───────────────────────────────────────────────────────────────

function saveText(save: SaveState): { icon: "check" | "warning" | "error" | "offline" | "info" | null; text: string; busy?: boolean; tone: string } {
  switch (save.kind) {
    case "saved":
      return { icon: "check", text: save.at ? `Saved at ${formatTime(save.at)}` : "Saved", tone: "ok" };
    case "saving":
      return { icon: null, text: "Saving…", busy: true, tone: "busy" };
    case "unsaved":
      return { icon: "info", text: "Unsaved changes", tone: "pending" };
    case "offline":
      return { icon: "offline", text: "Offline — kept in this tab", tone: "warn" };
    case "error":
      return { icon: "error", text: "Save failed", tone: "warn" };
    case "conflict":
      return { icon: "warning", text: "Not saved: someone else saved first — see the message above", tone: "warn" };
  }
}

function SaveStatus() {
  const ctx = useEditor();
  const box = useRef<HTMLSpanElement | null>(null);
  if (ctx.playground) {
    return (
      <span className="sto-save sto-save-pending" role="status">
        <Icon name="info" size={16} /> Nothing is saved in the playground
      </span>
    );
  }
  const save = ctx.editor.save;
  const s = saveText(save);
  return (
    <span className={`sto-save sto-save-${s.tone}`} ref={box} tabIndex={-1}>
      <span role="status" className="sto-save-text">
        {s.busy ? <Spinner /> : s.icon ? <Icon name={s.icon} size={16} /> : null}
        <span>{s.text}</span>
      </span>
      {save.kind === "error" ? (
        <button
          type="button"
          className="st-btn st-btn-ghost st-btn-sm sto-retry"
          onClick={() => {
            // REVIEW FIX: Retry disappears as soon as the save starts, which
            // dropped focus to the page; it moves to the status it reports to.
            box.current?.focus();
            void ctx.editor.saveNow();
          }}
          title={save.message}
        >
          Retry
        </button>
      ) : null}
    </span>
  );
}

// ── Undo and redo ────────────────────────────────────────────────────────

function UndoRedo() {
  const ctx = useEditor();
  const { editor, canEdit } = ctx;
  const undo = editor.undoLabel ? `Undo ${lowerFirst(editor.undoLabel)}` : "Undo";
  const redo = editor.redoLabel ? `Redo ${lowerFirst(editor.redoLabel)}` : "Redo";
  // REVIEW FIX: aria-disabled, not disabled. Undoing the last change with the
  // keyboard disabled the very button that had focus, and a disabled button
  // drops focus to the page — the next Tab started again from the top.
  const noUndo = !canEdit || !editor.canUndo;
  const noRedo = !canEdit || !editor.canRedo;
  return (
    <span className="sto-undo">
      <IconButton
        icon="undo"
        label={`${undo} (${modKey()}+Z)`}
        aria-disabled={noUndo || undefined}
        onClick={() => {
          if (!noUndo) editor.undo();
        }}
      />
      <IconButton
        icon="redo"
        label={`${redo} (${modKey()}+Shift+Z)`}
        aria-disabled={noRedo || undefined}
        onClick={() => {
          if (!noRedo) editor.redo();
        }}
      />
    </span>
  );
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLocaleLowerCase("en-GB") + s.slice(1) : s;
}

/**
 * Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) undo and redo changes to the
 * survey — except while typing in a text box, where they belong to the
 * browser's own text undo, which is what anyone typing expects. "?" opens the
 * list of shortcuts. Nothing fires while a dialog is open.
 */
function useEditorShortcuts(openShortcuts: () => void) {
  const ctx = useEditor();
  const ref = useRef(ctx);
  ref.current = ctx;
  const openRef = useRef(openShortcuts);
  openRef.current = openShortcuts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.getElementById("root")?.hasAttribute("inert")) return;
      const { editor, canEdit } = ref.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // Ctrl+Y is redo on Windows and Linux only; Cmd+Y means something else on a Mac.
      const action = !mod || e.altKey ? null : key === "z" ? (e.shiftKey ? "redo" : "undo") : key === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey ? "redo" : null;
      if (action) {
        if (isTextEntry(e.target)) return;
        e.preventDefault();
        if (!canEdit) return;
        if (action === "redo") {
          if (editor.canRedo) editor.redo();
        } else if (editor.canUndo) editor.undo();
        return;
      }
      if (e.key === "?" && !mod && !e.altKey && !isTextEntry(e.target)) {
        e.preventDefault();
        openRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// ── Validation ───────────────────────────────────────────────────────────

function ValidationBadge() {
  const ctx = useEditor();
  const { errors, warnings } = summariseIssues(ctx.issues);
  let content: ReactNode;
  let tone = "ok";
  if (!ctx.issuesFresh) {
    content = (
      <>
        <Spinner /> <span>Checking…</span>
      </>
    );
    tone = "busy";
  } else if (errors + warnings === 0) {
    content = (
      <>
        <Icon name="check" size={16} /> <span>No problems</span>
      </>
    );
  } else {
    tone = errors > 0 ? "error" : "warn";
    const parts = [errors > 0 ? `${errors} ${errors === 1 ? "error" : "errors"}` : null, warnings > 0 ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : null].filter(Boolean);
    content = (
      <>
        <Icon name={errors > 0 ? "error" : "warning"} size={16} /> <span>{parts.join(" · ")}</span>
      </>
    );
  }
  return (
    <button
      id={VALIDATION_TOGGLE_ID}
      type="button"
      className={`st-btn st-btn-sm sto-checks sto-checks-${tone}`}
      aria-expanded={ctx.validationOpen}
      aria-controls={ctx.validationOpen ? VALIDATION_PANEL_ID : undefined}
      onClick={() => ctx.setValidationOpen(!ctx.validationOpen)}
    >
      <VisuallyHidden>Checks: </VisuallyHidden>
      {content}
    </button>
  );
}

// ── Who else is here ─────────────────────────────────────────────────────

function Presence() {
  const ctx = useEditor();
  const focus = ctx.selection?.kind === "question" ? ctx.selection.itemKey : null;
  const others = usePresence(ctx.surveyId, focus);
  if (others.length === 0) return null;
  const sameQuestion = focus ? others.filter((p) => p.focus === focus) : [];
  const described = others.map((p) => `${p.email}${p.focus ? ` (on ${p.focus})` : ""}`).join(", ");
  const shown = others.slice(0, 3);
  return (
    <span className={`sto-presence${sameQuestion.length > 0 ? " sto-presence-clash" : ""}`} title={`Also editing: ${described}`}>
      <span className="sto-avatars" aria-hidden="true">
        {shown.map((p) => (
          <span key={p.uid} className="sto-avatar">
            {(p.email[0] ?? "?").toUpperCase()}
          </span>
        ))}
        {others.length > shown.length ? <span className="sto-avatar sto-avatar-more">+{others.length - shown.length}</span> : null}
      </span>
      <span className="sto-presence-text">
        {sameQuestion.length > 0 ? (
          <>
            <Icon name="warning" size={14} /> {sameQuestion[0]!.email} is on this question too
          </>
        ) : others.length === 1 ? (
          <>Also editing: {described}</>
        ) : (
          <>
            Also editing: {others.length} people
            <VisuallyHidden> — {described}</VisuallyHidden>
          </>
        )}
      </span>
    </span>
  );
}

// ── Preview and publish ──────────────────────────────────────────────────

function PreviewLink() {
  const ctx = useEditor();
  const route = useRoute();
  const q = ctx.selection?.kind === "question" ? ctx.selection.itemKey : null;
  let to: Route;
  if (route.name === "playground") to = { name: "playground", tab: "preview", q };
  else to = { name: "survey", surveyId: ctx.surveyId, tab: "preview", q };
  return (
    <Link to={to} className="st-btn st-btn-secondary st-btn-sm sto-preview" title={q ? "Preview from the selected question" : "Preview from the start"}>
      <Icon name="eye" size={16} />
      <span>Preview</span>
    </Link>
  );
}

function PublishButton() {
  const ctx = useEditor();
  const toast = useToast();
  const reasonId = useId();
  if (ctx.canPublish) {
    return (
      <button type="button" className="st-btn st-btn-accent st-btn-sm" aria-haspopup="dialog" onClick={() => ctx.setPublishOpen(true)}>
        <Icon name="publish" size={16} />
        <span>Publish</span>
      </button>
    );
  }
  const reason = ctx.playground ? "Publishing isn’t available in the playground." : "Only publishers can publish — ask an admin.";
  // aria-disabled rather than disabled, so the button can still be reached and
  // its reason read; a disabled button is skipped by the keyboard entirely.
  return (
    <span className="sto-tipwrap">
      <button
        type="button"
        className="st-btn st-btn-accent st-btn-sm"
        aria-disabled="true"
        aria-describedby={reasonId}
        onClick={() => toast.info("You can’t publish from here", reason)}
      >
        <Icon name="publish" size={16} />
        <span>Publish</span>
      </button>
      <span role="tooltip" id={reasonId} className="sto-tip">
        {reason}
      </span>
    </span>
  );
}

// ── Shortcuts ────────────────────────────────────────────────────────────

function ShortcutsDialog({ onClose, playground }: { onClose: () => void; playground: boolean }) {
  const mod = modKey();
  const rows: [ReactNode, string][] = [
    [<><Kbd>{mod}</Kbd> <Kbd>Z</Kbd></>, "Undo a change to the survey"],
    [<><Kbd>{mod}</Kbd> <Kbd>Shift</Kbd> <Kbd>Z</Kbd> or <Kbd>Ctrl</Kbd> <Kbd>Y</Kbd></>, "Redo"],
    // REVIEW FIX: nothing is saved in the playground, and there Ctrl+S is the browser's "Save page".
    ...(playground ? [] : [[<><Kbd>{mod}</Kbd> <Kbd>S</Kbd></>, "Save now"] as [ReactNode, string]]),
    [<Kbd>/</Kbd>, "Search the outline"],
    [<Kbd>?</Kbd>, "Show these shortcuts"],
    [<><Kbd>↑</Kbd> <Kbd>↓</Kbd></>, "Outline: move between rows"],
    [<><Kbd>→</Kbd> <Kbd>←</Kbd></>, "Outline: open or close a section or block, or go to its parent"],
    [<><Kbd>Home</Kbd> <Kbd>End</Kbd></>, "Outline: first or last row"],
    [<><Kbd>Enter</Kbd> or <Kbd>Space</Kbd></>, "Outline: open the row in the editor"],
    [<><Kbd>Alt</Kbd> <Kbd>↑</Kbd> / <Kbd>↓</Kbd></>, "Outline: move the question, block or section up or down"],
    [<><Kbd>Shift</Kbd> <Kbd>F10</Kbd></>, "Outline: the row’s actions (copy, move, archive…)"],
    [<Kbd>Esc</Kbd>, "Close a menu, panel or dialog"],
  ];
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={560}>
      <p className="stp-flush">
        While you&rsquo;re typing in a box, {mod}+Z undoes your typing there, as it does anywhere else. Outside a box it
        undoes the last change to the survey.
      </p>
      <dl className="sto-keys">
        {rows.map(([keys, what], i) => (
          <div key={i}>
            <dt>{keys}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
