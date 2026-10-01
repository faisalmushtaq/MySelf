import { describe, expect, it } from "vitest";
import { daysInWords } from "./components/controls/index.js";

describe("reading a number of days back (D-53)", () => {
  it("says it as a person would", () => {
    expect(daysInWords(400)).toBe("1 year, 1 month and 5 days");
    expect(daysInWords(91)).toBe("3 months and 1 day");
    expect(daysInWords(120)).toBe("4 months");
    expect(daysInWords(730)).toBe("2 years");
    expect(daysInWords(3650)).toBe("10 years");
    expect(daysInWords(3)).toBe("3 days");
    expect(daysInWords(1)).toBe("1 day");
    expect(daysInWords(0)).toBe("0 days");
  });
});
