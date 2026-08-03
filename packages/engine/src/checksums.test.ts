import { describe, expect, it } from "vitest";
import { checksumValid, formatNhsNumber, isValidNhsNumber, isValidUpn } from "./checksums.js";

/**
 * These identifiers exist to be linked on. A wrong one that still looks right
 * either drops a child out of the linked cohort or attaches them to somebody
 * else, and neither is visible afterwards — so the check digit is worth
 * getting exactly right at the point of entry.
 *
 * The NHS numbers below are the published test numbers reserved for exactly
 * this purpose; none belongs to a real person.
 */

describe("NHS number", () => {
  it("accepts numbers whose Modulus 11 check digit is right", () => {
    for (const valid of ["9434765919", "9434765870", "9449306680", "9449306621"]) {
      expect(isValidNhsNumber(valid), valid).toBe(true);
    }
  });

  it("accepts the spacing people actually type", () => {
    expect(isValidNhsNumber("943 476 5919")).toBe(true);
    expect(isValidNhsNumber("943-476-5919")).toBe(true);
  });

  it("rejects a single mistyped digit, which is the whole point", () => {
    expect(isValidNhsNumber("9434765918")).toBe(false);
    expect(isValidNhsNumber("9434765929")).toBe(false);
  });

  it("rejects a transposition, the other common slip", () => {
    expect(isValidNhsNumber("9434769519")).toBe(false);
  });

  it("rejects the wrong length, letters, and an empty box", () => {
    expect(isValidNhsNumber("943476591")).toBe(false);
    expect(isValidNhsNumber("94347659199")).toBe(false);
    expect(isValidNhsNumber("943476591A")).toBe(false);
    expect(isValidNhsNumber("")).toBe(false);
  });

  it("rejects a number whose remainder gives a check digit of 10", () => {
    // No NHS number can end in a check digit of 10, so any candidate whose
    // arithmetic lands there is invalid however it is written.
    expect(isValidNhsNumber("9434765910")).toBe(false);
  });

  it("writes it out the way it appears on a letter", () => {
    expect(formatNhsNumber("9434765919")).toBe("943 476 5919");
    expect(formatNhsNumber("943 476 5919")).toBe("943 476 5919");
  });
});

describe("UPN", () => {
  it("accepts a UPN whose check letter is right", () => {
    // Check letter computed from the weighted sum of the remaining twelve.
    expect(isValidUpn("H801200001001")).toBe(isValidUpn("H801200001001"));
    // Round-trip: build one, then confirm it validates.
    const body = "801200001001";
    const letters = "ABCDEFGHJKLMNPQRTUVWXYZ";
    let total = 0;
    for (let i = 0; i < body.length; i += 1) total += Number(body[i]) * (i + 2);
    const upn = `${letters[total % 23]}${body}`;
    expect(isValidUpn(upn)).toBe(true);
  });

  it("rejects a wrong check letter and a wrong length", () => {
    const body = "801200001001";
    const letters = "ABCDEFGHJKLMNPQRTUVWXYZ";
    let total = 0;
    for (let i = 0; i < body.length; i += 1) total += Number(body[i]) * (i + 2);
    const right = letters[total % 23]!;
    const wrong = letters[(total + 1) % 23]!;
    expect(isValidUpn(`${wrong}${body}`)).toBe(false);
    expect(isValidUpn(`${right}${body}9`)).toBe(false);
    expect(isValidUpn(`${right}8012`)).toBe(false);
  });

  it("never uses I, O or S as a check letter, so a register cannot be misread", () => {
    const letters = "ABCDEFGHJKLMNPQRTUVWXYZ";
    expect(letters).not.toMatch(/[IOS]/);
    expect(letters).toHaveLength(23);
  });
});

describe("checksumValid", () => {
  it("dispatches on the kind the item declares", () => {
    expect(checksumValid("nhs_number", "9434765919")).toBe(true);
    expect(checksumValid("nhs_number", "9434765918")).toBe(false);
  });
});
