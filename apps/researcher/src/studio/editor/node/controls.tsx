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
import { AutoTextarea, InfoTip, Tooltip } from "../../ui/kit.js";

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

/**
 * An issue's short line, with its advice (if any) behind an ⓘ that stays with
 * the last word rather than wrapping onto a line of its own.
 */
export function IssueText({ issue, label }: { issue: Issue; label: string }) {
  if (!issue.hint) return <>{issue.message}</>;
  const cut = issue.message.lastIndexOf(" ") + 1;
  return (
    <>
      {issue.message.slice(0, cut)}
      <span className="st-nowrap">
        {issue.message.slice(cut)}
        <InfoTip text={issue.hint} label={label} />
      </span>
    </>
  );
}

/**
 * Validation messages for one field: icon and a short line, errors first, with
 * any advice behind an ⓘ — the field is on screen, so the line never names it.
 */
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
            <IssueText issue={issue} label={issue.severity === "error" ? "this error" : "this warning"} />
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
// Tips
// ---------------------------------------------------------------------------

/**
 * A padlock that says why something can't be changed, on hover or focus. The
 * same words are also the locked value's description (by id), so a screen
 * reader hears them with the value without having to find the padlock.
 */
export function LockTip({ reason, label = "Why this can't be changed" }: { reason: string; label?: string }) {
  return (
    <span className="stn-locktip">
      <Tooltip text={reason}>
        <button type="button" aria-label={label} onClick={(e) => e.preventDefault()}>
          <Icon name="lock" size={14} />
        </button>
      </Tooltip>
    </span>
  );
}

const plain = (node: ReactNode, fallback: string): string => (typeof node === "string" ? node : fallback);

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
  /** One short visible line under the box. Longer explanations go in `info`. */
  hint?: ReactNode;
  /** An explanation behind an ⓘ beside the label; also the box's description. */
  info?: string;
  /** The ⓘ's name ("About …"), when the label is not plain text. */
  infoLabel?: string;
  /** Read to screen readers as the box's description, never shown. */
  describe?: string;
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
  /** The label is for screen readers only: the box speaks for itself (the question text). */
  hideLabel?: boolean;
  /** Label on the left, a narrow box on the right (the settings panel's rows). */
  inline?: boolean;
  /** Something to put at the end of the box's row, e.g. a copy button. */
  trailing?: ReactNode;
  /** Extra class on the field's wrapper. */
  className?: string;
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
    info,
    infoLabel,
    describe,
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
    hideLabel,
    inline,
    trailing,
    className: fieldClassName,
  } = props;
  const id = useId();
  const synced = useSyncedText(value, onCommit, validate);
  const hintId = hint ? `${id}-hint` : undefined;
  const infoId = info || describe ? `${id}-info` : undefined;
  const msgId = `${id}-msg`;
  const showMsgs = !!synced.localError || (issues?.length ?? 0) > 0;
  const describedBy =
    [suffix ? `${id}-unit` : null, hintId, infoId, showMsgs ? msgId : null, lockedReason && readOnly ? `${id}-lock` : null].filter(Boolean).join(" ") ||
    undefined;
  const invalid = hasError(issues, synced.localError);
  const className = `st-input${mono ? " st-input-mono" : ""}${inputClassName ? ` ${inputClassName}` : ""}`;

  const box = readOnly ? (
    // REVIEW FIX: a <label for> names only form controls, so this value had no
    // name when a jump focused it ("I get a lot of headaches…" with no "Question
    // text"). It is exposed as the read-only text box it stands in for.
    <div
      id={id}
      data-field={field}
      tabIndex={-1}
      role="textbox"
      aria-readonly="true"
      aria-multiline={multiline || undefined}
      aria-labelledby={`${id}-label`}
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

  const labelEl = (
    <label htmlFor={id} id={`${id}-label`} className="stn-label">
      {label}
      {optional ? <span className="stn-optional"> (optional)</span> : null}
      {readOnly ? <span className="st-sr"> (can't be changed)</span> : null}
    </label>
  );

  return (
    <div className={`stn-field${inline ? " stn-field-inline" : ""}${invalid ? " stn-field-invalid" : ""}${fieldClassName ? ` ${fieldClassName}` : ""}`}>
      {hideLabel ? (
        <div className="st-sr">{labelEl}</div>
      ) : (
        <div className="stn-labelrow">
          {labelEl}
          {info ? <InfoTip text={info} label={infoLabel ?? plain(label, "this field")} /> : null}
          {readOnly && lockedReason ? <LockTip reason={lockedReason} label={`Why ${plain(label, "this")} can't be changed`} /> : null}
        </div>
      )}
      {suffix || trailing ? (
        <div className="stn-inputrow">
          {box}
          {suffix ? (
            <span id={`${id}-unit`} className="stn-suffix">
              {suffix}
            </span>
          ) : null}
          {trailing}
        </div>
      ) : (
        box
      )}
      {hint ? (
        <div id={hintId} className="stn-hint">
          {hint}
        </div>
      ) : null}
      {infoId ? (
        <span id={infoId} className="st-sr">
          {info ?? describe}
        </span>
      ) : null}
      {readOnly && lockedReason ? (
        <span id={`${id}-lock`} className="st-sr">
          {lockedReason}
        </span>
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
  info?: string;
  issues?: readonly Issue[] | undefined;
  readOnly?: boolean;
  lockedReason?: string | null;
  placeholder?: string;
  suffix?: string;
  optional?: boolean;
  inline?: boolean;
}

/** A number box that writes as it is typed, once what is typed is a number the setting takes. */
export function NumberField({
  label,
  field,
  value,
  onCommit,
  parse,
  hint,
  info,
  issues,
  readOnly,
  lockedReason,
  placeholder,
  suffix,
  optional,
  inline,
}: NumberFieldProps) {
  const commit = useCallback(
    (text: string) => {
      const parsed = parse(text);
      if (parsed.ok && parsed.value !== (value ?? null)) onCommit(parsed.value);
    },
    [parse, onCommit, value],
  );
  const validate = useCallback(
    (text: string) => {
      const parsed = parse(text);
      return parsed.ok ? null : parsed.message;
    },
    [parse],
  );
  return (
    <TextField
      label={label}
      field={field}
      value={value === undefined ? "" : String(value)}
      onCommit={commit}
      validate={validate}
      hint={hint}
      {...(info ? { info } : {})}
      issues={issues}
      readOnly={readOnly ?? false}
      lockedReason={lockedReason ?? null}
      placeholder={placeholder ?? (optional ? "No limit" : "")}
      inputClassName="stn-number"
      emptyText={optional ? "No limit" : "Not set"}
      suffix={suffix}
      inline={inline ?? false}
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
  inline,
}: {
  label: ReactNode;
  field?: string;
  children: ReactNode;
  reason?: string | null | undefined;
  mono?: boolean;
  inline?: boolean;
}) {
  const id = useId();
  return (
    <div className={`stn-field${inline ? " stn-field-inline" : ""}`}>
      <div className="stn-labelrow">
        <span className="stn-label" id={`${id}-label`}>
          {label}
        </span>
        {reason ? <LockTip reason={reason} label={`Why ${plain(label, "this")} can't be changed`} /> : null}
      </div>
      <div
        className={`stn-readonly${mono ? " stn-mono" : ""}`}
        data-field={field}
        tabIndex={field ? -1 : undefined}
        // REVIEW FIX: aria-labelledby is ignored on a plain <div>; as a group it names the value.
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={reason ? `${id}-why` : undefined}
      >
        {children}
      </div>
      {reason ? (
        <span id={`${id}-why`} className="st-sr">
          {reason}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A setting that is on or off: its label on the left, an ⓘ with what it does,
 * the switch on the right (DESIGN.md §5). A real checkbox with role=switch, so
 * it works everywhere; `field` goes on the checkbox itself, so a jump from the
 * checks panel lands on the switch rather than on the ⓘ beside it.
 */
export function SwitchRow({
  label,
  info,
  checked,
  onChange,
  disabled,
  field,
}: {
  label: string;
  info?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  field?: string;
}) {
  const id = useId();
  const infoId = `${id}-info`;
  return (
    <div className={`stn-switchrow${disabled ? " disabled" : ""}`}>
      <label htmlFor={id} className="stn-switchrow-label">
        {label}
      </label>
      {info ? <InfoTip text={info} label={label} /> : null}
      <span className={`st-switch stn-switchrow-switch${disabled ? " disabled" : ""}`}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          data-field={field}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={info ? infoId : undefined}
        />
        <label htmlFor={id}>
          <span className="st-switch-track" aria-hidden="true">
            <span className="st-switch-thumb" />
          </span>
        </label>
      </span>
      {info ? (
        <span id={infoId} className="st-sr">
          {info}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notices and panels
// ---------------------------------------------------------------------------

/**
 * One slim line saying what is locked (or unlocked, or special) about what is
 * shown, with the why behind an ⓘ and what can be done about it on the right.
 */
export function LockBanner({
  icon = "lock",
  tone = "neutral",
  title,
  info,
  infoLabel,
  actions,
}: {
  icon?: IconName;
  tone?: "neutral" | "accent" | "warn";
  title: string;
  info?: string | null | undefined;
  infoLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <div className={`stn-notice stn-notice-${tone}`} role="note">
      <Icon name={icon} size={16} />
      <span className="stn-notice-text">{title}</span>
      {info ? <InfoTip text={info} label={infoLabel ?? title} /> : null}
      {actions ? <span className="stn-notice-actions">{actions}</span> : null}
    </div>
  );
}

/**
 * A titled part of the editor, set off by a hairline. `field` marks it as the
 * target of a jump to a field that is a whole list (options, statements)
 * rather than one box.
 */
export function Panel({
  title,
  description,
  info,
  field,
  children,
  actions,
  headingLevel = 3,
  className,
}: {
  title: ReactNode;
  /** One short line under the title. Anything longer goes in `info`. */
  description?: ReactNode;
  info?: string;
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
        {info ? <InfoTip text={info} label={plain(title, "this part")} /> : null}
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
          <Icon name="chevron-right" size={14} />
        </span>
        <span>{summary}</span>
      </summary>
      <div className="stn-details-body">{children}</div>
    </details>
  );
}

/** A plain-language key/value list. */
export function Facts({ rows }: { rows: { label: string; value: ReactNode; info?: string }[] }) {
  return (
    <dl className="stn-facts">
      {rows.map((r) => (
        <div key={r.label}>
          <dt>
            {r.label}
            {r.info ? <InfoTip text={r.info} label={r.label} /> : null}
          </dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A small label for a group of settings. */
export function Eyebrow({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p className="stn-eyebrow" id={id}>
      {children}
    </p>
  );
}
