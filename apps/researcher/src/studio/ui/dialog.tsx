import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./kit.js";
import { Icon } from "./icons.js";

/**
 * Modal dialogs.
 *
 * A dialog here is usually the last thing between a researcher and something
 * that cannot be taken back — publishing to children, archiving a question
 * that has data — so it behaves exactly as a dialog should: focus moves into
 * it, Tab cannot wander out behind it, Escape cancels, and focus returns to
 * whatever opened it. The page behind is inert, not merely dimmed.
 */

let openDialogs = 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The same, but only inside the dialog's body. */
const IN_BODY = FOCUSABLE.split(",")
  .map((selector) => `.st-dialog-body ${selector.trim()}`)
  .join(", ");

export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  width = 520,
  closeLabel = "Close",
  dismissable = true,
  initialFocus,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  closeLabel?: string;
  /** False while something is in flight that closing would orphan (e.g. a publish). */
  dismissable?: boolean;
  /** Selector for the element to focus first; defaults to the first focusable. */
  initialFocus?: string;
}) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const root = document.getElementById("root");
    // Counted, so a confirmation opened on top of another dialog does not
    // make the page live again when it closes while the first is still open.
    openDialogs += 1;
    root?.setAttribute("inert", "");
    const node = panel.current;
    const target =
      (initialFocus ? node?.querySelector<HTMLElement>(initialFocus) : null) ??
      // Scoped per selector: FOCUSABLE is a comma-separated list, and prefixing
      // the whole list would scope only its first entry — which is how dialogs
      // opened with focus on the header's Close button.
      node?.querySelector<HTMLElement>(IN_BODY) ??
      node?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      openDialogs -= 1;
      if (openDialogs === 0) root?.removeAttribute("inert");
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [initialFocus]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape" && dismissable) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="studio st-overlay" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="st-dialog"
        style={{ maxWidth: width }}
        onKeyDown={onKeyDown}
      >
        <header className="st-dialog-head">
          <h2 id={titleId}>{title}</h2>
          {dismissable ? (
            <button type="button" className="st-iconbtn st-iconbtn-ghost st-iconbtn-md" aria-label={closeLabel} onClick={onClose}>
              <Icon name="close" />
            </button>
          ) : null}
        </header>
        {description ? (
          <div id={descId} className="st-dialog-desc">
            {description}
          </div>
        ) : null}
        {children ? <div className="st-dialog-body">{children}</div> : null}
        {footer ? <footer className="st-dialog-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * "Are you sure?", done properly: says what will happen in plain words, names
 * the consequence, and — for the few actions that deserve it — asks for the
 * thing to be typed rather than clicked through.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  typeToConfirm,
  onConfirm,
  onCancel,
  busy = false,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** When set, the confirm button stays disabled until this exact text is typed. */
  typeToConfirm?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const ready = !typeToConfirm || typed.trim() === typeToConfirm;
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      dismissable={!busy}
      initialFocus={typeToConfirm ? `#${CSS.escape(inputId)}` : ".st-dialog-foot .st-btn-secondary"}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} disabled={!ready} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="st-confirm-body">{body}</div>
      {typeToConfirm ? (
        <div className="st-field">
          <label htmlFor={inputId} className="st-field-label">
            Type <strong>{typeToConfirm}</strong> to confirm
          </label>
          <input
            id={inputId}
            className="st-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}
    </Dialog>
  );
}
