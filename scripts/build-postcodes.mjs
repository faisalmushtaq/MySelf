#!/usr/bin/env node
/**
 * Build the West Yorkshire postcode list the address question checks against
 * (D-52), from the ONS Postcode Directory as published per local authority by
 * doogal.co.uk:
 *
 *   https://www.doogal.co.uk/AdministrativeAreasCSV?district=E08000032  Bradford
 *   https://www.doogal.co.uk/AdministrativeAreasCSV?district=E08000033  Calderdale
 *   https://www.doogal.co.uk/AdministrativeAreasCSV?district=E08000034  Kirklees
 *   https://www.doogal.co.uk/AdministrativeAreasCSV?district=E08000035  Leeds
 *   https://www.doogal.co.uk/AdministrativeAreasCSV?district=E08000036  Wakefield
 *
 *   node scripts/build-postcodes.mjs <dir with the CSVs, named <code>.csv> [region]
 *
 * The region is west-yorkshire (D-52, the five districts above, the default) or
 * yorkshire-humber (D-83): every council in Yorkshire and the Humber, so pupils
 * at a Leeds school who live in Harrogate, York or Hull are recognised too. For
 * yorkshire-humber it also writes the postcode districts the address finder
 * may suggest from (apps/functions/src/address-outwards.ts).
 *
 * Only postcodes in use are kept. The output is dated by the data's own
 * "Last Updated", so a newer list is a new file: a release points at the list
 * it was published with, by hash, and never at a list that changed under it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WEST_YORKSHIRE = {
  E08000032: "Bradford",
  E08000033: "Calderdale",
  E08000034: "Kirklees",
  E08000035: "Leeds",
  E08000036: "Wakefield",
};
const REGIONS = {
  "west-yorkshire": { name: "West Yorkshire", decision: "D-52", districts: WEST_YORKSHIRE },
  "yorkshire-humber": {
    name: "Yorkshire and the Humber",
    decision: "D-83",
    // Barnsley and Sheffield have had new codes since their 2023 boundary change.
    districts: {
      ...WEST_YORKSHIRE,
      E08000038: "Barnsley",
      E08000017: "Doncaster",
      E08000018: "Rotherham",
      E08000039: "Sheffield",
      E06000065: "North Yorkshire",
      E06000014: "York",
      E06000011: "East Riding of Yorkshire",
      E06000010: "Kingston upon Hull",
      E06000013: "North Lincolnshire",
      E06000012: "North East Lincolnshire",
    },
  },
};
const [dir, regionKey = "west-yorkshire"] = process.argv.slice(2);
const region = REGIONS[regionKey];
if (!dir || !region) {
  console.error(`Usage: node scripts/build-postcodes.mjs <dir with <code>.csv per council> [${Object.keys(REGIONS).join("|")}]`);
  process.exit(1);
}
const DISTRICTS = region.districts;

/** Minimal RFC 4180 reader: the files quote fields that contain commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) rows.push([...row, field]);
  return rows.filter((r) => r.length > 1);
}

const entries = [];
let updated = "";
for (const [code, district] of Object.entries(DISTRICTS)) {
  const [header, ...rows] = parseCsv(readFileSync(join(dir, `${code}.csv`), "utf8").replace(/^﻿/, ""));
  const col = (name) => {
    const at = header.indexOf(name);
    if (at < 0) throw new Error(`${code}.csv has no '${name}' column`);
    return at;
  };
  const [pc, inUse, ward, last] = [col("Postcode"), col("In Use?"), col("Ward"), col("Last Updated")];
  for (const r of rows) {
    if (r[last] > updated) updated = r[last];
    if (r[inUse] !== "Yes") continue;
    const postcode = r[pc].trim().toUpperCase();
    if (!/^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$/.test(postcode)) throw new Error(`unexpected postcode '${postcode}' in ${code}.csv`);
    entries.push({ postcode, area: `${r[ward].trim()}|${district}` });
  }
}

const areas = [...new Set(entries.map((e) => e.area))].sort((a, b) => {
  const [wa, da] = a.split("|");
  const [wb, db] = b.split("|");
  return da.localeCompare(db) || wa.localeCompare(wb);
});
const areaIndex = new Map(areas.map((a, i) => [a, i]));
const byOutward = new Map();
for (const e of entries) {
  const [outward, inward] = e.postcode.split(" ");
  if (!byOutward.has(outward)) byOutward.set(outward, []);
  byOutward.get(outward).push([inward, areaIndex.get(e.area)]);
}
const seen = new Set();
for (const e of entries) {
  if (seen.has(e.postcode)) throw new Error(`postcode ${e.postcode} appears twice`);
  seen.add(e.postcode);
}

const outwardOrder = [...byOutward.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const lines = [
  `# ${region.name} postcodes in use, with the council ward and district each lies in (${region.decision}).`,
  `# Source: ONS Postcode Directory, per local authority from doogal.co.uk (${regionKey === "west-yorkshire" ? "E08000032-E08000036" : Object.keys(DISTRICTS).join(", ")}), last updated ${updated}.`,
  `# Contains OS data (c) Crown copyright and database right ${updated.slice(0, 4)}. Contains Royal Mail data (c) Royal Mail copyright and database right ${updated.slice(0, 4)}.`,
  "# Source: Office for National Statistics, licensed under the Open Government Licence v3.0.",
  '# Format: "@area <n> <ward>|<district>" lines, then one line per outward code: "<outward> <inward>[=<n>] ...";',
  "# an inward code without =<n> is in the same area as the one before it.",
  ...areas.map((a, i) => `@area ${i} ${a}`),
  ...outwardOrder.map((outward) => {
    let previous = -1;
    const parts = byOutward
      .get(outward)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([inward, area]) => {
        const part = area === previous ? inward : `${inward}=${area}`;
        previous = area;
        return part;
      });
    return `${outward} ${parts.join(" ")}`;
  }),
];
const out = `releases/assets/postcodes-${regionKey}-${updated}.txt`;
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`${entries.length} postcodes in ${byOutward.size} outward codes and ${areas.length} wards -> ${out}`);

if (regionKey === "yorkshire-humber") {
  // The postcode districts with addresses in the region, for the address finder (D-81, D-83).
  const areasOf = [...new Set(outwardOrder.map((o) => o.replace(/\d.*$/, "")))].sort();
  const ts = [
    "// Generated by scripts/build-postcodes.mjs yorkshire-humber from the ONS Postcode Directory",
    `// (last updated ${updated}); do not edit. Contains OS data (c) Crown copyright and database right ${updated.slice(0, 4)}.`,
    "",
    `/** The postcode districts with ${region.name} addresses (${region.decision}). */`,
    `export const REGION_OUTWARDS: readonly string[] = ${JSON.stringify(outwardOrder)};`,
    "",
    "/** The postcode areas those districts are in. */",
    `export const REGION_AREAS: readonly string[] = ${JSON.stringify(areasOf)};`,
    "",
  ].join("\n");
  writeFileSync("apps/functions/src/address-outwards.ts", ts);
  console.log(`${outwardOrder.length} postcode districts in ${areasOf.length} areas -> apps/functions/src/address-outwards.ts`);
}
