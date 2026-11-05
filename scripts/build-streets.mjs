#!/usr/bin/env node
/**
 * Build the West Yorkshire street list the address question matches against
 * when someone does not know their postcode (D-53), from Ordnance Survey's
 * OS Open Names (CSV, Open Government Licence):
 *
 *   https://api.os.uk/downloads/v1/products/OpenNames/downloads?area=GB&format=CSV&redirect
 *
 *   node scripts/build-streets.mjs <unzipped OS Open Names dir> <edition, e.g. 2026-07>
 *
 * Every "Named Road" in the five West Yorkshire districts is kept, once per
 * area and postcode district it runs through. The files are split by 10 km
 * grid square; West Yorkshire lies in the SD and SE 100 km squares, and SK is
 * read too so its southern edge can never be cut off by a boundary. Filtering
 * is by district name, so reading extra squares only costs time.
 *
 * Output, one block per area and postcode district:
 *
 *   @Headingley|Leeds|LS6
 *   Hyde Park Road
 *   …
 *
 * The file is dated by the edition, so a newer edition is a new file: a
 * release points at the list it was published with, by hash.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WEST_YORKSHIRE = ["Bradford", "Calderdale", "Kirklees", "Leeds", "Wakefield"];
const REGIONS = {
  // The 100 km grid squares to read: those the region lies in, and neighbours where a boundary comes close.
  "west-yorkshire": { name: "West Yorkshire", districts: WEST_YORKSHIRE, squares: ["SD", "SE", "SK"] },
  // Every council in Yorkshire and the Humber (D-83).
  "yorkshire-humber": {
    name: "Yorkshire and the Humber",
    districts: [
      ...WEST_YORKSHIRE,
      "Barnsley",
      "Doncaster",
      "Rotherham",
      "Sheffield",
      "North Yorkshire",
      "York",
      "East Riding of Yorkshire",
      "City of Kingston upon Hull",
      "North Lincolnshire",
      "North East Lincolnshire",
    ],
    squares: ["NY", "NZ", "SD", "SE", "SK", "TA", "TF"],
  },
};
const [dir, edition, regionKey = "west-yorkshire"] = process.argv.slice(2);
const region = REGIONS[regionKey];
if (!dir || !/^\d{4}-\d{2}$/.test(edition ?? "") || !region) {
  console.error(`Usage: node scripts/build-streets.mjs <OS Open Names dir> <edition YYYY-MM> [${Object.keys(REGIONS).join("|")}]`);
  process.exit(1);
}
const DISTRICTS = new Set(region.districts);

/** Minimal RFC 4180 reader: names such as "Leeds Road, The" are quoted. */
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
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const header = readFileSync(join(dir, "Doc", "OS_Open_Names_Header.csv"), "utf8").replace(/^﻿/, "").trim().split(",");
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`OS Open Names header has no ${name}`);
  return i;
};
const NAME1 = col("NAME1");
const LOCAL_TYPE = col("LOCAL_TYPE");
const PLACE = col("POPULATED_PLACE");
const BOROUGH = col("DISTRICT_BOROUGH");
// Unitary councils (North Yorkshire, York, Hull, …) have no district: their name is in COUNTY_UNITARY.
const UNITARY = col("COUNTY_UNITARY");
const OUTWARD = col("POSTCODE_DISTRICT");

/** area|district|outward -> street names */
const blocks = new Map();
let kept = 0;
const squares = new RegExp(`^(${region.squares.join("|")})\\d\\d\\.csv$`);
const files = readdirSync(join(dir, "Data")).filter((f) => squares.test(f));
for (const file of files) {
  for (const r of parseCsv(readFileSync(join(dir, "Data", file), "utf8"))) {
    const council = r[BOROUGH] || r[UNITARY];
    if (r[LOCAL_TYPE] !== "Named Road" || !DISTRICTS.has(council)) continue;
    const name = (r[NAME1] ?? "").trim();
    if (!name || name.includes("|") || name.startsWith("@")) continue;
    const key = [r[PLACE] ?? "", council, (r[OUTWARD] ?? "").replace(/\s/g, "")].join("|");
    const set = blocks.get(key) ?? new Set();
    if (!set.has(name)) kept += 1;
    set.add(name);
    blocks.set(key, set);
  }
}

const lines = [
  `# ${region.name} named roads, OS Open Names ${edition}. Contains OS data © Crown copyright and database rights ${edition.slice(0, 4)}. Open Government Licence v3.0.`,
];
for (const key of [...blocks.keys()].sort()) {
  lines.push(`@${key}`);
  for (const name of [...blocks.get(key)].sort()) lines.push(name);
}
// Every council must have streets: a name that does not match OS's spelling would leave one out silently.
const boroughs = new Set([...blocks.keys()].map((k) => k.split("|")[1]));
const missing = region.districts.filter((d) => !boroughs.has(d));
if (missing.length) throw new Error(`no streets found for ${missing.join(", ")}: check the DISTRICT_BOROUGH spelling in OS Open Names`);
const out = join("releases", "assets", `streets-${regionKey}-${edition}.txt`);
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`${out}: ${kept} streets in ${blocks.size} area/postcode-district blocks, from ${files.length} grid files`);
