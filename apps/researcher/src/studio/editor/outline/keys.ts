/**
 * Small keyboard helpers the toolbar and the outline share.
 */

/** Input types where a key press is typing, and so belongs to the browser. */
const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"]);

/**
 * Whether a key press lands in something being typed in. Shortcuts that also
 * mean something while typing (Ctrl+Z, "/", "?") leave those alone.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUTS.has(target.type);
  return false;
}

/** "⌘" on a Mac, "Ctrl" elsewhere — what to write in a shortcut's label. */
export function modKey(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl";
}

/** A DOM id for a row: row ids contain dots and colons, which ids may hold but selectors may not. */
export function rowDomId(id: string): string {
  return `sto-r-${id.replace(/[^A-Za-z0-9_-]/g, (c) => `-${c.charCodeAt(0).toString(16)}-`)}`;
}
