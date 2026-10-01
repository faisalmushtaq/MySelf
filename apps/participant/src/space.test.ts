import { afterEach, describe, expect, it } from "vitest";
import { deviceSpace, LOW_SPACE_BYTES, readableBytes } from "./lib/space.js";

/**
 * How much room is left, and what the operator is told about it.
 *
 * This exists to catch a full iPad at handover rather than mid-sitting. The mid-sitting
 * case is already handled — the survey stops and asks for staff — but that is a
 * recovery, and swapping devices between participants costs nothing.
 *
 * Everything here is advisory by design, and the tests say so: a browser that refuses
 * to answer must not read as a device that is out of space, because the consequence
 * would be operators swapping working iPads for no reason and eventually ignoring the
 * warning that matters.
 */

const withEstimate = (estimate: (() => Promise<StorageEstimate>) | undefined) => {
  const had = Object.getOwnPropertyDescriptor(navigator, "storage");
  Object.defineProperty(navigator, "storage", {
    value: estimate ? { estimate } : {},
    configurable: true,
  });
  return () => {
    if (had) Object.defineProperty(navigator, "storage", had);
    else delete (navigator as unknown as Record<string, unknown>)["storage"];
  };
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("reading the space left", () => {
  it("reports what the browser says", async () => {
    restore = withEstimate(async () => ({ usage: 20 * 1024 ** 2, quota: 500 * 1024 ** 2 }));
    const space = await deviceSpace();
    expect(space.known).toBe(true);
    expect(space.used).toBe(20 * 1024 ** 2);
    expect(space.remaining).toBe(480 * 1024 ** 2);
    expect(space.low).toBe(false);
  });

  it("calls it low with less than ten megabytes left", async () => {
    // A full YBM sitting is about 54 kB, so ten megabytes is roughly two hundred
    // sittings of headroom — far more than a school day, and early enough to act on.
    restore = withEstimate(async () => ({ usage: 495 * 1024 ** 2, quota: 500 * 1024 ** 2 }));
    expect((await deviceSpace()).low).toBe(true);
    expect(LOW_SPACE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("does not treat a silent browser as a full one", async () => {
    // Safari omits `estimate` in some contexts. Warning then would have operators
    // swapping working iPads, and an operator who learns to ignore this warning will
    // ignore it on the day it is true.
    for (const estimate of [
      undefined,
      async () => ({}) as StorageEstimate,
      async () => ({ usage: 5, quota: 0 }) as StorageEstimate,
      async () => {
        throw new Error("not allowed");
      },
    ]) {
      restore?.();
      restore = withEstimate(estimate as (() => Promise<StorageEstimate>) | undefined);
      const space = await deviceSpace();
      expect(space.known).toBe(false);
      expect(space.low).toBe(false);
    }
  });

  it("never reports negative room, however odd the numbers are", async () => {
    // iOS has been known to report usage above quota.
    restore = withEstimate(async () => ({ usage: 600 * 1024 ** 2, quota: 500 * 1024 ** 2 }));
    const space = await deviceSpace();
    expect(space.remaining).toBe(0);
    expect(space.low).toBe(true);
  });
});

describe("saying it out loud", () => {
  it("rounds the way somebody reading a panel would", () => {
    expect(readableBytes(2 * 1024 ** 3)).toBe("2.0 GB");
    expect(readableBytes(45 * 1024 ** 2)).toBe("45 MB");
    expect(readableBytes(54 * 1024)).toBe("54 kB");
    expect(readableBytes(400)).toBe("400 bytes");
  });

  it("does not print a sitting's worth of storage as zero", () => {
    // 54 kB is one sitting. Rounding it to "0 MB" would make a nearly-full device look
    // empty in the panel.
    expect(readableBytes(54 * 1024)).not.toMatch(/^0/);
  });
});
