import { useId, useState } from "react";
import { deleteQuestion, restoreQuestion, studioTypeOf, type ArchivedQuestion as ArchivedRecord } from "@myself/studio";
import { formatDateTime } from "../../format.js";
import { ConfirmDialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { LockBanner, Panel } from "./controls.js";
import { archivedTierOf, kindLabel } from "./options.js";
import { TYPE_ICONS, typeLabel } from "./types.js";

/**
 * An archived question: no longer asked, kept whole so it can come back.
 *
 * Its ID and reporting label stay reserved and whatever was recorded under
 * them stays readable, so the view is read-only. It can be restored — into
 * the section it came from (where it goes back exactly where it was) or
 * another — and, only if it was never published, deleted for good.
 */

export function ArchivedQuestion({ record }: { record: ArchivedRecord }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const sections = draft.composition.sections;
  const original = sections.find((s) => s.key === record.sectionKey);
  const [target, setTarget] = useState(original?.key ?? sections[0]?.key ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectId = useId();
  const item = record.item;
  const scale = "scale" in item ? draft.scales[item.scale] : undefined;
  const type = studioTypeOf(item, scale);
  const published = ctx.publishedItemKeys.has(record.itemKey);
  const tier = archivedTierOf(draft, record);
  const at = new Date(record.archivedAt);
  const siblings = tier === "locked" ? draft.archived.filter((a) => a.refKey === record.refKey).length : 1;

  const restore = () => {
    const out: { restored?: string[] } = {};
    const ok = ctx.run(`Restore ${record.itemKey}`, (d) => {
      const result = restoreQuestion(d, record.itemKey, target ? { sectionKey: target } : {});
      out.restored = result.restored;
      return result.draft;
    });
    if (ok) {
      const n = out.restored?.length ?? 1;
      ctx.announce(n > 1 ? `Restored the whole questionnaire: ${n} questions.` : "Restored. The question is asked again.");
      ctx.select({ kind: "question", itemKey: record.itemKey });
    }
  };

  const remove = () => {
    setConfirmDelete(false);
    if (ctx.run(`Delete ${record.itemKey} for good`, (d) => deleteQuestion(d, record.itemKey, { published: ctx.publishedItemKeys }).draft)) {
      ctx.announce("Deleted. Undo brings it back.");
      ctx.select(null);
    }
  };

  const deleteBlocked = published
    ? "It has been published, so it can't be deleted: its ID stays reserved and the answers recorded under it stay readable."
    : tier === "locked"
      ? "It belongs to a licensed questionnaire, which is only valid asked whole. It stays archived, and restoring it brings back the whole questionnaire."
      : tier === "protected"
        ? "It belongs to a protected module. Unlock the module to delete it."
        : null;

  return (
    <div className="stn-node">
      <header className="stn-node-head">
        <p className="stn-crumbs">Archived question</p>
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          Archived
          <span className="stn-title-id">{record.itemKey}</span>
        </h2>
      </header>
      <div className="stn-banners">
        <LockBanner icon="archive" title="Archived — not asked">
          Archived {formatDateTime(Number.isNaN(at.getTime()) ? null : at)} by {record.archivedBy}. Its ID and reporting label stay
          reserved, and any answers already recorded under them stay readable. Restore it to ask it again.
        </LockBanner>
      </div>
      <article className="stn-card stn-card-archived" aria-label="The archived question">
        <div className="stn-card-top">
          <span className="stn-typechip">
            <Icon name={TYPE_ICONS[type]} size={16} />
            {typeLabel(type)}
          </span>
        </div>
        <p className="stn-stem-ro">{item.stem.text}</p>
        {item.lede ? <p className="stn-lede-ro">{item.lede.text}</p> : null}
        {scale ? (
          <ol className="stn-opts">
            {scale.options.map((o) => (
              <li key={o.code} className="stn-opt readonly">
                <div className="stn-opt-main">
                  <span className="stn-opt-text">{o.label}</span>
                </div>
                <div className="stn-opt-meta">
                  {o.kind && o.kind !== "substantive" ? <span className="stn-kind">{kindLabel(o.kind)}</span> : null}
                  <span className="stn-code">Stored as {o.code}</span>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        <p className="stn-hint">
          Reporting label <code>{item.variable}</code>
        </p>
      </article>

      <Panel title="Restore">
        <div className="stn-restore">
          <div className="stn-field">
            <label className="stn-label" htmlFor={selectId}>
              Section
            </label>
            <select id={selectId} className="st-select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!ctx.canEdit}>
              {sections.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                  {s.key === record.sectionKey ? " (where it was)" : ""}
                </option>
              ))}
            </select>
            <p className="stn-hint">
              {target === record.sectionKey
                ? "It goes back exactly where it was."
                : original
                  ? "It goes at the end of that section."
                  : "The section it was in has gone, so it goes at the end of the section you choose."}
              {siblings > 1 ? ` Its questionnaire is licensed and only asked whole, so all ${siblings} of its archived questions come back together.` : ""}
            </p>
          </div>
          <Button variant="primary" icon="restore" onClick={restore} disabled={!ctx.canEdit || !target}>
            Restore
          </Button>
        </div>
      </Panel>

      <Panel title="Delete permanently">
        {deleteBlocked ? (
          <p className="stn-hint stn-lockreason">
            <Icon name="lock" size={14} /> {deleteBlocked}
          </p>
        ) : (
          <>
            <p className="stn-flush">It was never published, so no answers were recorded under it. Deleting it frees its ID.</p>
            <div className="stn-row-actions">
              <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} disabled={!ctx.canEdit}>
                Delete permanently
              </Button>
            </div>
          </>
        )}
      </Panel>
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete this question for good?"
          body={<p className="stn-flush">It is removed from the archive and its ID becomes free for a new question. You can still undo this in this session.</p>}
          confirmLabel="Delete permanently"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
      ) : null}
    </div>
  );
}
