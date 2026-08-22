import { describe, expect, it } from "vitest";
import {
  applyAccessibilityPreferences,
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  normaliseAccessibilityPreferences,
  preferenceSummary,
} from "./lib/accessibility.js";

describe("accessibility preferences", () => {
  it("uses a safe accessible default when no stored preference exists", () => {
    expect(normaliseAccessibilityPreferences(null)).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
  });

  it("rejects unsupported display values while retaining valid preferences", () => {
    expect(
      normaliseAccessibilityPreferences({
        contrast: "neon" as "standard",
        textSize: "large",
        dyslexiaFriendly: true,
      }),
    ).toEqual({ contrast: "standard", textSize: "large", dyslexiaFriendly: true });
  });

  it("applies each preference through semantic document attributes", () => {
    const root = { dataset: {} } as unknown as HTMLElement;
    applyAccessibilityPreferences({ contrast: "dark", textSize: "extra_large", dyslexiaFriendly: true }, root);

    expect(root.dataset).toEqual({ contrast: "dark", textSize: "extra_large", readingMode: "dyslexia" });
  });

  it("describes the selected preferences without participant data", () => {
    expect(preferenceSummary({ contrast: "high", textSize: "large", dyslexiaFriendly: true })).toBe(
      "large text, high contrast, dyslexia-friendly reading mode",
    );
  });
});
