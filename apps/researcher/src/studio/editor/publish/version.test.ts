import { describe, expect, it } from "vitest";
import { checkChoice, defaultBump, versionOptions } from "./version.js";

describe("choosing a version", () => {
  it("offers major, minor and patch after the latest, and only allows at least what the changes need", () => {
    const options = versionOptions("7.1.0", "minor");
    expect(options.map((o) => [o.bump, o.version, o.allowed])).toEqual([
      ["major", "8.0.0", true],
      ["minor", "7.2.0", true],
      ["patch", "7.1.1", false],
    ]);
    expect(options.find((o) => o.required)?.bump).toBe("minor");
    expect(options[2]!.reason).toMatch(/never a patch/);
  });

  it("allows only a major version for changes to the questions, and says why", () => {
    const options = versionOptions("r7.1.0", "major");
    expect(options.filter((o) => o.allowed).map((o) => o.version)).toEqual(["8.0.0"]);
    expect(options[1]!.reason).toMatch(/major version/);
    expect(options[2]!.reason).toMatch(/major version/);
  });

  it("offers one first version for a survey never published", () => {
    const options = versionOptions(null, "major");
    expect(options).toHaveLength(1);
    expect(options[0]!.version).toBe("1.0.0");
  });

  it("defaults to the smallest bump allowed", () => {
    expect(defaultBump("major")).toBe("major");
    expect(defaultBump("patch")).toBe("patch");
  });

  it("checks a choice as the server does", () => {
    expect(checkChoice("7.1.0", "major", "minor")).toEqual({ ok: true, version: "8.0.0" });
    expect(checkChoice("7.1.0", "minor", "minor")).toEqual({ ok: true, version: "7.2.0" });
    const small = checkChoice("7.1.0", "patch", "minor");
    expect(small.ok).toBe(false);
    expect(!small.ok && small.message).toMatch(/lowest version allowed is r7\.2\.0/);
    expect(checkChoice("7.1.0", null, "minor")).toEqual({ ok: false, message: "Choose a version number." });
    expect(checkChoice("not a version", "major", "major").ok).toBe(false);
  });
});
