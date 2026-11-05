import { beforeEach, describe, expect, it } from "vitest";
import { pickAddress, resetAddressFinder, suggestAddresses } from "./addresses.js";

const reply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

const base = { url: "https://example.invalid/findAddress", credential: async () => "Device abc.def", online: () => true };

describe("the address finder on the iPad (D-81)", () => {
  beforeEach(() => resetAddressFinder());

  it("asks with the iPad's own credential and passes the suggestions on", async () => {
    let sent: { headers: Record<string, string>; body: string } | null = null;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = { headers: init.headers as Record<string, string>, body: String(init.body) };
      return new Response(JSON.stringify({ status: "suggestions", suggestions: [{ id: "paf_1", label: "12 Hyde Park Road, Leeds, LS6" }] }));
    }) as unknown as typeof fetch;
    const found = await suggestAddresses("12 hyde  park", { ...base, fetch: fetchFn });
    expect(found).toEqual([{ id: "paf_1", label: "12 Hyde Park Road, Leeds, LS6" }]);
    expect(sent!.headers["authorization"]).toBe("Device abc.def");
    expect(JSON.parse(sent!.body)).toMatchObject({ search: "12 hyde park" });
  });

  it("fetches the chosen address", async () => {
    const address = { house: "12", street: "Hyde Park Road", postcode: "LS6 1AB", area: "Headingley, Leeds", postcodeDistrict: "LS6", uprn: "1" };
    expect(await pickAddress("paf_1", { ...base, fetch: reply({ status: "picked", address }) })).toEqual(address);
  });

  it("goes quiet for the session once the finder fails, so the street list answers", async () => {
    expect(await suggestAddresses("12 hyde park", { ...base, fetch: reply({ status: "unavailable" }) })).toBeNull();
    let asked = false;
    const fetchFn = (async () => {
      asked = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await suggestAddresses("12 hyde park", { ...base, fetch: fetchFn })).toBeNull();
    expect(asked).toBe(false);
  });

  it("does not ask offline, without a credential, or for too little", async () => {
    let asked = 0;
    const fetchFn = (async () => {
      asked += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await suggestAddresses("12 hyde park", { ...base, online: () => false, fetch: fetchFn })).toBeNull();
    expect(await suggestAddresses("12 hyde park", { ...base, credential: async () => null, fetch: fetchFn })).toBeNull();
    expect(await suggestAddresses("1 a", { ...base, fetch: fetchFn })).toBeNull();
    expect(asked).toBe(0);
  });

  it("treats a refusal or no reply as the finder failing", async () => {
    expect(await suggestAddresses("12 hyde park", { ...base, fetch: reply({ error: {} }, 429) })).toBeNull();
    resetAddressFinder();
    const hangs = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await pickAddress("paf_1", { ...base, fetch: hangs })).toBeNull();
  });
});
