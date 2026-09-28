import { useEffect, useRef } from "react";
import { useEditor } from "../context.js";
import { encodeSelection } from "../selection.js";
import { focusSelectors } from "./issues.js";

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
  // the first button (e.g. "Add a condition"); else the panel.
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

/** Focus a box in the centre or settings panel once the next render has drawn it. */
export function focusSoon(selector: string, opts: { select?: boolean } = {}): void {
  requestAnimationFrame(() => {
    for (const panel of PANELS) {
      const el = document.querySelector<HTMLElement>(`${panel} ${selector}`);
      if (!el) continue;
      el.focus();
      if (opts.select && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select();
      return;
    }
  });
}
