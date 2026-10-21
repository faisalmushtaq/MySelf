import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A Home Screen icon must open the address it was added from, so one saved
// from a participant link keeps ?study=…&survey=… (D-56). A start_url in the
// manifest overrides that, and every icon then opened the app bare.
describe("the Home Screen manifest", () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../public/manifest.webmanifest"), "utf8")) as Record<string, unknown>;

  it("has no start_url, so an icon keeps the link it was saved from", () => {
    expect(manifest).not.toHaveProperty("start_url");
  });

  it("is linked from the page and covers the app", () => {
    expect(readFileSync(resolve(__dirname, "../index.html"), "utf8")).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
    expect(manifest["scope"]).toBe("./");
    expect(manifest["display"]).toBe("standalone");
  });
});
