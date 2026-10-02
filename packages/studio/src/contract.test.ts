import { describe, expect, it } from "vitest";
import { atLeast, ROLE_LEVEL, STUDIO_ROLES } from "./contract.js";

describe("Studio roles", () => {
  it("rank each role above the one before it, as the rules assume", () => {
    const levels = STUDIO_ROLES.map((r) => ROLE_LEVEL[r]);
    expect(levels).toEqual([1, 2, 3, 4]);
  });

  it("include everything below them and nothing above", () => {
    expect(atLeast("publisher", "editor")).toBe(true);
    expect(atLeast("editor", "publisher")).toBe(false);
    expect(atLeast(null, "viewer")).toBe(false);
  });
});
