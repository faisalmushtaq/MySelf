import { describe, expect, it } from "vitest";
import { hashPin, lockedUntil, newPinRecord, pinComplaint, PIN_LOCKOUT_MS, PIN_MAX_ATTEMPTS, tryPin, type PinRecord } from "./lib/pin.js";

/**
 * The staff PIN in front of the handover panel (lib/pin.ts): stored only as a
 * salted hash, and five wrong tries lock the panel for five minutes.
 *
 * Few iterations here so the suite stays quick; the record carries its own
 * count, which is what makes that a faithful test of the real thing.
 */
const FAST = 1_000;
const t0 = new Date("2026-10-17T09:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("the staff PIN", () => {
  it("takes 4 to 8 digits and nothing else", () => {
    expect(pinComplaint("1234")).toBeNull();
    expect(pinComplaint("12345678")).toBeNull();
    for (const bad of ["", "123", "123456789", "12a4", " 1234", "１２３４"]) expect(pinComplaint(bad)).not.toBeNull();
  });

  it("is stored as a salted PBKDF2 hash, never as itself", async () => {
    const a = await newPinRecord("2468", t0, FAST);
    const b = await newPinRecord("2468", t0, FAST);
    expect(JSON.stringify(a)).not.toContain("2468");
    expect(a.iterations).toBe(FAST);
    // Salted: the same PIN twice is two different hashes.
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(Buffer.from(a.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(a.hash, "base64")).toHaveLength(32);
  });

  it("matches a known PBKDF2-SHA-256 vector, so it is the real derivation", async () => {
    // RFC 7914 §11 / widely published: P="passwd", S="salt", c=1, dkLen=32 (first 32 bytes of the 64-byte vector).
    const hash = await hashPin("passwd", new TextEncoder().encode("salt"), 1);
    expect(Buffer.from(hash, "base64").toString("hex")).toBe("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
  });

  it("refuses to store a PIN of the wrong shape", async () => {
    await expect(newPinRecord("12", t0, FAST)).rejects.toThrow(/4 to 8 digits/);
  });

  it("accepts the right PIN and clears the count of wrong ones", async () => {
    let record = await newPinRecord("2468", t0, FAST);
    const wrong = await tryPin(record, "1111", t0);
    expect(wrong.kind).toBe("refused");
    record = wrong.record;
    expect(record.failures).toBe(1);
    const right = await tryPin(record, "2468", t0);
    expect(right.kind).toBe("accepted");
    expect(right.record.failures).toBe(0);
  });

  it("locks for five minutes on the fifth wrong try, refusing even the right PIN meanwhile", async () => {
    let record: PinRecord = await newPinRecord("2468", t0, FAST);
    for (let i = 1; i < PIN_MAX_ATTEMPTS; i += 1) {
      const attempt = await tryPin(record, "0000", t0);
      expect(attempt).toMatchObject({ kind: "refused", triesLeft: PIN_MAX_ATTEMPTS - i });
      record = attempt.record;
    }
    const fifth = await tryPin(record, "0000", t0);
    expect(fifth.kind).toBe("locked");
    record = fifth.record;
    expect(lockedUntil(record, t0)?.getTime()).toBe(t0.getTime() + PIN_LOCKOUT_MS);

    // Locked: the right PIN is not even looked at.
    const during = await tryPin(record, "2468", later(PIN_LOCKOUT_MS - 1_000));
    expect(during.kind).toBe("locked");
    expect(during.record).toEqual(record);

    // Over: the right PIN opens, and a fresh five tries are allowed.
    expect(lockedUntil(record, later(PIN_LOCKOUT_MS))).toBeNull();
    const after = await tryPin(record, "2468", later(PIN_LOCKOUT_MS));
    expect(after.kind).toBe("accepted");
    expect(after.record.lockedUntil).toBeNull();
  });

  it("counts a malformed PIN as a wrong one rather than an error", async () => {
    const record = await newPinRecord("2468", t0, FAST);
    const attempt = await tryPin(record, "", t0);
    expect(attempt).toMatchObject({ kind: "refused", triesLeft: PIN_MAX_ATTEMPTS - 1 });
  });
});
