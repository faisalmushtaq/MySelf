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

  it("keeps the area and postcode district of a street found without a postcode (D-53)", () => {
    const found = parseHomeAddress('{"postcode":"","house":"12","street":"Hyde Park Road","area":"Leeds","postcode_district":"LS6"}');
    expect(found).toEqual({ house: "12", street: "Hyde Park Road", area: "Leeds", postcode_district: "LS6" });
    expect(formatHomeAddress(found)).toBe("12 Hyde Park Road, Leeds, LS6");
    // a full postcode, when there is one, is what is shown
    expect(formatHomeAddress({ street: "Hyde Park Road", postcode: "LS6 2AA", postcode_district: "LS6" })).toBe("Hyde Park Road, LS6 2AA");
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
