import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normaliseStreet, parseStreetList } from "./streets.js";

const dir = fileURLToPath(new URL("../../../releases/assets/", import.meta.url));
const file = readdirSync(dir).filter((f) => f.startsWith("streets-west-yorkshire-")).sort().at(-1)!;
const list = parseStreetList(readFileSync(`${dir}${file}`, "utf8"));

describe("streets (D-53)", () => {
  it("compares names the way people write them", () => {
    expect(normaliseStreet("12a St. Michael's Rd")).toBe(normaliseStreet("Saint Michaels Road"));
    expect(normaliseStreet("Hyde Park Rd")).toBe("hyde park road");
    expect(normaliseStreet("  Hyde   Park  Road ")).toBe("hyde park road");
    expect(normaliseStreet("Café Lane")).toBe("cafe lane");
    // A number that IS the name stays: there is nothing else to match on.
    expect(normaliseStreet("1")).toBe("1");
  });

  it("carries every named road in West Yorkshire", () => {
    expect(list.size).toBeGreaterThan(35_000);
  });

  it("finds a street from its full name, its start, or an abbreviation", () => {
    const hyde = list.search("Hyde Park Road");
    expect(hyde[0]).toMatchObject({ street: "Hyde Park Road" });
    expect(hyde.some((m) => m.area.endsWith("Leeds") && m.outward.startsWith("LS"))).toBe(true);
    expect(list.search("hyde park rd")[0]?.street).toBe("Hyde Park Road");
    expect(list.search("Hyde Pa").every((m) => m.street.startsWith("Hyde Park"))).toBe(true);
    expect(list.search("12 Hyde Park Road")[0]?.street).toBe("Hyde Park Road");
  });

  it("still finds it through a typing mistake", () => {
    expect(list.search("Hyde Prak Road").map((m) => m.street)).toContain("Hyde Park Road");
    expect(list.search("Hdye Park Road").map((m) => m.street)).toContain("Hyde Park Road");
  });

  it("uses the area when it is typed as well", () => {
    // There is a Hyde Park Road in Leeds and another in Halifax.
    expect(list.search("Hyde Park Road Halifax")[0]).toMatchObject({ street: "Hyde Park Road", area: "Halifax, Calderdale", outward: "HX1" });
    expect(list.search("Hyde Park Road Leeds")[0]).toMatchObject({ street: "Hyde Park Road", area: "Leeds", outward: "LS6" });
  });

  it("offers nothing for too little, and nothing for gibberish", () => {
    expect(list.search("Hy")).toEqual([]);
    expect(list.search("12")).toEqual([]);
    expect(list.search("qzxqzxqzx")).toEqual([]);
  });

  it("returns at most the number asked for, best first", () => {
    const five = list.search("Main Street");
    expect(five.length).toBe(5);
    expect(five.every((m) => m.street === "Main Street")).toBe(true);
    expect(list.search("Main Street", 12).length).toBe(12);
  });

  it("is quick enough to run as someone types", () => {
    const start = performance.now();
    for (const q of ["Hyde Prak Road", "Manningham Lane", "Woodhouse Lane", "Wakefield Rd"]) list.search(q);
    expect((performance.now() - start) / 4).toBeLessThan(250);
  });

  it("refuses a malformed list rather than half-reading it", () => {
    expect(() => parseStreetList("Hyde Park Road\n")).toThrow(/before any area/);
    expect(() => parseStreetList("@only-one-part\n")).toThrow(/unreadable/);
  });
});
