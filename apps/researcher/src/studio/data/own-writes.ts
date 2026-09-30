/**
 * Recognising this tab's own saves when their confirmation was lost.
 *
 * A save is a transaction. On a flaky connection the commit can reach the
 * server and the answer never come back: the SDK retries the transaction (it
 * then reads its own write), or gives up and reports "unavailable" (the
 * listener later delivers the write). Either way the tab meets a revision it
 * did not see itself save. Treated as somebody else's, that is a conflict
 * with itself — "you saved this draft while you were editing" — and a choice
 * nobody should have to make.
 *
 * So the hook remembers the last few writes it attempted and asks here
 * whether a revision it meets is one of them: the revision after the one the
 * attempt was based on, written by the same account, with byte-for-byte the
 * content that attempt sent. Anything less exact is left to the conflict path,
 * which never loses work.
 */

export interface SaveAttempt {
  /** The revision the attempt was saved against. */
  baseRevision: number;
  /** The exact draft JSON it sent. */
  content: string;
  /** How many local edits it carried (save-machine `inFlight.edits`). */
  edits: number;
}

/** A few are plenty: each failed attempt is retried within a minute. */
export const MAX_REMEMBERED_ATTEMPTS = 8;

export function rememberAttempt(list: readonly SaveAttempt[], attempt: SaveAttempt): SaveAttempt[] {
  return [...list, attempt].slice(-MAX_REMEMBERED_ATTEMPTS);
}

/** The attempt this stored draft is, if it is one of ours; else null. */
export function landedAttempt(
  list: readonly SaveAttempt[],
  stored: { revision: number; updatedBy?: string | null; content: string },
  uid: string | null,
): SaveAttempt | null {
  if (!uid || stored.updatedBy !== uid) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i]!;
    if (stored.revision === a.baseRevision + 1 && stored.content === a.content) return a;
  }
  return null;
}
