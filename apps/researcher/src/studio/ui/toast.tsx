import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";

/**
 * Toasts: short confirmations of something that has already happened ("Draft
 * restored from r7.1.0"), and errors that need a person.
 *
 * Two live regions, because the two are not equally urgent: a confirmation is
 * announced when the screen reader is next idle, a failure interrupts. Errors
 * stay until dismissed — a failed publish that vanished after five seconds
 * would be a failure nobody saw. Toasts never carry the only copy of an
 * important message: whatever they report is also visible where it happened.
 */

export type ToastTone = "success" | "info" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string | undefined;
  action?: { label: string; onClick: () => void } | undefined;
}

interface ToastApi {
  show: (toast: Omit<ToastItem, "id">) => void;
  success: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = next.current++;
      setItems((all) => [...all.slice(-4), { ...toast, id }]);
      if (toast.tone !== "error") window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, body) => show({ tone: "success", title, body }),
      info: (title, body) => show({ tone: "info", title, body }),
      error: (title, body) => show({ tone: "error", title, body }),
    }),
    [show],
  );

  const render = (tone: "polite" | "assertive") =>
    items
      .filter((t) => (tone === "assertive") === (t.tone === "error"))
      .map((t) => (
        <div key={t.id} className={`st-toast st-toast-${t.tone}`}>
          <Icon name={t.tone === "error" ? "error" : t.tone === "success" ? "check" : "info"} />
          <div className="st-toast-text">
            <strong>{t.title}</strong>
            {t.body ? <span>{t.body}</span> : null}
          </div>
          {t.action ? (
            <button
              type="button"
              className="st-btn st-btn-ghost st-btn-sm"
              onClick={() => {
                t.action?.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" className="st-iconbtn st-iconbtn-ghost st-iconbtn-sm" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ));

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Outside #root, so a confirmation shown while a dialog makes the page inert is still heard. */}
      {createPortal(
        <div className="studio st-toasts">
          <div role="status" aria-live="polite">
            {render("polite")}
          </div>
          <div role="alert" aria-live="assertive">
            {render("assertive")}
          </div>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast outside ToastProvider");
  return api;
}
