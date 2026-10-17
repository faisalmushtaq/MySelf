import { afterEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ warn: [] as string[], error: [] as string[] }));
vi.mock("firebase-functions/logger", () => ({
  warn: (message: string) => logged.warn.push(message),
  error: (message: string) => logged.error.push(message),
  info: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  write: () => undefined,
}));

const { identityCaptureOff, registryFields, resetIdentityCaptureWarning } = await import("./identity.js");
const { identity } = await import("./apps.js");
type SittingIdentity = import("./identity.js").SittingIdentity;

describe("a deployment with no identity project", () => {
  const saved = process.env["IDENTITY_SERVICE_ACCOUNT"];
  afterEach(() => {
    if (saved === undefined) delete process.env["IDENTITY_SERVICE_ACCOUNT"];
    else process.env["IDENTITY_SERVICE_ACCOUNT"] = saved;
    resetIdentityCaptureWarning();
    logged.warn.length = 0;
    logged.error.length = 0;
  });

  it("stands capture down quietly: one warning per instance, not an error per sitting", () => {
    delete process.env["IDENTITY_SERVICE_ACCOUNT"];
    for (let i = 0; i < 50; i++) expect(identityCaptureOff()).toBe(true);
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toMatch(/identity capture is off.*IDENTITY_SERVICE_ACCOUNT is not set/);
    expect(logged.error).toEqual([]);
  });

  it("captures as before once it is configured", () => {
    process.env["IDENTITY_SERVICE_ACCOUNT"] = '{"project_id":"demo-identity"}';
    expect(identityCaptureOff()).toBe(false);
    expect(logged.warn).toEqual([]);
  });

  it("still fails loudly for anything that asked for a name, such as an owner's lookup", () => {
    delete process.env["IDENTITY_SERVICE_ACCOUNT"];
    expect(() => identity()).toThrow(/IDENTITY_SERVICE_ACCOUNT is not set/);
  });
});

/**
 * What the registry keeps from each sitting (D-52).
 *
 * The write itself — the transaction, and `mergeFields` replacing the address
 * whole — is proved against a real Firestore in the integration suite. This is
 * the decision.
 */

const sitting = (over: Partial<SittingIdentity> = {}): SittingIdentity => ({
  code: "P0000000001",
  study: "ybm",
  givenName: "Test",
  familyName: "Person",
  dateOfBirth: "2011-07-04",
  homeAddress: { postcode: "XX1 1XX", house: "1", street: "Example Street" },
  startedAt: "2026-09-29T10:00:00.000Z",
  ...over,
});

describe("registryFields", () => {
  it("files a first sitting as given, with the address dated by the sitting", () => {
    expect(registryFields({}, sitting())).toMatchObject({
      givenName: "Test",
      homeAddress: { postcode: "XX1 1XX", house: "1", street: "Example Street" },
      homeAddressRecordedAt: "2026-09-29T10:00:00.000Z",
      upn: null,
    });
  });

  it("keeps the name first given, but moves to the address from a later sitting", () => {
    const before = registryFields({}, sitting());
    const later = registryFields(
      before,
      sitting({ givenName: "Testy", homeAddress: { postcode: "XX2 2XX" }, startedAt: "2027-03-01T10:00:00.000Z" }),
    );
    expect(later["givenName"]).toBe("Test");
    // Replaced whole: the old house and street do not survive under the new postcode.
    expect(later["homeAddress"]).toEqual({ postcode: "XX2 2XX" });
    expect(later["homeAddressRecordedAt"]).toBe("2027-03-01T10:00:00.000Z");
  });

  it("does not let an older sitting that arrives late replace a newer address", () => {
    const before = registryFields({}, sitting({ startedAt: "2027-03-01T10:00:00.000Z" }));
    const late = registryFields(
      before,
      sitting({ homeAddress: { postcode: "XX9 9XX" }, startedAt: "2026-09-01T10:00:00.000Z" }),
    );
    expect(late["homeAddress"]).toEqual({ postcode: "XX1 1XX", house: "1", street: "Example Street" });
    expect(late["homeAddressRecordedAt"]).toBe("2027-03-01T10:00:00.000Z");
  });

  it("keeps the address on file when a sitting gives none", () => {
    const before = registryFields({}, sitting());
    const none = registryFields(before, sitting({ homeAddress: null, startedAt: "2027-03-01T10:00:00.000Z" }));
    expect(none["homeAddress"]).toEqual(before["homeAddress"]);
    expect(none["homeAddressRecordedAt"]).toBe("2026-09-29T10:00:00.000Z");
  });

  it("replaces an address filed before it was dated", () => {
    const legacy = { givenName: "Test", homeAddress: { postcode: "XX1 1XX" } };
    const next = registryFields(legacy, sitting({ homeAddress: { postcode: "XX3 3XX" } }));
    expect(next["homeAddress"]).toEqual({ postcode: "XX3 3XX" });
  });

  it("keeps a linked UPN and NHS number", () => {
    const next = registryFields({ upn: "A123456789012", nhsNumber: "9434765919" }, sitting());
    expect(next).toMatchObject({ upn: "A123456789012", nhsNumber: "9434765919" });
  });
});
