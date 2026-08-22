export const CONTRAST_MODES = ["standard", "high", "dark"] as const;
export const TEXT_SIZES = ["default", "large", "extra_large"] as const;

export type ContrastMode = (typeof CONTRAST_MODES)[number];
export type TextSize = (typeof TEXT_SIZES)[number];

export interface AccessibilityPreferences {
  contrast: ContrastMode;
  textSize: TextSize;
  dyslexiaFriendly: boolean;
}

export const DEFAULT_ACCESSIBILITY_PREFERENCES: AccessibilityPreferences = {
  contrast: "standard",
  textSize: "default",
  dyslexiaFriendly: false,
};

export function normaliseAccessibilityPreferences(value: Partial<AccessibilityPreferences> | null | undefined): AccessibilityPreferences {
  return {
    contrast: CONTRAST_MODES.includes(value?.contrast as ContrastMode) ? (value!.contrast as ContrastMode) : "standard",
    textSize: TEXT_SIZES.includes(value?.textSize as TextSize) ? (value!.textSize as TextSize) : "default",
    dyslexiaFriendly: value?.dyslexiaFriendly === true,
  };
}

/** Apply device preferences through attributes so every component inherits them. */
export function applyAccessibilityPreferences(preferences: AccessibilityPreferences, root: HTMLElement = document.documentElement): void {
  const normalised = normaliseAccessibilityPreferences(preferences);
  root.dataset.contrast = normalised.contrast;
  root.dataset.textSize = normalised.textSize;
  root.dataset.readingMode = normalised.dyslexiaFriendly ? "dyslexia" : "standard";
}

export function preferenceSummary(preferences: AccessibilityPreferences): string {
  const text = preferences.textSize === "default" ? "default text" : preferences.textSize === "large" ? "large text" : "extra-large text";
  const contrast = preferences.contrast === "standard" ? "standard contrast" : preferences.contrast === "high" ? "high contrast" : "dark contrast";
  return `${text}, ${contrast}${preferences.dyslexiaFriendly ? ", dyslexia-friendly reading mode" : ""}`;
}
