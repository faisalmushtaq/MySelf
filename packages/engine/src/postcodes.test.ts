import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalisePostcode, parsePostcodeList } from "./postcodes.js";

const dir = fileURLToPath(new URL("../../../releases/assets/", import.meta.url));
const file = readdirSync(dir).filter((f) => f.startsWith("postcodes-west-yorkshire-")).sort().at(-1)!;
const list = parsePostcodeList(readFileSync(`${dir}${file}`, "utf8"));

describe("postcodes (D-52)", () => {
  it("writes any spacing or case of a postcode the standard way, and refuses what is not one", () => {
    expect(normalisePostcode("ls62aa")).toBe("LS6 2AA");
    expect(normalisePostcode("  LS6   2aa ")).toBe("LS6 2AA");
    expect(normalisePostcode("bd1 1af")).toBe("BD1 1AF");
    expect(normalisePostcode("W1A 1AA")).toBe("W1A 1AA");
    expect(normalisePostcode("HX7 8AB")).toBe("HX7 8AB");
    for (const bad of ["", "LS6", "12345", "LS6 2A", "LS6 2AAA", "L$6 2AA"]) expect(normalisePostcode(bad), bad).toBeNull();
  });

  it("knows every West Yorkshire postcode in use, by ward and district", () => {
    expect(list.size).toBeGreaterThan(60_000);
    expect(list.lookup("LS2 9JT")).toEqual({ ward: "Little London & Woodhouse", district: "Leeds" });
    expect(list.lookup("bd1 1af")).toEqual({ ward: "City", district: "Bradford" });
    for (const pc of ["HX1 1AA", "HD1 1AA", "WF1 1AA", "OL14 5AA"]) {
      const found = list.lookup(pc);
      if (found) expect(["Bradford", "Calderdale", "Kirklees", "Leeds", "Wakefield"]).toContain(found.district);
    }
  });

  it("does not know postcodes outside West Yorkshire, or ones not in use", () => {
    expect(list.lookup("SW1A 1AA")).toBeNull(); // Buckingham Palace
    expect(list.lookup("HG1 1AA")).toBeNull(); // Harrogate, North Yorkshire
    expect(list.lookup("LS24 9AA")).toBeNull(); // Tadcaster: an LS postcode outside West Yorkshire
    expect(list.lookup("not a postcode")).toBeNull();
  });

  it("covers the five districts, and every outward code it lists is a real one", () => {
    const text = readFileSync(`${dir}${file}`, "utf8");
    const districts = new Set([...text.matchAll(/^@area \d+ .+\|(.+)$/gm)].map((m) => m[1]));
    expect([...districts].sort()).toEqual(["Bradford", "Calderdale", "Kirklees", "Leeds", "Wakefield"]);
    for (const m of text.matchAll(/^([A-Z]{1,2}[0-9][A-Z0-9]?) /gm)) expect(normalisePostcode(`${m[1]} 1AA`), m[1]).not.toBeNull();
  });
});
