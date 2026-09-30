import { describe, expect, it } from "vitest";
import { snapshotAction } from "./snapshot-gate.js";

describe("which draft snapshots the editor starts from", () => {
  it("never starts from the local cache: it may hold a revision already saved over", () => {
    expect(snapshotAction({ exists: true, fromCache: true }, false)).toBe("wait");
  });

  it("starts from the server's copy", () => {
    expect(snapshotAction({ exists: true, fromCache: false }, false)).toBe("load");
  });

  it("does not call a draft missing because the cache has nothing (offline)", () => {
    expect(snapshotAction({ exists: false, fromCache: true }, false)).toBe("wait");
    expect(snapshotAction({ exists: false, fromCache: false }, false)).toBe("missing");
  });

  it("once started, hands every snapshot to the save machine, which ignores what it has already passed", () => {
    expect(snapshotAction({ exists: true, fromCache: true }, true)).toBe("remote");
    expect(snapshotAction({ exists: true, fromCache: false }, true)).toBe("remote");
    expect(snapshotAction({ exists: false, fromCache: false }, true)).toBe("wait");
  });
});
