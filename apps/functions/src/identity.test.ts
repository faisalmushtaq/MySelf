import { describe, expect, it } from "vitest";
import { registryFields, type SittingIdentity } from "./identity.js";

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
