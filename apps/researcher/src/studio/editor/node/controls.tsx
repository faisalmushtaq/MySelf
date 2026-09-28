import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import type { Issue } from "@myself/studio";
import { Icon, type IconName } from "../../ui/icons.js";
import { AutoTextarea } from "../../ui/kit.js";

/**
 * The editor's form controls.
 *
 * TEXT IS WRITTEN AS IT IS TYPED. Each keystroke is one of the model's
 * operations, labelled the same way for the same field ("Edit wording of
 * kss.q1"), so the history folds a burst of typing into one undo step and
 * autosave always has the latest text — nothing waits for the box to lose
 * focus, so nothing is lost when a tab closes mid-sentence.
 *
 * THE BOX KEEPS ITS OWN TEXT WHILE IT HAS FOCUS. The draft that comes back can
 * differ from what was typed (an option label is stored trimmed), and a
 * controlled input that took the draft's value on every keystroke would jump
 * the caret or eat the space just typed. So the box shows what was typed while
 * focused, and takes the draft's value whenever it is not focused — after an
 * undo, a jump, or someone else's change.
 *
 * TEXT THE MODEL WOULD REFUSE IS NOT SENT. A `validate` function says what is
 * wrong with it ("An option needs a label"), the message appears under the
 * box, and the draft keeps its last good value until the text is fixed.
 */

export function useSyncedText(
  value: string,
  commit: (next: string) => void,
  validate?: (next: string) => string | null,
): {
  text: string;
  localError: string | null;
  bind: {
    value: string;
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    onFocus: () => void;
    onBlur: () => void;
  };
} {
  const [text, setText] = useState(value);
  const [localError, setLocalError] = useState<string | null>(null);
  const errorRef = useRef<string | null>(null);
  const focused = useRef(false);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (!focused.current) {
      setText(value);
      errorRef.current = null;
      setLocalError(null);
    }
  }, [value]);

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = e.target.value;
      setText(next);
      const problem = validate ? validate(next) : null;
      errorRef.current = problem;
      setLocalError(problem);
      if (!problem) commit(next);
    },
    [commit, validate],
  );

  return {
    text,
    localError,
    bind: {
      value: text,
      onChange,
      onFocus: () => {
        focused.current = true;
      },
      onBlur: () => {
        focused.current = false;
        // Show what the draft holds now (trimmed, or unchanged after a refusal),
        // unless the text is being held back with a message to fix it.
        if (!errorRef.current) setText(latest.current);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Validation messages for one field: icon and words, errors first. */
export function IssueMessages({ id, issues, local }: { id?: string; issues?: readonly Issue[] | undefined; local?: string | null }) {
  const list = issues ?? [];
  if (!local && list.length === 0) return null;
  return (
    <div id={id} className="stn-msgs">
      {local ? (
        <p className="stn-msg stn-msg-error">
          <Icon name="error" size={14} />
          <span>
            <span className="st-sr">Error: </span>
            {local}
          </span>
        </p>
      ) : null}
      {list.map((issue, i) => (
        <p key={`${issue.code}:${i}`} className={`stn-msg stn-msg-${issue.severity}`}>
          <Icon name={issue.severity === "error" ? "error" : "warning"} size={14} />
          <span>
            <span className="st-sr">{issue.severity === "error" ? "Error: " : "Warning: "}</span>
            {issue.message}
          </span>
        </p>
      ))}
    </div>
  );
}

export function hasError(issues: readonly Issue[] | undefined, local?: string | null): boolean {
  return !!local || (issues ?? []).some((i) => i.severity === "error");
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface TextFieldProps {
  label: ReactNode;
  /** The validation field name; also the `data-field` a jump focuses. */
  field: string;
  value: string;
  onCommit: (next: string) => void;
  validate?: (next: string) => string | null;
  hint?: ReactNode;
  issues?: readonly Issue[] | undefined;
  /** Shown as text, with the reason, instead of a box. */
  readOnly?: boolean;
  lockedReason?: string | null;
  multiline?: boolean;
  mono?: boolean;
  optional?: boolean;
  placeholder?: string;
  maxLength?: number;
  /** Extra class on the box, e.g. the stem's heading style. */
  inputClassName?: string;
  /** Shown instead of the value when read-only and empty. */
  emptyText?: string;
  after?: ReactNode;
  /** A unit shown beside the box, e.g. "characters". */
  suffix?: string | undefined;
  spellCheck?: boolean;
}

/** A labelled text box that writes as it is typed, with its messages. */
export function TextField(props: TextFieldProps) {
  const {
    label,
    field,
    value,
    onCommit,
    validate,
    hint,
    issues,
    readOnly,
    lockedReason,
    multiline,
    mono,
    optional,
    placeholder,
    maxLength,
    inputClassName,
    emptyText,
    after,
    suffix,
    spellCheck,
  } = props;
  const id = useId();
  const synced = useSyncedText(value, onCommit, validate);
  const hintId = hint ? `${id}-hint` : undefined;
  const msgId = `${id}-msg`;
  const showMsgs = !!synced.localError || (issues?.length ?? 0) > 0;
  const describedBy =
    [suffix ? `${id}-unit` : null, hintId, showMsgs ? msgId : null, lockedReason && readOnly ? `${id}-lock` : null].filter(Boolean).join(" ") ||
    undefined;
  const invalid = hasError(issues, synced.localError);
  const className = `st-input${mono ? " st-input-mono" : ""}${inputClassName ? ` ${inputClassName}` : ""}`;

  const box = readOnly ? (
    <div
      id={id}
      data-field={field}
      tabIndex={-1}
      aria-describedby={describedBy}
      className={`stn-readonly${multiline ? " stn-readonly-multi" : ""}${mono ? " stn-mono" : ""}${inputClassName ? ` ${inputClassName}-ro` : ""}`}
    >
      {value ? value : <span className="stn-empty">{emptyText ?? "Not set"}</span>}
    </div>
  ) : multiline ? (
    <AutoTextarea
      id={id}
      data-field={field}
      className={className}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      placeholder={placeholder}
      maxLength={maxLength}
      spellCheck={spellCheck}
      {...synced.bind}
    />
  ) : (
    <input
      id={id}
      data-field={field}
      className={className}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      placeholder={placeholder}
      maxLength={maxLength}
      spellCheck={spellCheck}
      autoComplete="off"
      {...synced.bind}
    />
  );

  return (
    <div className={`stn-field${invalid ? " stn-field-invalid" : ""}`}>
      <label htmlFor={id} className="stn-label">
        {label}
        {optional ? <span className="stn-optional"> (optional)</span> : null}
        {readOnly ? (
          <span className="stn-label-lock">
            <Icon name="lock" size={13} />
            <span className="st-sr"> (can't be changed)</span>
          </span>
        ) : null}
      </label>
      {suffix ? (
        <div className="stn-inputrow">
          {box}
          <span id={`${id}-unit`} className="stn-suffix">
            {suffix}
          </span>
        </div>
      ) : (
        box
      )}
      {hint ? (
        <div id={hintId} className="stn-hint">
          {hint}
        </div>
      ) : null}
      {readOnly && lockedReason ? (
        <div id={`${id}-lock`} className="stn-hint stn-lockreason">
          {lockedReason}
        </div>
      ) : null}
      {showMsgs ? <IssueMessages id={msgId} issues={issues} local={synced.localError} /> : null}
      {after}
    </div>
  );
}

export interface NumberFieldProps {
  label: ReactNode;
  field: string;
  value: number | undefined;
  /** Called with the number, or null to leave the setting out. */
  onCommit: (next: number | null) => void;
  parse: (text: string) => { ok: true; value: number | null } | { ok: false; message: string };
  hint?: ReactNode;
  issues?: readonly Issue[] | undefined;
  readOnly?: boolean;
  lockedReason?: string | null;
  placeholder?: string;
  suffix?: string;
  optional?: boolean;
}

/** A number box that writes as it is typed, once what is typed is a number the setting takes. */
export function NumberField({ label, field, value, onCommit, parse, hint, issues, readOnly, lockedReason, placeholder, suffix, optional }: NumberFieldProps) {
  const commit = useCallback(
    (text: string) => {
      const parsed = parse(text);
      if (parsed.ok && parsed.value !== (value ?? null)) onCommit(parsed.value);
    },
    [parse, onCommit, value],
  );
  const validate = useCallback((text: string) => {
    const parsed = parse(text);
    return parsed.ok ? null : parsed.message;
  }, [parse]);
  return (
    <TextField
      label={label}
      field={field}
      value={value === undefined ? "" : String(value)}
      onCommit={commit}
      validate={validate}
      hint={hint}
      issues={issues}
      readOnly={readOnly ?? false}
      lockedReason={lockedReason ?? null}
      placeholder={placeholder ?? (optional ? "No limit" : "")}
      inputClassName="stn-number"
      emptyText={optional ? "No limit" : "Not set"}
      optional={optional ?? false}
      suffix={suffix}
    />
  );
}

/** A labelled value that can't be edited here, with why. */
export function ReadOnlyValue({
  label,
  field,
  children,
  reason,
  mono,
}: {
  label: ReactNode;
  field?: string;
  children: ReactNode;
  reason?: ReactNode;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className="stn-field">
      <span className="stn-label" id={`${id}-label`}>
        {label}
      </span>
      <div
        className={`stn-readonly${mono ? " stn-mono" : ""}`}
        data-field={field}
        tabIndex={field ? -1 : undefined}
        aria-labelledby={`${id}-label`}
        aria-describedby={reason ? `${id}-why` : undefined}
      >
        {children}
      </div>
      {reason ? (
        <div id={`${id}-why`} className="stn-hint stn-lockreason">
          {reason}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Banners and panels
// ---------------------------------------------------------------------------

/** A banner saying what is locked and why, with what can be done about it. */
export function LockBanner({
  icon = "lock",
  tone = "neutral",
  title,
  children,
  actions,
}: {
  icon?: IconName;
  tone?: "neutral" | "accent" | "warn";
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`stn-banner stn-banner-${tone}`} role="note">
      <span className="stn-banner-icon">
        <Icon name={icon} size={18} />
      </span>
      <div className="stn-banner-text">
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
      {actions ? <div className="stn-banner-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * A titled block of the editor. `field` marks it as the target of a jump to a
 * field that is a whole list (options, statements) rather than one box.
 */
export function Panel({
  title,
  description,
  field,
  children,
  actions,
  headingLevel = 3,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  field?: string;
  children: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className={`stn-panel${className ? ` ${className}` : ""}`} data-field={field} tabIndex={field ? -1 : undefined}>
      <header className="stn-panel-head">
        <H className="stn-panel-title">{title}</H>
        {actions ? <div className="stn-panel-actions">{actions}</div> : null}
      </header>
      {description ? <div className="stn-panel-desc">{description}</div> : null}
      {children}
    </section>
  );
}

/**
 * A disclosure that stays a real <details>, so a jump to a field inside it can
 * open it, and the browser gives it keyboard and screen-reader behaviour.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className={`stn-details${className ? ` ${className}` : ""}`} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="stn-details-chevron">
          <Icon name="chevron-right" size={16} />
        </span>
        <span>{summary}</span>
      </summary>
      <div className="stn-details-body">{children}</div>
    </details>
  );
}

/** A plain-language key/value list. */
export function Facts({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="stn-facts">
      {rows.map((r) => (
        <div key={r.label}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A small uppercase label for a group of settings — the lab site's eyebrow. */
export function Eyebrow({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p className="stn-eyebrow" id={id}>
      {children}
    </p>
  );
}
