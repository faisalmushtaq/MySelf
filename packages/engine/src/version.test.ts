import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "./version.js";

describe("the engine version a device checks releases against", () => {
  it("is the version in package.json", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      version: string;
    };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });
});
