import type { StoredTime, StudioRole } from "@myself/studio";

/**
 * Small formatting helpers shared by the Studio's screens: dates in British
 * English, version labels as the rest of the project writes them ("r7.1.0"),
 * and the words for each role.
 */

/** A stored server time as a Date, or null while the server has not filled it in. */
export function toDate(t: StoredTime | null | undefined): Date | null {
  if (t === null || t === undefined) return null;
  if (typeof t === "string") {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof t.toDate === "function") return t.toDate();
  if (typeof t.seconds === "number") return new Date(t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6));
  return null;
}

export function toMillis(t: StoredTime | null | undefined): number | null {
  return toDate(t)?.getTime() ?? null;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "28 Sep 2026" */
export function formatDate(d: Date | null): string {
  return d ? dateFmt.format(d) : "—";
}

/** "28 Sep 2026, 12:30" */
export function formatDateTime(d: Date | null): string {
  return d ? dateTimeFmt.format(d) : "—";
}

/** "12:30" */
export function formatTime(d: Date | null): string {
  return d ? timeFmt.format(d) : "—";
}

/** "just now", "5 minutes ago", "yesterday", else the date. */
export function formatRelative(d: Date | null, now: number = Date.now()): string {
  if (!d) return "—";
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.round(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatDate(d);
}

/** "r7.1.0" — how versions are named everywhere a person reads them. */
export function versionLabel(version: string | null | undefined): string {
  if (!version) return "—";
  return version.startsWith("r") ? version : `r${version}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

export const ROLE_NAMES: Record<StudioRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
  publisher: "Publisher",
  admin: "Admin",
};

/** What each role can do, in the words of docs/16 §5.7. */
export const ROLE_DESCRIPTIONS: Record<StudioRole, string> = {
  viewer: "Can open surveys and drafts and preview them. Can’t change anything.",
  editor: "Everything a viewer can do, plus edit drafts.",
  publisher: "Everything an editor can do, plus publish, restore earlier versions and make a version live again.",
  admin: "Everything a publisher can do, plus decide who has access to the Studio.",
};

/** Save a string as a file, the way the researcher view downloads exports. */
export function downloadText(text: string, filename: string, type = "application/json"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
