import { useMemo } from "react";
import { planModuleUpdate, updateFromModule, type PendingModuleUpdate } from "@myself/studio";
import { useLibraryModule } from "../../data/library.js";
import { formatDateTime, toDate } from "../../format.js";
import { LoadError } from "../../shell/common.js";
import { Dialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button, Notice, Skeleton } from "../../ui/kit.js";
import { useToast } from "../../ui/toast.js";
import { useEditor } from "../context.js";
import { LockBanner } from "../node/controls.js";
import { useLibraryUi } from "./LibraryContext.js";
import { OUTCOME_ATTENTION, OUTCOME_WORDS } from "./model.js";

/**
 * Update notices for questions copied from a saved module (docs/16 §12.6).
 * Nothing in a survey changes until somebody chooses: "Review" shows what an
 * update would do, question by question; "Update this survey's copy" applies
 * it as one edit; "Not now" puts this version off until a later one is saved.
 */

/** One quiet line on the block: a newer version is in the library. */
export function ModuleUpdateBanner({ update }: { update: PendingModuleUpdate }) {
  const ctx = useEditor();
  const lib = useLibraryUi();
  const title = lib.modules.get(update.moduleId)?.title ?? update.moduleId;
  return (
    <LockBanner
      icon="library"
      title={`A newer version of ‘${title}’ is in the library (v${update.to})`}
      info={`This survey’s copy is version ${update.from}. Nothing here changes until you choose to update it; “Not now” waits for the next version.`}
      infoLabel="module updates"
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={() => lib.review(update)}>
            Review
          </Button>
          <Button size="sm" variant="ghost" onClick={() => lib.dismiss(update)} disabled={!ctx.canEdit}>
            Not now
          </Button>
        </>
      }
    />
  );
}

export function ModuleUpdateDialog({ update, title, onClose }: { update: PendingModuleUpdate; title: string; onClose: () => void }) {
  const ctx = useEditor();
  const lib = useLibraryUi();
  const toast = useToast();
  const older = useLibraryModule(update.moduleId, update.from);
  const newer = useLibraryModule(update.moduleId, update.to);
  const draft = ctx.draft;

  const plan = useMemo(() => {
    if (older.status !== "ready" || newer.status !== "ready") return null;
    try {
      return { plan: planModuleUpdate(draft, update.importId, older.data.version.fragment, newer.data.version.fragment), error: null };
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error.message : "What would change couldn’t be worked out." };
    }
  }, [draft, update.importId, older, newer]);

  const apply = () => {
    if (older.status !== "ready" || newer.status !== "ready") return;
    const opts = {
      by: ctx.user.uid,
      byEmail: ctx.user.email ?? "",
      at: new Date().toISOString(),
      ...(ctx.reserved ? { reserved: ctx.reserved } : {}),
    };
    const ok = ctx.run(`Update “${title}” to v${update.to}`, (d) =>
      updateFromModule(d, update.importId, older.data.version.fragment, newer.data.version.fragment, opts).draft,
    );
    if (!ok) return;
    toast.success(`Updated to version ${update.to}`, `This survey’s copy of “${title}” now follows version ${update.to}. Undo takes it back.`);
    ctx.announce(`Updated “${title}” to version ${update.to}.`);
    onClose();
  };

  const loading = older.status === "loading" || newer.status === "loading";
  const failed = older.status === "error" ? older : newer.status === "error" ? newer : null;
  const changes = plan?.plan?.changes ?? [];
  const attention = changes.filter((c) => OUTCOME_ATTENTION.has(c.outcome)).length;

  return (
    <Dialog
      title={`Update ‘${title}’ to version ${update.to}?`}
      onClose={onClose}
      width={720}
      description={<p className="stn-flush">This survey’s copy is version {update.from}. Each question is compared three ways: as copied, as it is now in the library, and as it is in this survey.</p>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              lib.dismiss(update);
              onClose();
            }}
            disabled={!ctx.canEdit}
          >
            Not now
          </Button>
          <Button variant="primary" onClick={apply} disabled={!plan?.plan || !ctx.canEdit}>
            Update this survey’s copy
          </Button>
        </>
      }
    >
      {loading ? <Skeleton lines={5} label="Loading both versions" /> : null}
      {failed ? <LoadError error={failed.error} retry={failed.retry} /> : null}
      {plan?.error ? <Notice tone="error">{plan.error}</Notice> : null}
      {newer.status === "ready" ? (
        <p className="stl-meta">
          Version {update.to}, saved by {newer.data.version.savedByEmail} on {formatDateTime(toDate(newer.data.version.savedAt))}
          {newer.data.version.note ? <>: “{newer.data.version.note}”</> : null}
        </p>
      ) : null}
      {plan?.plan ? (
        <>
          {attention > 0 ? (
            <Notice tone="warn">
              {attention === 1 ? "1 question needs" : `${attention} questions need`} a look: this survey&rsquo;s changes are kept where the library
              changed too, and nothing is deleted.
            </Notice>
          ) : null}
          <div className="stp-table-wrap">
            <table className="stp-table stl-plan" aria-label="What updating would do">
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">What happens</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={`${c.itemKey}:${c.sourceKey}`}>
                    <th scope="row">
                      <span className="stl-plan-text">{c.text || c.itemKey}</span>
                      <span className="stl-q-id">{c.itemKey}</span>
                    </th>
                    <td>
                      <span className={`stl-outcome${OUTCOME_ATTENTION.has(c.outcome) ? " is-attention" : ""}`}>
                        {OUTCOME_ATTENTION.has(c.outcome) ? <Icon name="warning" size={14} /> : null}
                        {OUTCOME_WORDS[c.outcome]}
                      </span>
                      {c.detail ? <span className="stl-meta stl-plan-detail">{c.detail}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="stl-meta">It is one change to the draft: undo takes it back, and it is published like any other, with the version bump it needs.</p>
        </>
      ) : null}
    </Dialog>
  );
}
