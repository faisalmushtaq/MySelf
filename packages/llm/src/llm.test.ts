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

describe("routing a call to the relay", () => {
  /**
   * The gateway selects an adapter by the provider name in the config. A relay
   * is a transport, not a provider — the study says `openai` because that is
   * what will answer — so a relay registered under "relay" was never selected,
   * and the gateway threw "no adapter for provider 'openai'" before writing
   * any provenance row. On screen that was an unexplained transport failure
   * and an empty call log.
   */
  it("stands in for the provider the study declared", async () => {
    const { RelayAdapter } = await import("./index.js");
    expect(new RelayAdapter({ url: "https://example.test/relay" }).provider).toBe("openai");
    expect(new RelayAdapter({ url: "https://example.test/relay", serves: "anthropic" }).provider).toBe("anthropic");
  });

  it("is reachable through the gateway for an openai config", async () => {
    const { Gateway, RelayAdapter } = await import("./index.js");
    const calls: { status: string }[] = [];
    const gateway = new Gateway({
      adapters: [new RelayAdapter({ url: "https://example.test/relay", token: "t" })],
      onCall: (c) => {
        calls.push(c as { status: string });
      },
      sleep: async () => undefined,
    });

    const config = {
      key: "mc.openai.gpt4o.t07",
      provider: "openai" as const,
      model: "gpt-4o",
      temperature: 0.7,
      maxOutputTokens: 100,
      timeoutSeconds: 5,
      maxAttempts: 1,
      dataHandling: { trainingUseOptOut: true },
    };

    // The fetch will fail — there is no such host — but the point is that it
    // gets that far: an adapter was found, and the attempt is on the record.
    await expect(
      gateway.call({
        sessionId: "s",
        protocolKey: "np.x",
        stage: "interview",
        prompt: { promptKey: "p", promptVersion: "1", system: "s", messages: [], variables: {} },
        config,
      }),
    ).rejects.toThrow();
    expect(calls.length, "the gateway never even started a call").toBeGreaterThan(0);
  });
});
