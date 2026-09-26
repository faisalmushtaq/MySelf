import { describe, expect, it } from "vitest";
import {
  ENCRYPTED_FORMAT,
  isEncryptedEnvelope,
  openExport,
  passphraseComplaint,
  sealExport,
  type EncryptedEnvelope,
} from "./envelope.js";

/**
 * The handover file.
 *
 * It used to be plaintext JSON of every answer a child gave, crossing a room on
 * a USB stick. These tests are mostly about the two failures that would make
 * encrypting it worse than not bothering: a file that cannot be opened by the
 * right passphrase, and a file that CAN be opened by the wrong one.
 *
 * The iteration count is deliberately not lowered for the tests. It is the whole
 * defence for a phrase typed by a person, and a suite that exercised a cheap
 * variant would not be testing what ships.
 */

const payload = {
  format: "myself.device.export.v1",
  sessions: [{ sessionId: "ses_01", studyCode: "NDC0042", events: [{ seq: 0, type: "session.started" }] }],
};

const PHRASE = "six brown otters reading";

describe("sealing a handover file", () => {
  it("comes back byte for byte with the right passphrase", async () => {
    const sealed = await sealExport(payload, PHRASE, 1);
    expect(await openExport(sealed, PHRASE)).toEqual(payload);
  });

  it("refuses the wrong passphrase, and names both things it could be", async () => {
    // GCM cannot tell a wrong key from a damaged file, so the message must not
    // claim to: the two call for opposite responses, and guessing sends somebody
    // looking in the wrong place.
    const sealed = await sealExport(payload, PHRASE, 1);
    await expect(openExport(sealed, "six brown otters reading!")).rejects.toThrow(/passphrase|damaged/);
  });

  it("refuses a file whose ciphertext was altered", async () => {
    const sealed = await sealExport(payload, PHRASE, 1);
    const flipped = sealed.data.slice(0, 20) + (sealed.data[20] === "A" ? "B" : "A") + sealed.data.slice(21);
    await expect(openExport({ ...sealed, data: flipped }, PHRASE)).rejects.toThrow();
  });

  it("puts nothing identifying in the clear", async () => {
    const sealed = await sealExport(payload, PHRASE, 1);
    const onDisk = JSON.stringify(sealed);
    expect(onDisk).not.toContain("NDC0042");
    expect(onDisk).not.toContain("ses_01");
    expect(onDisk).not.toContain("session.started");
    // The count and the timestamp ARE in the clear, on purpose: checking that a
    // handover produced six sittings should not require decrypting it.
    expect(sealed.sittings).toBe(1);
    expect(sealed.format).toBe(ENCRYPTED_FORMAT);
  });

  it("uses a fresh salt and iv per file, so two identical exports differ", async () => {
    // Reusing either would let somebody tell that two handovers held the same
    // sittings, and with AES-GCM an iv reused under one key is a break.
    const a = await sealExport(payload, PHRASE, 1);
    const b = await sealExport(payload, PHRASE, 1);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("survives a log big enough to break a naive base64", async () => {
    // A spread over a multi-megabyte array throws a RangeError that reads like a
    // corrupt export rather than a large one, so the encoding is chunked.
    const big = { sessions: [{ sessionId: "ses_big", events: Array.from({ length: 60_000 }, (_, i) => ({ seq: i, pad: "x".repeat(40) })) }] };
    const sealed = await sealExport(big, PHRASE, 1);
    expect(await openExport(sealed, PHRASE)).toEqual(big);
  });
});

describe("what counts as a passphrase", () => {
  it("wants length rather than punctuation, because an iPad keyboard is what types it", () => {
    expect(passphraseComplaint("four long honest words")).toBeNull();
    expect(passphraseComplaint("Tr0ub4dor&3")).toMatch(/12 characters/);
    expect(passphraseComplaint("   ")).toMatch(/12 characters/);
  });

  it("will not seal anything under a phrase it complained about", async () => {
    await expect(sealExport(payload, "short", 1)).rejects.toThrow(/12 characters/);
  });
});

describe("recognising one", () => {
  it("knows an envelope from a plaintext export", async () => {
    expect(isEncryptedEnvelope(await sealExport(payload, PHRASE, 1))).toBe(true);
    expect(isEncryptedEnvelope(payload)).toBe(false);
    expect(isEncryptedEnvelope(null)).toBe(false);
    expect(isEncryptedEnvelope("{}")).toBe(false);
  });

  it("refuses a file demanding an absurd amount of key work", async () => {
    // Otherwise a hostile or corrupt file hangs the importer on a KDF.
    const sealed = await sealExport(payload, PHRASE, 1);
    const greedy: EncryptedEnvelope = { ...sealed, kdf: { ...sealed.kdf, iterations: 900_000_000 } };
    await expect(openExport(greedy, PHRASE)).rejects.toThrow(/unreasonable/);
  });

  it("refuses a file built by a scheme it does not know", async () => {
    const sealed = await sealExport(payload, PHRASE, 1);
    const alien = { ...sealed, kdf: { ...sealed.kdf, name: "scrypt" as "PBKDF2" } };
    await expect(openExport(alien, PHRASE)).rejects.toThrow(/cannot read/);
  });
});
