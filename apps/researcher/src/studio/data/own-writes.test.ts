import { describe, expect, it } from "vitest";
import { MAX_REMEMBERED_ATTEMPTS, landedAttempt, rememberAttempt, type SaveAttempt } from "./own-writes.js";

const attempt = (baseRevision: number, content: string, edits = 1): SaveAttempt => ({ baseRevision, content, edits });

describe("recognising our own write", () => {
  const list = [attempt(4, "A", 1), attempt(4, "B", 3)];

  it("is the revision after the attempt's base, by this account, with exactly its content", () => {
    expect(landedAttempt(list, { revision: 5, updatedBy: "me", content: "B" }, "me")).toEqual(attempt(4, "B", 3));
    expect(landedAttempt(list, { revision: 5, updatedBy: "me", content: "A" }, "me")).toEqual(attempt(4, "A", 1));
  });

  it("is never somebody else’s write, even with the same content", () => {
    expect(landedAttempt(list, { revision: 5, updatedBy: "them", content: "B" }, "me")).toBeNull();
  });

  it("is never a different content or a different revision", () => {
    expect(landedAttempt(list, { revision: 5, updatedBy: "me", content: "C" }, "me")).toBeNull();
    expect(landedAttempt(list, { revision: 6, updatedBy: "me", content: "B" }, "me")).toBeNull();
    expect(landedAttempt(list, { revision: 4, updatedBy: "me", content: "B" }, "me")).toBeNull();
  });

  it("needs to know who is signed in", () => {
    expect(landedAttempt(list, { revision: 5, updatedBy: "me", content: "B" }, null)).toBeNull();
  });

  it("remembers only the most recent attempts", () => {
    let l: SaveAttempt[] = [];
    for (let i = 0; i < MAX_REMEMBERED_ATTEMPTS + 3; i++) l = rememberAttempt(l, attempt(i, `c${i}`));
    expect(l).toHaveLength(MAX_REMEMBERED_ATTEMPTS);
    expect(l[0]!.baseRevision).toBe(3);
  });
});
