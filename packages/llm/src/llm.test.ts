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

describe("how the relay adapter says who it is", () => {
  /**
   * The scheme is the whole signal. The relay decides between verifying a
   * Firebase ID token and spending a tester link purely on the word in front
   * of the credential, so sending the wrong one is a 401 for a link that is
   * perfectly valid — and the page would report it as the model being down.
   */
  const sent = async (options: Record<string, unknown>) => (await request(options)).headers["authorization"] ?? null;

  it("sends a signed-in credential as Bearer", async () => {
    expect(await sent({ token: "abc" })).toBe("Bearer abc");
  });

  it("sends a tester link as Link", async () => {
    expect(await sent({ linkKey: "xyz" })).toBe("Link xyz");
  });

  it("prefers the link when a page has both", async () => {
    // A page opened from a tester link is acting as that link, not as whoever
    // happens to be signed in to Google in the same browser.
    expect(await sent({ token: "abc", linkKey: "xyz" })).toBe("Link xyz");
  });

  it("sends nothing at all rather than an empty credential", async () => {
    expect(await sent({})).toBeNull();
  });

  /**
   * A participant's iPad's own credential, handed to MyStory by the survey that
   * embedded it (D-55). The relay reads the same `Device` scheme `saveSitting`
   * does, so the iPad is one identity whichever endpoint it reaches.
   */
  it("sends a participant's iPad's credential as Device", async () => {
    expect(await sent({ deviceCredential: "ipad_01ABC.secret" })).toBe("Device ipad_01ABC.secret");
  });

  it("acts as the iPad rather than as whoever is signed in, and as a link above both", async () => {
    expect(await sent({ token: "abc", deviceCredential: "ipad_01ABC.secret" })).toBe("Device ipad_01ABC.secret");
    expect(await sent({ linkKey: "xyz", deviceCredential: "ipad_01ABC.secret" })).toBe("Link xyz");
  });
});

describe("a participant's iPad reaching its daily limit (D-55)", () => {
  const refusal = (limit: string | undefined) => ({
    kind: "rate_limit",
    message: "MyStory has had as many conversations as it can for today.",
    retryable: true,
    ...(limit ? { limit } : {}),
  });

  it("tells the page, with the relay's own words, and is not retried", async () => {
    const told: string[] = [];
    const error = await failure({ deviceCredential: "ipad_1.s", onLimit: (m: string) => void told.push(m) }, 429, refusal("study"));
    expect(told).toEqual(["MyStory has had as many conversations as it can for today."]);
    // Whatever the body says: the next attempt meets the same count.
    expect(error).toMatchObject({ kind: "rate_limit", retryable: false });
  });

  it("says nothing about a limit when the relay names none", async () => {
    // A busy provider is worth a retry and is not the end of anybody's day.
    const told: string[] = [];
    const error = await failure({ onLimit: (m: string) => void told.push(m) }, 502, refusal(undefined));
    expect(told).toEqual([]);
    expect(error).toMatchObject({ kind: "rate_limit", retryable: true });
  });
});

/** What the relay adapter throws when the relay answers with an error. */
async function failure(options: Record<string, unknown>, status: number, error: Record<string, unknown>): Promise<unknown> {
  const { RelayAdapter } = await import("./index.js");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status, json: async () => ({ error }) })) as unknown as typeof fetch;
  try {
    await new RelayAdapter({ url: "https://example.test/relay", ...options }).generate(
      { promptKey: "p.x", promptVersion: "1.0.0", system: "s", messages: [], variables: {} },
      {
        key: "mc.x",
        provider: "openai",
        model: "test-model",
        temperature: 0.7,
        maxOutputTokens: 100,
        timeoutSeconds: 30,
        maxAttempts: 1,
        dataHandling: { trainingUseOptOut: true },
      },
    );
  } catch (thrown) {
    return thrown;
  } finally {
    globalThis.fetch = original;
  }
  throw new Error("the refusal was not passed on");
}

describe("which release the relay adapter names", () => {
  /**
   * The relay runs the model config the sitting's release froze, which for a
   * version published from the Studio it can only know if told which release
   * that is (docs/16 §10.1).
   */
  it("sends the sitting's release hash with the config key, and nothing when there is none", async () => {
    const hash = `sha256:${"c".repeat(64)}`;
    expect((await request({ token: "t", releaseHash: hash })).body).toMatchObject({ modelConfigKey: "mc.x", releaseHash: hash });
    expect((await request({ token: "t" })).body).not.toHaveProperty("releaseHash");
  });

  it("sends the sitting's study beside it (D-56), and nothing for the default's", async () => {
    expect((await request({ deviceCredential: `ipad_1.${"s".repeat(43)}`, study: "future" })).body).toMatchObject({ study: "future" });
    expect((await request({ token: "t" })).body).not.toHaveProperty("study");
  });
});

/** What the relay adapter posts for one call: its headers and its body. */
async function request(options: Record<string, unknown>): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
  const { RelayAdapter } = await import("./index.js");
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    headers = init.headers;
    body = JSON.parse(init.body) as Record<string, unknown>;
    return { ok: true, json: async () => ({ text: "{}", modelServed: "gpt-4o" }) };
  }) as unknown as typeof fetch;
  try {
    await new RelayAdapter({ url: "https://example.test/relay", ...options }).generate(
      { promptKey: "p.x", promptVersion: "1.0.0", system: "s", messages: [{ role: "user", content: "hello" }], variables: {} },
      {
        key: "mc.x",
        provider: "openai",
        model: "gpt-4o",
        temperature: 0.7,
        maxOutputTokens: 100,
        timeoutSeconds: 30,
        maxAttempts: 1,
        dataHandling: { trainingUseOptOut: true },
      },
    );
  } catch {
    // The response shape is not what is under test; the request is.
  } finally {
    globalThis.fetch = original;
  }
  return { headers, body };
}
