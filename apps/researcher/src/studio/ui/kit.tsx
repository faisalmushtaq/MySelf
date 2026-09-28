import {
  cloneElement,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./icons.js";

/**
 * The Studio's building blocks.
 *
 * One small kit, used everywhere, so the whole tool behaves the same way: every
 * control has a visible focus ring, a name a screen reader can say, and a state
 * carried in words or shape as well as colour (docs/11 §5). Nothing here knows
 * about surveys.
 */

type Variant = "primary" | "accent" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  icon?: IconName;
  /** Shows a spinner and disables the button while an action is in flight. */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, busy = false, disabled, children, className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={`st-btn st-btn-${variant} st-btn-${size}${className ? ` ${className}` : ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** Required: an icon alone has no name, so this becomes the accessible name and the tooltip. */
  label: string;
  variant?: "ghost" | "secondary" | "danger";
  size?: "md" | "sm";
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = "ghost", size = "md", pressed, className, type, ...rest },
  ref,
) {
  return (
    <Tooltip text={label}>
      <button
        ref={ref}
        type={type ?? "button"}
        aria-label={label}
        aria-pressed={pressed}
        className={`st-iconbtn st-iconbtn-${variant} st-iconbtn-${size}${className ? ` ${className}` : ""}`}
        {...rest}
      >
        <Icon name={icon} size={size === "sm" ? 16 : 18} />
      </button>
    </Tooltip>
  );
});

/**
 * A tooltip that works from the keyboard as well as the mouse: shown on hover
 * and on focus, and linked with aria-describedby so it is read, not just seen.
 * It never carries information the control's own name does not.
 */
export function Tooltip({ text, children, side = "bottom" }: { text: string; children: ReactElement; side?: "top" | "bottom" }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // Hover waits a moment so passing the pointer over a toolbar doesn't flash
  // a trail of tooltips; keyboard focus shows it at once.
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  if (!isValidElement(children)) return children;
  const child = children as ReactElement<Record<string, unknown>>;
  return (
    <span
      className="st-tip-anchor"
      onMouseEnter={() => {
        clear();
        timer.current = window.setTimeout(() => setOpen(true), 300);
      }}
      onMouseLeave={() => {
        clear();
        setOpen(false);
      }}
      onFocus={() => {
        clear();
        setOpen(true);
      }}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      {cloneElement(child, { "aria-describedby": open ? id : undefined })}
      {open ? (
        <span role="tooltip" id={id} className={`st-tip st-tip-${side}`}>
          {text}
        </span>
      ) : null}
    </span>
  );
}

/**
 * An ⓘ beside a label that explains it on hover or focus — the home for the
 * explanations that would otherwise be a paragraph under every field
 * (DESIGN.md §1). The explanation is also the button's description, so a
 * screen reader hears it without opening anything.
 */
export function InfoTip({ text, label }: { text: string; label: string }) {
  return (
    <span className="st-infotip">
      <Tooltip text={text}>
        <button type="button" aria-label={`About ${label}`} onClick={(e) => e.preventDefault()}>
          <Icon name="info" size={14} />
        </button>
      </Tooltip>
    </span>
  );
}

/** A small coloured dot that always sits beside words saying the same thing. */
export function StatusDot({ tone = "neutral" }: { tone?: "neutral" | "accent" | "warn" | "danger" }) {
  return <span className={`st-dot${tone === "neutral" ? "" : ` st-dot-${tone}`}`} aria-hidden="true" />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="st-spinner" role={label ? "status" : undefined} aria-label={label}>
      <span aria-hidden="true" />
    </span>
  );
}

export type Tone = "neutral" | "accent" | "warn" | "error" | "muted";

/** A small label for a state. Always text, optionally an icon — never colour alone. */
export function Badge({ tone = "neutral", icon, children, title }: { tone?: Tone; icon?: IconName; children: ReactNode; title?: string }) {
  return (
    <span className={`st-badge st-badge-${tone}`} title={title}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="st-kbd">{children}</kbd>;
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="st-sr">{children}</span>;
}

/** Placeholder lines while something loads, so the layout does not jump when it arrives. */
export function Skeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="st-skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${88 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon = "info",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="st-empty">
      <span className="st-empty-icon">
        <Icon name={icon} size={24} />
      </span>
      <h3>{title}</h3>
      {children ? <div className="st-empty-body">{children}</div> : null}
      {action ? <div className="st-empty-action">{action}</div> : null}
    </div>
  );
}

/** An inline message. Errors are announced (role=alert); the rest are polite. */
export function Notice({
  tone = "neutral",
  title,
  children,
  action,
}: {
  tone?: "neutral" | "warn" | "error" | "accent";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon: IconName = tone === "error" ? "error" : tone === "warn" ? "warning" : tone === "accent" ? "check" : "info";
  return (
    <div className={`st-notice st-notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={icon} />
      <div className="st-notice-text">
        {title ? <strong>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="st-notice-action">{action}</div> : null}
    </div>
  );
}

/**
 * A labelled form control with its hint and error wired up by id, so a screen
 * reader announces the label, then the hint, then what is wrong.
 */
export function Field({
  label,
  hint,
  error,
  warning,
  children,
  optional,
  inline,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null | undefined;
  warning?: string | null | undefined;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
  optional?: boolean;
  inline?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, error || warning ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`st-field${inline ? " st-field-inline" : ""}${error ? " st-field-error" : ""}`}>
      <label htmlFor={id} className="st-field-label">
        {label}
        {optional ? <span className="st-optional"> (optional)</span> : null}
      </label>
      {children({ id, ...(described ? { "aria-describedby": described } : {}), ...(error ? { "aria-invalid": true } : {}) })}
      {hint ? (
        <div id={hintId} className="st-field-hint">
          {hint}
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className="st-field-msg st-field-msg-error">
          <Icon name="error" size={14} /> {error}
        </div>
      ) : warning ? (
        <div id={errorId} className="st-field-msg st-field-msg-warn">
          <Icon name="warning" size={14} /> {warning}
        </div>
      ) : null}
    </div>
  );
}

/** A textarea that grows with its content, for stems and long text. */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function AutoTextarea({ className, value, ...rest }, ref) {
    const inner = useRef<HTMLTextAreaElement | null>(null);
    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        inner.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    useEffect(() => {
      const el = inner.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    }, [value]);
    return <textarea ref={setRefs} rows={1} className={`st-autotext${className ? ` ${className}` : ""}`} value={value} {...rest} />;
  },
);

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  /** Why it is disabled, shown in the menu so nobody has to guess. */
  hint?: string;
  danger?: boolean;
}

/**
 * A menu button: arrow keys move, Enter/Space select, Escape closes and puts
 * focus back on the button (WAI-ARIA menu button pattern).
 */
export function MenuButton({
  label,
  icon = "more",
  items,
  buttonLabel,
  align = "end",
}: {
  /** Accessible name of the button. */
  label: string;
  icon?: IconName;
  items: MenuItem[];
  /** Visible text; omitted for an icon-only button. */
  buttonLabel?: ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const first = items.findIndex((i) => !i.disabled);
    setActive(first < 0 ? 0 : first);
    const close = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, items]);

  useEffect(() => {
    if (open) (list.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[active])?.focus();
  }, [open, active]);

  const move = (delta: number) => {
    const n = items.length;
    for (let step = 1; step <= n; step++) {
      const next = (active + delta * step + n * 4) % n;
      if (!items[next]?.disabled) {
        setActive(next);
        return;
      }
    }
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      if (e.key === "Escape") button.current?.focus();
    }
  };

  return (
    <span className="st-menu">
      <button
        ref={button}
        type="button"
        className={buttonLabel ? "st-btn st-btn-ghost st-btn-sm" : "st-iconbtn st-iconbtn-ghost st-iconbtn-md"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={buttonLabel ? undefined : label}
        title={buttonLabel ? undefined : label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name={icon} size={18} />
        {buttonLabel ? <span>{buttonLabel}</span> : null}
      </button>
      {open ? (
        <ul ref={list} id={id} role="menu" aria-label={label} className={`st-menu-list st-menu-${align}`} onKeyDown={onKey}>
          {items.map((item, i) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={i === active ? 0 : -1}
                aria-disabled={item.disabled || undefined}
                className={`st-menu-item${item.danger ? " st-menu-danger" : ""}`}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  button.current?.focus();
                  item.onSelect();
                }}
              >
                {item.icon ? <Icon name={item.icon} size={16} /> : <span className="st-menu-spacer" />}
                <span className="st-menu-text">
                  {item.label}
                  {item.disabled && item.hint ? <small>{item.hint}</small> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}

/** A segmented choice (e.g. Desktop / Tablet / Phone): a radio group that looks like buttons. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`st-seg-item${o.value === value ? " on" : ""}`}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              onChange(options[(i + 1) % options.length]!.value);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              onChange(options[(i - 1 + options.length) % options.length]!.value);
            }
          }}
          tabIndex={o.value === value ? 0 : -1}
        >
          {o.icon ? <Icon name={o.icon} size={16} /> : null}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A labelled on/off switch — a real checkbox underneath, so it works everywhere. */
export function Switch({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`st-switch${disabled ? " disabled" : ""}`}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <label htmlFor={id}>
        <span className="st-switch-track" aria-hidden="true">
          <span className="st-switch-thumb" />
        </span>
        <span className="st-switch-label">{label}</span>
        <span className="st-switch-state" aria-hidden="true">
          {checked ? "On" : "Off"}
        </span>
      </label>
      {hint ? (
        <div id={`${id}-hint`} className="st-field-hint">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
