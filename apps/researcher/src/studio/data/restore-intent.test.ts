import { describe, expect, it } from "vitest";
import { expectRestore, takeRestoreIntent } from "./restore-intent.js";

describe("restores this tab asked for", () => {
  it("is claimed by the revision the restore writes, whichever arrives first", () => {
    expectRestore("s1", "7.0.1", 4, 0);
    expect(takeRestoreIntent("s1", 4, 1)).toBeNull();
    expect(takeRestoreIntent("s1", 5, 1)).toEqual({ version: "7.0.1" });
    // Claimed once only.
    expect(takeRestoreIntent("s1", 5, 2)).toBeNull();
  });

  it("follows the server's answer when it names a different revision", () => {
    const pending = expectRestore("s2", "6.0.0", 10, 0);
    pending.confirm(12);
    expect(takeRestoreIntent("s2", 11, 1)).toBeNull();
    expect(takeRestoreIntent("s2", 12, 1)).toEqual({ version: "6.0.0" });
  });

  it("is forgotten when the restore failed, or after a while", () => {
    expectRestore("s3", "1.0.0", 1, 0).cancel();
    expect(takeRestoreIntent("s3", 2, 1)).toBeNull();
    expectRestore("s4", "1.0.0", 1, 0);
    expect(takeRestoreIntent("s4", 2, 60 * 60_000)).toBeNull();
  });

  it("belongs to one survey", () => {
    expectRestore("s5", "1.0.0", 1, 0);
    expect(takeRestoreIntent("other", 2, 1)).toBeNull();
    expect(takeRestoreIntent("s5", 2, 1)).toEqual({ version: "1.0.0" });
  });
});
