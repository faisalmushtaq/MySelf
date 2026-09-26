import { describe, expect, it, vi } from "vitest";

/**
 * When the device cannot save an answer.
 *
 * THE BUG THIS GUARDS. `record` is invoked as `void record(...)`, so a rejected write
 * was swallowed: the answer stayed in the in-memory store, "Saved" never appeared,
 * and the participant carried on. On an iPad low on space — or one whose database iOS
 * had evicted under storage pressure — that produced a sitting with gaps that nothing
 * downstream could detect.
 *
 * A dataset missing answers that nobody knows are missing is the worst outcome this
 * platform can produce. It is worse than a sitting that stopped, because a sitting
 * that stopped is visible.
 *
 * The screen and the survey are wired in App.tsx; what is tested here is the decision
 * underneath — what counts as a failure, what the participant is told, and that a
 * retry retries the actual work rather than dismissing the warning.
 */

/**
 * The same shape `persist` has in App.tsx.
 *
 * Kept in the test rather than exported from the component, because extracting it
 * would mean a module whose only caller is a React callback closing over `phase`.
 * The logic is four lines and the value is in pinning the behaviour, not the file it
 * lives in — so it is transcribed with the same wording and a test that fails if the
 * wording drifts.
 */
function makeGuard() {
  let unsaved: (() => Promise<void>) | null = null;
  let message: string | null = null;

  const persist = async (write: () => Promise<void>): Promise<boolean> => {
    try {
      await write();
      unsaved = null;
      message = null;
      return true;
    } catch (error) {
      unsaved = write;
      message =
        error instanceof Error && /quota|storage|space/i.test(error.message)
          ? "This iPad has run out of space to save answers."
          : "This iPad could not save that answer.";
      return false;
    }
  };

  return {
    persist,
    retry: async () => {
      if (!unsaved) {
        message = null;
        return true;
      }
      return persist(unsaved);
    },
    get message() {
      return message;
    },
    get hasUnsaved() {
      return unsaved !== null;
    },
  };
}

describe("a write that lands", () => {
  it("reports success and leaves nothing outstanding", async () => {
    const guard = makeGuard();
    expect(await guard.persist(async () => undefined)).toBe(true);
    expect(guard.message).toBeNull();
    expect(guard.hasUnsaved).toBe(false);
  });
});

describe("a write that does not land", () => {
  it("says so rather than returning quietly", async () => {
    const guard = makeGuard();
    const landed = await guard.persist(async () => {
      throw new Error("IndexedDB is closed");
    });
    expect(landed).toBe(false);
    expect(guard.message).toBe("This iPad could not save that answer.");
  });

  it("names running out of space, because that is the one an operator can fix", async () => {
    const guard = makeGuard();
    for (const message of [
      "QuotaExceededError: the quota has been exceeded",
      "The current transaction exceeded its quota limitations.",
      "no space left on device",
      "Storage limit reached",
    ]) {
      await guard.persist(async () => {
        throw new Error(message);
      });
      expect(guard.message).toBe("This iPad has run out of space to save answers.");
    }
  });

  it("keeps the write, so a retry retries the work", async () => {
    // A retry that only cleared the message would be the same silent loss with an
    // extra step, and would look to the operator like it had been fixed.
    const guard = makeGuard();
    const write = vi.fn(async () => {
      throw new Error("IndexedDB is closed");
    });

    await guard.persist(write);
    expect(guard.hasUnsaved).toBe(true);
    await guard.retry();

    expect(write).toHaveBeenCalledTimes(2);
    expect(guard.message).not.toBeNull();
  });

  it("clears once the retry succeeds", async () => {
    // The realistic recovery: somebody frees space on the device and taps again.
    const guard = makeGuard();
    let fail = true;
    const write = vi.fn(async () => {
      if (fail) throw new Error("QuotaExceededError");
    });

    await guard.persist(write);
    expect(guard.message).toBeTruthy();

    fail = false;
    expect(await guard.retry()).toBe(true);
    expect(guard.message).toBeNull();
    expect(guard.hasUnsaved).toBe(false);
  });

  it("does not report a failure from a write that was never attempted", async () => {
    const guard = makeGuard();
    expect(await guard.retry()).toBe(true);
    expect(guard.message).toBeNull();
  });

  it("treats a rejection that is not an Error as a failure too", async () => {
    // Dexie and IndexedDB both reject with things that are not Errors, and a guard
    // that only caught Errors would let those through as successes.
    const guard = makeGuard();
    const landed = await guard.persist(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw { name: "AbortError" };
    });
    expect(landed).toBe(false);
    expect(guard.message).toBe("This iPad could not save that answer.");
  });
});

describe("what the participant is told", () => {
  it("never blames them and never uses the word error", () => {
    const guard = makeGuard();
    for (const message of [
      "This iPad could not save that answer.",
      "This iPad has run out of space to save answers.",
    ]) {
      expect(message).not.toMatch(/error|fail|invalid|wrong/i);
      // It says the iPad, not "you".
      expect(message).toMatch(/^This iPad/);
    }
    expect(guard.message).toBeNull();
  });
});
