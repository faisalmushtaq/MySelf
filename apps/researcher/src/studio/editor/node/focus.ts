import { useEffect, useRef } from "react";
import { useEditor } from "../context.js";
import { encodeSelection } from "../selection.js";
import { focusSelectors, rescueSelectors, type FocusRecord } from "./issues.js";

/**
 * Honouring a jump to a field ("Go to the problem" in the validation panel).
 *
 * The frame records which field to focus with the selection; once the centre
 * editor and the settings panel have drawn that selection, the field's box —
 * found by its `data-field` name, in either panel — is opened if it sits in a
 * closed disclosure, scrolled into view and focused. When the field is not on
 * screen (a setting this question type does not have), the editor's heading
 * takes focus instead, so the jump still lands somewhere sensible.
 */

const PANELS = [".ste-centre", ".ste-right"];
const FOCUSABLE = 'input:not([type="hidden"]), textarea, select, button, a[href], [tabindex]';
const TYPED = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';
const CONTROL = 'input:not([type="hidden"]), textarea, select, button:not([disabled]), a[href], .stn-readonly, .stn-cond-readonly';

function find(field: string): HTMLElement | null {
  for (const selector of focusSelectors(field)) {
    for (const panel of PANELS) {
      const el = document.querySelector<HTMLElement>(`${panel} ${selector}`);
      if (el) return el;
    }
  }
  return null;
}

function openAncestors(el: HTMLElement): void {
  let details = el.closest("details");
  while (details) {
    if (!details.open) details.open = true;
    details = details.parentElement?.closest("details") ?? null;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Focus the box a field names. Returns whether one was found. */
export function focusField(field: string): boolean {
  const target = find(field);
  if (!target) {
    document.querySelector<HTMLElement>(".ste-centre [data-editor-heading]")?.focus();
    return false;
  }
  openAncestors(target);
  // A box itself; else, in a list or panel, the first thing to type in, then
  // the first button (e.g. "Add condition"); else the panel.
  const box = target.matches(CONTROL)
    ? target
    : (target.querySelector<HTMLElement>('input[type="radio"]:checked') ??
      target.querySelector<HTMLElement>(TYPED) ??
      target.querySelector<HTMLElement>(CONTROL) ??
      target);
  if (!box.matches(FOCUSABLE)) box.tabIndex = -1;
  box.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  box.focus({ preventScroll: true });
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    // Caret at the end, so typing continues the text rather than replacing it.
    const end = box.value.length;
    try {
      box.setSelectionRange(end, end);
    } catch {
      // Some input types have no caret to place.
    }
  }
  return true;
}

/** Run the pending jump once the current selection has been drawn. */
export function usePendingFocus(): void {
  const { pendingFocus, selection, clearPendingFocus } = useEditor();
  const current = encodeSelection(selection);
  const clear = useRef(clearPendingFocus);
  clear.current = clearPendingFocus;
  useEffect(() => {
    if (!pendingFocus || pendingFocus.selection !== current) return;
    const frame = requestAnimationFrame(() => {
      focusField(pendingFocus.field);
      clear.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingFocus, current]);
}

/**
 * Focus a box in the centre or settings panel once the next render has drawn
 * it. Given several selectors, the first that finds an enabled element wins —
 * e.g. the same "Move down" button, or "Move up" once the row reaches the end.
 */
export function focusSoon(selector: string | readonly string[], opts: { select?: boolean } = {}): void {
  const selectors = typeof selector === "string" ? [selector] : selector;
  requestAnimationFrame(() => {
    for (const s of selectors) {
      for (const panel of PANELS) {
        const el = document.querySelector<HTMLElement>(`${panel} ${s}`);
        if (!el || el.matches(":disabled")) continue;
        el.focus();
        if (opts.select && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select();
        return;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Focus that would otherwise be lost
// ---------------------------------------------------------------------------

/**
 * REVIEW FIX: many actions here remove or disable the very control that was
 * pressed — "Add condition" becomes the rule builder, "Archive" turns the
 * question into its archived view, "Unlock…" becomes "Lock again", a dialog
 * closes onto a button that is no longer there. The browser then drops focus
 * to <body>, and a keyboard or screen-reader user is thrown back to the top of
 * the page with no idea where they are. Each such loss is caught here and focus
 * is put somewhere sensible: the first control of the same field (the rule
 * builder, the "More information" boxes, the option list), else the heading of
 * whatever the centre editor now shows.
 *
 * A focus the person moved themselves (clicking empty space, tabbing to the
 * outline) is left alone: only an element that has gone, or can no longer hold
 * focus, is replaced.
 */

function fieldsAround(el: HTMLElement, panel: Element): string[] {
  const out: string[] = [];
  for (let node: HTMLElement | null = el; node && node !== panel; node = node.parentElement) {
    const field = node.getAttribute("data-field");
    if (field && !out.includes(field)) out.push(field);
  }
  return out;
}

function canHoldFocus(el: HTMLElement): boolean {
  return el.isConnected && !el.matches(":disabled") && el.getClientRects().length > 0;
}

/** Focus the first thing to type in inside `target`, else its first button, else `target` itself if it can take focus. */
function focusInside(target: HTMLElement): boolean {
  const candidates = [
    target.matches(TYPED) ? target : null,
    target.querySelector<HTMLElement>(TYPED),
    target.matches("button, a[href]") ? target : null,
    target.querySelector<HTMLElement>("button:not([disabled]), a[href]"),
    target.matches("[tabindex]") ? target : null,
  ];
  for (const el of candidates) {
    if (!el || !canHoldFocus(el)) continue;
    el.focus();
    if (document.activeElement === el) return true;
  }
  return false;
}

/** Keep focus in the editor when the control holding it disappears. Mounted once, by the centre editor. */
export function useFocusRescue(): void {
  useEffect(() => {
    let record: (FocusRecord & { el: HTMLElement }) | null = null;
    let frame = 0;
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el) return;
      // A dialog opened from the editor: remember what opened it, which the
      // dialog hands focus back to when it closes (if it is still there).
      if (el.closest('[role="dialog"]')) return;
      const panel = el.closest(PANELS.join(", "));
      record = panel ? { el, panel: PANELS.find((p) => panel.matches(p))!, fields: fieldsAround(el, panel) } : null;
    };
    const onFocusOut = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (e.relatedTarget !== null || !record || !el) return;
      if (el !== record.el && !el.closest('[role="dialog"]')) return;
      cancelAnimationFrame(frame);
      // After the render and any focus the action itself asked for (focusSoon).
      frame = requestAnimationFrame(() => {
        const r = record;
        const active = document.activeElement;
        if (!r || (active && active !== document.body)) return;
        if (canHoldFocus(r.el)) return;
        for (const selector of rescueSelectors(r)) {
          const target = document.querySelector<HTMLElement>(selector);
          if (target && focusInside(target)) return;
        }
      });
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
}
