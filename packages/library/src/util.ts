import type { ScaleOption } from "@myself/schema";

/** Compact scale-option builder used throughout the library encoding. */
export function opt(
  code: number,
  label: string,
  legacyCode?: number,
  kind: ScaleOption["kind"] = "substantive",
  textEntry = false,
): ScaleOption {
  return legacyCode === undefined
    ? { code, label, kind, textEntry }
    : { code, label, legacyCode, kind, textEntry };
}

/** Identity-coded options (canonical code === legacy code). */
export function opts(labels: string[], startAt = 1): ScaleOption[] {
  return labels.map((label, i) => opt(startAt + i, label, startAt + i));
}
