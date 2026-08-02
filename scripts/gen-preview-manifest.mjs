// Generates the PUBLIC-PREVIEW manifest: identical structure to the frozen
// r1.0.0 release, but with the item wording of validated instruments redacted.
// Rationale: licensed instruments (notably SDQ — youthinmind restricts
// electronic distribution) must not be served from a publicly reachable URL.
// Bespoke study modules (the team's own wording) remain verbatim.
import { readFileSync, writeFileSync } from "node:fs";

const VALIDATED = [
  "kss@",
  "ehi_sf@",
  "macarthur_ssy@",
  "swemwbs@",
  "sdq25_s@",
  "rcads25@",
  "stai5_s@",
  "bisbas12_ybm@",
  "doomscroll4@",
];

const manifest = JSON.parse(readFileSync("releases/ybm_nd2026_standard_r1.0.0.manifest.json", "utf8"));

for (const [key, def] of Object.entries(manifest.instruments)) {
  if (!VALIDATED.some((v) => key.startsWith(v))) continue;
  for (const form of def.forms) {
    if (form.instructions) {
      form.instructions = `[${def.name}: instructions hidden in this public preview — licensed instrument]`;
    }
    let n = 0;
    for (const item of form.items) {
      n += 1;
      if (item.responseType === "info") {
        item.stem = { text: `[${def.name}: descriptive text hidden in this public preview]` };
      } else {
        item.stem = { text: `[${def.name} — item ${n} of ${form.items.length}. Wording hidden in this public preview of a licensed instrument.]` };
      }
    }
  }
}

manifest.composition.title += " — public preview (licensed item wording hidden)";
delete manifest.hash; // redaction invalidates the frozen hash by design

writeFileSync("releases/preview.manifest.json", JSON.stringify(manifest, null, 2));
console.log("preview manifest written (validated-instrument wording redacted)");
