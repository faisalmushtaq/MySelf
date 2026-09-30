import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyDraft, extractDraft, previewRelease } from "./draft.js";
import { manifestIndex, publishedScaleCodes, reservedFrom } from "./history.js";
import { liveQuestions } from "./walk.js";

const releases = resolve(__dirname, "../../../releases");
const read = (file: string): unknown => JSON.parse(readFileSync(resolve(releases, file), "utf8"));
const files = readdirSync(releases).filter((f) => /_r\d+\.\d+\.\d+\.manifest\.json$/.test(f));
const studioEra = ["5.0.0", "6.0.0", "7.0.0", "7.0.1", "7.1.0"].map((v) => read(`ybm_nd2026_standard_r${v}.manifest.json`));

describe("manifestIndex", () => {
  it("lists what r5.0.0 to r7.1.0 administered, one variable per question", () => {
    const counts = studioEra.map((m) => manifestIndex(m).itemKeys.length);
    // r6.0.0 dropped the two sleep-priority questions and added one (D-31).
    expect(counts).toEqual([148, 147, 147, 147, 147]);
    for (const manifest of studioEra) {
      const { itemKeys, variables } = manifestIndex(manifest);
      expect(new Set(itemKeys).size).toBe(itemKeys.length);
      expect(variables).toHaveLength(itemKeys.length);
      // Agrees with the Studio's own walk of the same release.
      const walked = liveQuestions(extractDraft(manifest));
      expect(itemKeys).toEqual(walked.map((q) => q.itemKey));
      expect(variables).toEqual(walked.map((q) => q.item.variable));
    }
  });

  it("reads releases older than today's schema", () => {
    for (const file of files) expect(manifestIndex(read(file)).itemKeys.length).toBeGreaterThan(100);
  });

  it("follows placement subsets", () => {
    const draft = emptyDraft({ surveyId: "pilot_2027", study: "ybm", title: "Pilot" });
    const module = Object.values(draft.instruments)[0]!;
    module.forms[0]!.items.push({ ...module.forms[0]!.items[0]!, key: "unused", variable: "unused" });
    const manifest = previewRelease(draft).manifest;
    expect(manifestIndex(manifest)).toEqual({ itemKeys: ["ybm_studio.welcome"], variables: ["welcome"] });
  });

  it("refuses something that is not a manifest rather than reserving nothing", () => {
    expect(() => manifestIndex({})).toThrow(/not a release manifest/);
  });
});

describe("reservedFrom", () => {
  it("unions every version, keeping which variable went with which question", () => {
    const reserved = reservedFrom(studioEra.map(manifestIndex));
    expect(reserved.itemKeys.size).toBeGreaterThanOrEqual(148);
    expect(reserved.variables.has("sdq25_q1")).toBe(true);
    expect([...reserved.variablesByItem!.get("sdq25_s.q1")!]).toEqual(["sdq25_q1"]);
  });

  it("drops the pairing when a version's lists do not line up", () => {
    const reserved = reservedFrom([{ itemKeys: ["a.b", "a.c"], variables: ["b"] }]);
    expect(reserved.variablesByItem).toBeUndefined();
    expect([...reserved.itemKeys]).toEqual(["a.b", "a.c"]);
  });
});

describe("publishedScaleCodes", () => {
  it("keeps each code's latest label, whatever order the releases come in", () => {
    const older = structuredClone(studioEra[0]) as { release: { version: string }; scales: Record<string, { options: { code: number; label: string }[] }> };
    older.scales["scale.yes_no"]!.options[0]!.label = "Yep";
    const codes = publishedScaleCodes([studioEra[4], older]);
    expect(codes.get("scale.yes_no")?.get(1)).toBe("Yes");
    expect(codes.get("scale.sdq_3pt")?.get(2)).toBe("Certainly True");
    // Scales since dropped are still remembered: their codes were answered.
    expect(codes.has("scale.sleep_know_12")).toBe(true);
  });

  it("ignores junk", () => {
    expect(publishedScaleCodes([null, 3, { scales: { x: { options: [{ code: "1" }] } } }]).get("x")?.size).toBe(0);
  });
});
