import { describe, expect, it } from "vitest";
import {
  assessBackup,
  backupKey,
  clearBackup,
  currentRecoveryKind,
  readBackup,
  writeBackup,
  type DraftBackup,
  type StorageLike,
} from "./backup.js";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const slot = { surveyId: "ybm", uid: "u1" };
const backup: DraftBackup = { surveyId: "ybm", uid: "u1", baseRevision: 4, content: '{"mine":true}', savedAt: 1000 };
const current = (revision: number, content: string, uid = "u1", surveyId = "ybm") => ({ surveyId, uid, revision, content });

describe("unsaved-work backups", () => {
  it("round-trips through storage", () => {
    const s = memoryStorage();
    expect(writeBackup(s, backup)).toBe(true);
    expect(readBackup(s, slot)).toEqual(backup);
    clearBackup(s, slot);
    expect(readBackup(s, slot)).toBeNull();
  });

  it("is offered back when it was taken against the revision that is saved now", () => {
    expect(assessBackup(backup, current(4, '{"saved":true}'))).toBe("recoverable");
  });

  it("is not offered when it matches what is already saved", () => {
    expect(assessBackup(backup, current(5, backup.content))).toBe("none");
    expect(assessBackup(backup, current(4, backup.content))).toBe("none");
  });

  it("is never applied once the draft has moved on — only offered as a download", () => {
    expect(assessBackup(backup, current(6, "{}"))).toBe("stale");
  });

  it("belongs to one survey", () => {
    expect(assessBackup(backup, current(4, "{}", "u1", "other"))).toBe("none");
    const s = memoryStorage();
    writeBackup(s, backup);
    expect(readBackup(s, { surveyId: "other", uid: "u1" })).toBeNull();
  });

  it("belongs to one person: a colleague signing in to the same tab is never offered it", () => {
    expect(assessBackup(backup, current(4, "{}", "u2"))).toBe("none");
    const s = memoryStorage();
    writeBackup(s, backup);
    expect(readBackup(s, { surveyId: "ybm", uid: "u2" })).toBeNull();
    // And their own work does not overwrite it.
    writeBackup(s, { ...backup, uid: "u2", content: "{}" });
    expect(readBackup(s, slot)).toEqual(backup);
  });

  it("ignores anything in storage that is not a backup", () => {
    const s = memoryStorage();
    s.data.set(backupKey(slot), "not json");
    expect(readBackup(s, slot)).toBeNull();
    s.data.set(backupKey(slot), JSON.stringify({ ...backup, baseRevision: "4" }));
    expect(readBackup(s, slot)).toBeNull();
  });

  it("never throws when the browser refuses storage", () => {
    const refusing: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(writeBackup(refusing, backup)).toBe(false);
    expect(readBackup(refusing, slot)).toBeNull();
    expect(() => clearBackup(refusing, slot)).not.toThrow();
    expect(writeBackup(null, backup)).toBe(false);
  });
});

describe("whether a backup can still be put back", () => {
  it("only while the working copy is still based on the revision the backup was taken against", () => {
    expect(currentRecoveryKind("recoverable", 4, 4, false)).toBe("recoverable");
    // A colleague's save was adopted, or this tab saved, after the page loaded:
    // putting the copy back now would overwrite that save as an ordinary edit.
    expect(currentRecoveryKind("recoverable", 4, 5, false)).toBe("stale");
  });

  it("never for somebody who cannot edit (a viewer, or during a conflict)", () => {
    expect(currentRecoveryKind("recoverable", 4, 4, true)).toBe("stale");
  });

  it("never turns a stale backup back into a recoverable one", () => {
    expect(currentRecoveryKind("stale", 4, 4, false)).toBe("stale");
  });
});
