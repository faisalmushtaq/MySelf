import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../../ui/icons.js";
import type { ActionId, ActionSpec } from "./actions.js";

/**
 * The one actions menu the whole outline shares, opened from a row's "…"
 * button, a right-click, or Shift+F10 on a focused row.
 *
 * One menu for every row, rather than one per row, so 150 rows carry a button
 * each and nothing more. Unlike the kit's MenuButton it can be opened from the
 * keyboard on the row itself, and a disabled item can still be reached with
 * the arrow keys — its reason is the point of it being there, and a screen
 * reader should be able to hear it.
 */
export function RowMenu({
  label,
  items,
  anchor,
  onChoose,
  onClose,
}: {
  label: string;
  items: ActionSpec[];
  anchor: HTMLElement;
  onChoose: (id: ActionId) => void;
  /** `restore`: put focus back on the row (Escape), rather than leave it where a click put it. */
  onClose: (restore: boolean) => void;
}) {
  const list = useRef<HTMLUListElement | null>(null);
  const [active, setActive] = useState(() => Math.max(0, items.findIndex((i) => !i.disabled)));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const id = useId();

  useLayoutEffect(() => {
    const menu = list.current;
    if (!menu) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    let top = a.bottom + 4;
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 4);
    let left = a.right - m.width;
    if (left < 8) left = Math.min(a.left, window.innerWidth - m.width - 8);
    setPos({ top, left: Math.max(8, left) });
  }, [anchor]);

  useEffect(() => {
    list.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[active]?.focus();
  }, [active, pos]);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(false);
    };
    // Scrolling the outline would leave the menu floating away from its row.
    const scrolled = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) onClose(false);
    };
    const resized = () => onClose(false);
    document.addEventListener("mousedown", outside);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = items.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => (i + 1) % n);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => (i - 1 + n) % n);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(n - 1);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
        break;
      case "Tab":
        onClose(true);
        break;
    }
  };

  return (
    <ul
      ref={list}
      id={id}
      role="menu"
      aria-label={label}
      className="st-menu-list sto-rowmenu"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => {
        const hintId = `${id}-h${i}`;
        const labelId = `${id}-l${i}`;
        return (
          <li key={item.id} role="none">
            <button
              type="button"
              role="menuitem"
              tabIndex={i === active ? 0 : -1}
              aria-disabled={item.disabled ? true : undefined}
              aria-labelledby={labelId}
              aria-describedby={item.disabled ? hintId : undefined}
              className={`st-menu-item${item.danger ? " st-menu-danger" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                if (item.disabled) return;
                onChoose(item.id);
              }}
            >
              <Icon name={item.icon} size={16} />
              <span className="st-menu-text">
                <span id={labelId}>{item.label}</span>
                {item.disabled ? <small id={hintId}>{item.disabled}</small> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
