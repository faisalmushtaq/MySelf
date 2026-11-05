import { describe, expect, it } from "vitest";
import {
  WEST_YORKSHIRE_OUTWARDS,
  addressFrom,
  addressRequest,
  outcomeOf,
  searchText,
  suggestParams,
  suggestionsFrom,
  townCase,
  withinLimits,
} from "./address-policy.js";

describe("the address finder (D-81)", () => {
  it("accepts a search or a pick from the iPad, and nothing else", () => {
    expect(addressRequest.safeParse({ search: "12 hyde park" }).success).toBe(true);
    expect(addressRequest.safeParse({ pick: "paf_23747771" }).success).toBe(true);
    expect(addressRequest.safeParse({ search: "12" }).success).toBe(false);
    expect(addressRequest.safeParse({ search: "12 hyde park", api_key: "x" }).success).toBe(false);
    expect(addressRequest.safeParse({ pick: "../../v1/keys" }).success).toBe(false);
    expect(searchText("  12   hyde  park ")).toBe("12 hyde park");
    expect(searchText(" .. ")).toBeNull();
  });

  it("asks only for West Yorkshire, by district, then by postcode area", () => {
    expect(WEST_YORKSHIRE_OUTWARDS).toContain("LS6");
    expect(WEST_YORKSHIRE_OUTWARDS).toContain("OL14");
    expect(WEST_YORKSHIRE_OUTWARDS).not.toContain("YO1");
    const first = suggestParams("12 hyde park", "districts");
    expect(first).toMatchObject({ query: "12 hyde park", context: "GBR", limit: "6" });
    expect(first["postcode_outward"]!.split(",")).toHaveLength(WEST_YORKSHIRE_OUTWARDS.length);
    expect(first["bias_lonlat"]).toMatch(/^-1\.\d+,53\.\d+,\d+$/);
    const second = suggestParams("12 hyde park", "areas");
    expect(second["postcode_area"]).toBe("BD,HD,HX,LS,WF");
    expect(second["postcode_outward"]).toBeUndefined();
  });

  it("passes on suggestions as Ideal Postcodes words them, and only well-formed ones", () => {
    expect(
      suggestionsFrom([
        { id: "paf_1", suggestion: "12 Hyde Park Road, Leeds, LS6", udprn: 1 },
        { id: "bad id!", suggestion: "x" },
        { id: "paf_2", suggestion: "  " },
        "junk",
      ]),
    ).toEqual([{ id: "paf_1", label: "12 Hyde Park Road, Leeds, LS6" }]);
    expect(suggestionsFrom(null)).toEqual([]);
  });

  it("reads a chosen address into the question's own keys, with its UPRN", () => {
    expect(
      addressFrom({
        line_1: "12 Hyde Park Road",
        building_number: "12",
        thoroughfare: "Hyde Park Road",
        dependant_locality: "Headingley",
        post_town: "LEEDS",
        postcode: "LS6 1AB",
        uprn: "72012345678",
      }),
    ).toEqual({ house: "12", street: "Hyde Park Road", postcode: "LS6 1AB", area: "Headingley, Leeds", postcodeDistrict: "LS6", uprn: "72012345678" });
    expect(
      addressFrom({ sub_building_name: "Flat 3", building_number: 24, thoroughfare: "Headingley Mount", post_town: "LEEDS", postcode: "LS6 3EL", uprn: "" }),
    ).toMatchObject({ house: "Flat 3, 24", street: "Headingley Mount", area: "Leeds", uprn: "" });
    // No street: the locality stands in for it.
    expect(
      addressFrom({ line_1: "Rose Cottage", building_name: "Rose Cottage", dependant_locality: "Heptonstall", post_town: "HEBDEN BRIDGE", postcode: "HX7 7NA" }),
    ).toMatchObject({ house: "Rose Cottage", street: "Heptonstall", area: "Hebden Bridge" });
    expect(addressFrom({ postcode: "not one" })).toBeNull();
    expect(townCase("SOWERBY BRIDGE")).toBe("Sowerby Bridge");
  });

  it("tells a refused filter, a missing address and a stopped account apart", () => {
    expect(outcomeOf(200, { code: 2000 })).toEqual({ kind: "found" });
    expect(outcomeOf(404, { code: 4048 })).toEqual({ kind: "not-found" });
    expect(outcomeOf(400, { code: 40016 })).toEqual({ kind: "refused-filter" });
    expect(outcomeOf(402, { code: 4020 })).toEqual({ kind: "unavailable", reason: "no-credit" });
    expect(outcomeOf(402, { code: 4021 })).toEqual({ kind: "unavailable", reason: "limit" });
    expect(outcomeOf(401, { code: 4010 })).toEqual({ kind: "unavailable", reason: "key" });
    expect(outcomeOf(503, null)).toEqual({ kind: "unavailable", reason: "provider" });
  });

  it("caps each iPad and the study each day", () => {
    const limits = { lookupsPerDevice: 2, suggestionsPerDevice: 50, lookupsPerStudy: 10, suggestionsPerStudy: 100 };
    expect(withinLimits("lookup", 1, 5, limits)).toBe("yes");
    expect(withinLimits("lookup", 2, 5, limits)).toBe("device");
    expect(withinLimits("lookup", 0, 10, limits)).toBe("study");
    expect(withinLimits("suggestion", 49, 99, limits)).toBe("yes");
  });
});
