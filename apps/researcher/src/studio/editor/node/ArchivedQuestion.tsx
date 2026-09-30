import { useId, useState } from "react";
import { deleteQuestion, restoreQuestion, studioTypeOf, type ArchivedQuestion as ArchivedRecord } from "@myself/studio";
import { formatDateTime } from "../../format.js";
import { ConfirmDialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { LockBanner, Panel } from "./controls.js";
import { publishedPending } from "./locks.js";
import { archivedTierOf, kindLabel } from "./options.js";
import { StoredAs } from "./OptionsEditor.js";
import { TYPE_ICONS, typeLabel } from "./types.js";
import { UnlockDialog } from "./UnlockDialog.js";

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
  const [unlocking, setUnlocking] = useState(false);
  const selectId = useId();
  const item = record.item;
  const scale = "scale" in item ? draft.scales[item.scale] : undefined;
  const type = studioTypeOf(item, scale);
  const published = ctx.publishedItemKeys.has(record.itemKey);
  const tier = archivedTierOf(draft, record);
  const at = new Date(record.archivedAt);
  const siblings = tier === "locked" ? draft.archived.filter((a) => a.refKey === record.refKey).length : 1;
  const protectedModuleKey = tier === "protected" ? record.itemKey.slice(0, record.itemKey.indexOf(".")) : null;
  const glyph = item.responseType === "rank_group" ? null : item.responseType === "multi_choice" ? "check" : "radio";

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

  // REVIEW FIX: deleting is only for a question never published, so it waits until that is known.
  const pending = publishedPending(ctx.publishedStatus);
  const deleteBlocked = published
    ? "It has been published, so it can't be deleted: its ID stays reserved and the answers recorded under it stay readable."
    : pending
      ? pending
      : tier === "locked"
      ? "It belongs to a licensed questionnaire, which is only valid asked whole. It stays archived, and restoring it brings back the whole questionnaire."
      : tier === "protected"
        ? "It belongs to a protected module. Unlock the module to delete it."
        : null;
  const when = formatDateTime(Number.isNaN(at.getTime()) ? null : at);

  return (
    <div className="stn-node">
      <header className="stn-head">
        <p className="stn-crumbs">Archive</p>
        <h2 className="stn-meta" tabIndex={-1} data-editor-heading>
          <span>Archived question</span>
          <span className="stn-meta-id">{record.itemKey}</span>
        </h2>
      </header>
      <div className="stn-notices">
        <LockBanner
          icon="archive"
          title="Archived · not asked"
          info={`Archived ${when} by ${record.archivedBy}. Its ID and reporting label stay reserved, and any answers already recorded under them stay readable. Restore it to ask it again.`}
          infoLabel="the archive"
        />
      </div>
      <article className="stn-canvas stn-canvas-archived" aria-label="The archived question">
        <p className="stn-stem-ro">{item.stem.text}</p>
        {item.lede ? <p className="stn-lede-ro">{item.lede.text}</p> : null}
        <div className="stn-answer">
          <div className="stn-answer-head">
            <span className="stn-h">Answer</span>
            <span className="stn-typetag">
              <Icon name={TYPE_ICONS[type]} size={14} />
              {typeLabel(type)}
            </span>
          </div>
          {scale ? (
            <ol className="stn-opts">
              {scale.options.map((o) => (
                <li key={o.code} className={`stn-opt readonly${glyph ? "" : " no-glyph"}`}>
                  {glyph ? <span className={`stn-opt-glyph stn-glyph-${glyph}`} aria-hidden="true" /> : null}
                  <div className="stn-opt-main">
                    <span className="stn-opt-text">{o.label}</span>
                  </div>
                  <div className="stn-opt-meta">
                    {o.kind && o.kind !== "substantive" ? <span className="stn-kind">{kindLabel(o.kind)}</span> : null}
                    <StoredAs code={o.code} />
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
        <p className="stn-inline-note">
          Reporting label <code>{item.variable}</code>
        </p>
      </article>

      <Panel title="Restore">
        <div className="stn-restore">
          <div className="stn-field">
            <label className="stn-label" htmlFor={selectId}>
              Section
            </label>
            <select
              id={selectId}
              className="st-select"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={!ctx.canEdit}
              aria-describedby={`${selectId}-hint`}
            >
              {sections.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                  {s.key === record.sectionKey ? " (where it was)" : ""}
                </option>
              ))}
            </select>
          </div>
          <Button variant="primary" icon="restore" onClick={restore} disabled={!ctx.canEdit || !target || protectedModuleKey !== null}>
            Restore
          </Button>
        </div>
        <p id={`${selectId}-hint`} className="stn-hint">
          {target === record.sectionKey
            ? "It goes back exactly where it was."
            : original
              ? "It goes at the end of that section."
              : "Its section has gone, so it goes at the end of the one you choose."}
          {siblings > 1 ? ` All ${siblings} archived questions of its licensed questionnaire come back together.` : ""}
        </p>
        {protectedModuleKey ? (
          // REVIEW FIX: a protected module's question can only be restored once
          // the module is unlocked (the model refuses otherwise), and when the
          // whole module is archived there is nowhere else to unlock it from.
          <div className="stn-notices stn-gap">
            <LockBanner
              title="Protected module · unlock to restore"
              info="It belongs to a protected module. Unlock the module to restore it."
              infoLabel="this lock"
              actions={
                <Button size="sm" variant="secondary" icon="unlock" onClick={() => setUnlocking(true)} disabled={!ctx.canEdit}>
                  Unlock…
                </Button>
              }
            />
          </div>
        ) : null}
      </Panel>

      <Panel title="Delete permanently">
        {deleteBlocked ? (
          <p className="stn-inline-note">
            <Icon name="lock" size={14} /> {deleteBlocked}
          </p>
        ) : (
          <div className="stn-actionrow">
            <p className="stn-flush stn-muted">Never published, so nothing was recorded under it. Deleting frees its ID.</p>
            <Button variant="secondary" className="stn-danger-btn" icon="trash" onClick={() => setConfirmDelete(true)} disabled={!ctx.canEdit}>
              Delete permanently
            </Button>
          </div>
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
      {unlocking && protectedModuleKey ? <UnlockDialog instrument={protectedModuleKey} onClose={() => setUnlocking(false)} /> : null}
    </div>
  );
}
