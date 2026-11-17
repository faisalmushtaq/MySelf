import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Illustration } from "./components/illustrations.js";

const draw = (token: string) => renderToStaticMarkup(createElement(Illustration, { token }));

// The hairstyle pictures (D-99): every option the library pictures must draw
// something, or a participant would see a blank tile with only a label.
const HAIRSTYLES = ["loose", "tied", "cornrows_thick", "cornrows_thin", "braids", "twists", "locs", "weave", "extensions", "wig", "short"];

describe("hairstyle pictures", () => {
  it.each(HAIRSTYLES)("draws %s, hidden from screen readers", (name) => {
    const svg = draw(`hairstyle:${name}`);
    expect(svg).toMatch(/^<svg[^>]*aria-hidden="true"/);
    expect(svg).toMatch(/<(path|circle|ellipse|rect)\b/);
  });

  it("draws nothing for a name it does not know", () => {
    expect(draw("hairstyle:unknown")).toBe("");
  });

  it("keeps the hair-type and hairstyle families apart", () => {
    expect(draw("hair:4c")).toContain("<path");
    expect(draw("hairstyle:4c")).toBe("");
  });
});
