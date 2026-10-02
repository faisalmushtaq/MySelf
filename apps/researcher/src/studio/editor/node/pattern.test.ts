import { describe, expect, it } from "vitest";
import { explainPattern, isAnchored, patternError, testPattern } from "./pattern.js";

const CODE = "^[A-Za-z]{3}[0-9]{4}$";

describe("the pattern tester", () => {
  it("accepts and refuses exactly as the participant app does (trimmed, RegExp.test)", () => {
    expect(testPattern(CODE, "NDC0042").status).toBe("match");
    expect(testPattern(CODE, "  ndc0042 ").status).toBe("match");
    expect(testPattern(CODE, "NDC004").status).toBe("no-match");
    expect(testPattern(CODE, "NDC00421").status).toBe("no-match");
  });

  it("shows an unanchored pattern matching inside a longer answer", () => {
    expect(testPattern("[0-9]{4}", "abc12345xyz").status).toBe("match");
    expect(isAnchored("[0-9]{4}")).toBe(false);
    expect(isAnchored(CODE)).toBe(true);
    expect(isAnchored("^abc\\$")).toBe(false);
  });

  it("says nothing for an empty sample, and explains a broken pattern", () => {
    expect(testPattern(CODE, "   ").status).toBe("empty");
    const broken = testPattern("([a-z", "abc");
    expect(broken.status).toBe("invalid");
    expect(patternError("([a-z")).toMatch(/isn't a pattern the app can use/);
    expect(patternError(CODE)).toBeNull();
  });
});

describe("patterns in plain English", () => {
  it("reads the live survey's code format", () => {
    expect(explainPattern(CODE)).toBe("The whole answer must be 3 letters, then 4 digits.");
  });

  it("reads ranges, single characters and literal text", () => {
    expect(explainPattern("^[A-Za-z0-9]{3,16}$")).toBe("The whole answer must be between 3 and 16 letters or digits.");
    expect(explainPattern("^[0-9]$")).toBe("The whole answer must be 1 digit.");
    expect(explainPattern("^[A-Za-z]{2}$")).toBe("The whole answer must be 2 letters.");
    expect(explainPattern("^NDC\\d{4}$")).toBe("The whole answer must be the text “NDC”, then 4 digits.");
    expect(explainPattern("^[A-Z]+-\\d+$")).toBe("The whole answer must be one or more capital letters, then the character “-”, then one or more digits.");
  });

  it("says when only part of the answer is checked", () => {
    expect(explainPattern("^\\d{2}")).toBe("The answer must start with 2 digits; anything may follow it.");
    expect(explainPattern("[a-z]{3}")).toMatch(/^The answer must contain 3 lowercase letters somewhere/);
  });

  it("declines to guess at groups, alternatives and look-arounds", () => {
    expect(explainPattern("^(yes|no)$")).toBeNull();
    expect(explainPattern("^[^0-9]+$")).toBeNull();
    expect(explainPattern("^\\p{L}+$")).toBeNull();
    expect(explainPattern("([a-z")).toBeNull();
  });
});
