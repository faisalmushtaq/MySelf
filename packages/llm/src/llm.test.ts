import { describe, expect, it } from "vitest";

describe("the public surface", () => {
  /**
   * An adapter that exists but is not exported is dead code, and looks
   * identical to one that works until something tries to import it.
   *
   * That happened to the relay: the file shipped, the export line did not, and
   * nothing could import it — for several commits, while it was described as
   * built. A file existing is not the same as a package offering it.
   */
  it("exports every adapter in the package", async () => {
    const index = (await import("./index.js")) as Record<string, unknown>;
    for (const name of ["MockAdapter", "OpenAiAdapter", "RelayAdapter"]) {
      expect(typeof index[name], `${name} is not exported from @myself/llm`).toBe("function");
    }
  });

  it("exports the gateway and the model config schema the apps build on", async () => {
    const index = (await import("./index.js")) as Record<string, unknown>;
    expect(typeof index["Gateway"]).toBe("function");
    expect(index["modelConfig"]).toBeDefined();
  });
});
