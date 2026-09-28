import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/**
 * Tabs within a page (Versions: History · Compare · Activity), following the
 * WAI-ARIA tabs pattern: one tab stop for the whole row, arrow keys move and
 * select, Home and End jump. The page's own navigation (Edit · Preview · …)
 * is links, not these — those change the address.
 */
export function Tabs<T extends string>({
  label,
  idBase,
  value,
  onChange,
  tabs,
}: {
  label: string;
  /** Prefix for the tab and panel ids; pair each panel with <TabPanel idBase value>. */
  idBase: string;
  value: T;
  onChange: (value: T) => void;
  tabs: { value: T; label: string; count?: number | null }[];
}) {
  const list = useRef<HTMLDivElement | null>(null);
  const focusTab = (v: T) => {
    onChange(v);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`#${CSS.escape(`${idBase}-tab-${v}`)}`)?.focus());
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const i = tabs.findIndex((t) => t.value === value);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    focusTab(tabs[next]!.value);
  };
  return (
    <div ref={list} role="tablist" aria-label={label} className="stp-tabs" onKeyDown={onKey}>
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.value}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${t.value}`}
            tabIndex={selected ? 0 : -1}
            className={`stp-tab${selected ? " on" : ""}`}
            onClick={() => onChange(t.value)}
          >
            {t.label}
            {t.count != null ? <span className="stp-tab-count">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idBase, value, children }: { idBase: string; value: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${value}`} aria-labelledby={`${idBase}-tab-${value}`} tabIndex={0} className="stp-tabpanel">
      {children}
    </div>
  );
}
