import { describe, expect, it } from "vitest";
import { defuseFormula } from "./bids.js";

describe("text a spreadsheet will show rather than run", () => {
  it("defuses anything that would start a formula", () => {
    for (const typed of ["=HYPERLINK(\"http://example.invalid\",\"x\")", "+1+1", "-2+3", "@SUM(A1)", "  =1+1", "＝1+1", "＋1", "－1", "＠A1"]) {
      expect(defuseFormula(typed), typed).toBe(`'${typed}`);
    }
  });

  it("leaves ordinary words alone", () => {
    for (const typed of ["Pashto", "They take my phone at night", "Hyde Park Road", "a=b", "1-2", ""]) {
      expect(defuseFormula(typed), typed).toBe(typed);
    }
  });
});
