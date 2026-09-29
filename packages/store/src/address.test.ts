import { describe, expect, it } from "vitest";
import { formatHomeAddress, parseHomeAddress } from "./address.js";

describe("the home address as the identity partition carries it (D-52)", () => {
  it("keeps the parts given, trimmed", () => {
    expect(parseHomeAddress('{"postcode":" XX1 1XX ","house":"1","street":"Example Street"}')).toEqual({
      postcode: "XX1 1XX",
      house: "1",
      street: "Example Street",
    });
    expect(parseHomeAddress('{"postcode":"XX1 1XX"}')).toEqual({ postcode: "XX1 1XX" });
  });

  it("drops what it does not recognise rather than storing it", () => {
    expect(parseHomeAddress('{"postcode":"XX1 1XX","note":"<script>","house":3}')).toEqual({ postcode: "XX1 1XX" });
    for (const raw of [undefined, null, "", "not json", "[]", '"XX1 1XX"', "{}", '{"house":"  "}']) {
      expect(parseHomeAddress(raw), String(raw)).toBeNull();
    }
  });

  it("reads as one line", () => {
    expect(formatHomeAddress({ postcode: "XX1 1XX", house: "1", street: "Example Street" })).toBe(
      "1 Example Street, XX1 1XX",
    );
    expect(formatHomeAddress({ postcode: "XX1 1XX" })).toBe("XX1 1XX");
    expect(formatHomeAddress({ street: "Example Street" })).toBe("Example Street");
    expect(formatHomeAddress(null)).toBeNull();
    expect(formatHomeAddress({})).toBeNull();
  });
});
