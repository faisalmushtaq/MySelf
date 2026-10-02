/**
 * Restores this tab asked for.
 *
 * A restore rewrites the draft on the server, and the draft editor sees it
 * arrive like anybody else's save. When it was THIS tab that asked, the editor
 * records it as an undoable step instead of clearing its history, so Undo
 * brings back what was in the draft before. The listener's snapshot and the
 * callable's answer can arrive in either order, so the intent is registered
 * before the call and matched on the revision the restore creates: the one it
 * expected plus one, corrected by the answer if the server says otherwise.
 */

interface RestoreIntent {
  surveyId: string;
  version: string;
  revision: number;
  expires: number;
}

const INTENT_LIFETIME_MS = 5 * 60_000;
const intents = new Set<RestoreIntent>();

export interface PendingRestore {
  /** The server said which revision the restore wrote. */
  confirm: (revision: number) => void;
  /** The call failed: nothing was restored. */
  cancel: () => void;
}

export function expectRestore(surveyId: string, version: string, expectedRevision: number, now = Date.now()): PendingRestore {
  const intent: RestoreIntent = { surveyId, version, revision: expectedRevision + 1, expires: now + INTENT_LIFETIME_MS };
  intents.add(intent);
  return {
    confirm: (revision) => {
      // Only if the snapshot has not claimed it already.
      if (intents.has(intent)) intent.revision = revision;
    },
    cancel: () => void intents.delete(intent),
  };
}

/** Claim a restore this tab started, if `revision` is the one it produced. */
export function takeRestoreIntent(surveyId: string, revision: number, now = Date.now()): { version: string } | null {
  for (const intent of intents) {
    if (intent.expires < now) {
      intents.delete(intent);
      continue;
    }
    if (intent.surveyId === surveyId && intent.revision === revision) {
      intents.delete(intent);
      return { version: intent.version };
    }
  }
  return null;
}
