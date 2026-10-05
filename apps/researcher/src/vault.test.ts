import { describe, expect, it } from "vitest";
import { createVault, openVault, openWith, passphraseComplaint, sealWith } from "./lib/vault.js";

/**
 * The identity vault.
 *
 * This holds the only identifying data in the platform — names, dates of birth,
 * UPNs, NHS numbers — which sat in IndexedDB in the clear, in a browser with no
 * sign-in and no lock, on a laptop that goes home in a bag. Everywhere else the
 * identity boundary is a separate Firebase project with separate IAM; this was
 * that boundary's one weak end, and the end a person actually uses.
 *
 * So the tests are about the two ways an encrypted store is worse than none: one
 * that the right passphrase cannot open, and one that the wrong passphrase can.
 */

const PHRASE = "four long honest words";

const person = {
  givenName: "Ada",
  familyName: "Lovelace",
  dateOfBirth: "2012-05-14",
  upn: "A123456789012",
  nhsNumber: "4857773456",
  claims: [{ sessionId: "ses_1", claimedCode: "NDC0042" }],
};

describe("locking and unlocking", () => {
  it("opens with the passphrase it was created with", async () => {
    const { record, key } = await createVault(PHRASE);
    const sealed = await sealWith(key, person);
    const reopened = await openVault(record, PHRASE);
    expect(await openWith(reopened, sealed)).toEqual(person);
  });

  it("says plainly that a wrong passphrase is wrong", async () => {
    // The verifier exists for this. Without it a wrong passphrase would surface
    // much later as a person whose name decrypted to nonsense.
    const { record } = await createVault(PHRASE);
    await expect(openVault(record, "four long honest word")).rejects.toThrow(/not the passphrase/);
  });

  it("does not store the passphrase anywhere in the record", async () => {
    const { record } = await createVault(PHRASE);
    expect(JSON.stringify(record)).not.toContain(PHRASE);
    expect(JSON.stringify(record)).not.toContain("honest");
  });

  it("uses a different salt per laptop, so one cracked vault is not all of them", async () => {
    const a = await createVault(PHRASE);
    const b = await createVault(PHRASE);
    expect(a.record.salt).not.toBe(b.record.salt);
  });

  it("refuses a record whose verifier decrypts to the wrong thing", async () => {
    // A damaged store and a wrong passphrase call for different responses, and
    // the known plaintext is what makes them distinguishable.
    const { record, key } = await createVault(PHRASE);
    const damaged = { ...record, check: await sealWith(key, "something else entirely") };
    await expect(openVault(damaged, PHRASE)).rejects.toThrow(/damaged/);
  });
});

describe("what is written to disk", () => {
  it("leaves nothing identifying in the sealed blob", async () => {
    const { key } = await createVault(PHRASE);
    const blob = await sealWith(key, person);
    // Only base64 is written, so no quote, brace or colon of the person's record
    // survives in it. A bare "Ada" is three base64 characters and turns up in a
    // random ciphertext now and then, so the name is looked for as a JSON value.
    expect(Object.keys(blob).sort()).toEqual(["data", "iv"]);
    for (const part of [blob.iv, blob.data]) expect(part).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const sealed = JSON.stringify(blob);
    expect(sealed).not.toContain("Lovelace");
    expect(sealed).not.toContain('"Ada"');
    expect(sealed).not.toContain("2012-05-14");
    expect(sealed).not.toContain("4857773456");
  });

  it("seals the same person differently each time, so repeats reveal nothing", async () => {
    const { key } = await createVault(PHRASE);
    const a = await sealWith(key, person);
    const b = await sealWith(key, person);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("will not open a blob under a key from another vault", async () => {
    const a = await createVault(PHRASE);
    const b = await createVault("a different set of words");
    const sealed = await sealWith(a.key, person);
    await expect(openWith(b.key, sealed)).rejects.toThrow();
  });
});

describe("what counts as a passphrase", () => {
  it("asks for length rather than punctuation", () => {
    expect(passphraseComplaint("four long honest words")).toBeNull();
    expect(passphraseComplaint("Passw0rd!")).toMatch(/12 characters/);
  });

  it("will not create a vault under one it complained about", async () => {
    await expect(createVault("short")).rejects.toThrow(/12 characters/);
  });
});
