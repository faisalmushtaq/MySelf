import { useMemo, useState } from "react";
import {
  editTier,
  identityRoleOf,
  isUnlocked,
  outline,
  placements,
  protectedModule,
  removeBlock,
  setBlockCondition,
  type InstrumentOrModule,
  type StudioDraft,
} from "@myself/studio";
import { ConfirmDialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Badge, Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { ConditionBuilder } from "./ConditionBuilder.js";
import { Facts, IssueMessages, LockBanner, Panel } from "./controls.js";
import { blockIssues } from "./issues.js";
import { protectedBanner } from "./locks.js";
import { NodeList } from "./NodeList.js";
import { relock, UnlockDialog, UnlockedNote } from "./UnlockDialog.js";

/**
 * A block: one placement of a questionnaire or study module in a section.
 *
 * A licensed questionnaire is only ever changed as a block — moved, shown
 * conditionally or removed whole — because its questions are only valid asked
 * together, in order. So its details (licence, citation, scoring) are shown
 * here, read-only, beside what can be done with it.
 */

const LICENCE_STATUS: Record<string, string> = {
  open: "Open",
  permission_held: "Permission held",
  permission_required: "Permission required — can't be published until it is held",
  blocked: "Blocked — can't be published",
};

const MODIFIABLE: Record<string, string> = {
  yes: "Yes",
  no: "No — its wording, options and order are fixed",
  with_permission: "Only with the licence holder's permission — so not in the Studio",
};

export interface BlockRef {
  sectionKey: string;
  componentIndex: number;
}

/** The block's placement and definition, or null if the selection no longer points at one. */
export function findBlock(draft: StudioDraft, ref: BlockRef) {
  const p = placements(draft).find((x) => x.sectionKey === ref.sectionKey && x.componentIndex === ref.componentIndex);
  return p ?? null;
}

/** The scoring rules that apply to an instrument, by key. */
function scoringOf(draft: StudioDraft, def: InstrumentOrModule | null): string[] {
  if (!def) return [];
  const keys = Object.values(draft.scoring)
    .filter((s) => s.instrument === def.instrument)
    .map((s) => s.key);
  if (def.scoringKey && !keys.includes(def.scoringKey)) keys.unshift(def.scoringKey);
  return keys;
}

export function BlockEditor({ sectionKey, componentIndex }: BlockRef) {
  const ctx = useEditor();
  const { draft } = ctx;
  const p = findBlock(draft, { sectionKey, componentIndex })!;
  const section = draft.composition.sections[p.sectionIndex]!;
  const component = section.components[componentIndex]!;
  const def = p.def;
  const tier = editTier(draft, p.instrument);
  const protection = protectedModule(p.instrument);
  const unlocked = isUnlocked(draft, p.instrument);
  const issues = useMemo(() => blockIssues(ctx.issues, sectionKey, p.refKey), [ctx.issues, sectionKey, p.refKey]);
  const blocks = useMemo(
    () => (outline(draft).sections[p.sectionIndex]?.blocks ?? []).filter((b) => b.componentIndex === componentIndex),
    [draft, p.sectionIndex, componentIndex],
  );
  const [unlocking, setUnlocking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const linkage = p.items.some((item) => identityRoleOf(`${p.instrument}.${item.key}`, item) === "linkage");
  const name = def?.name ?? p.instrument;

  const remove = () => {
    setConfirmRemove(false);
    const out: { archived?: string[] } = {};
    const ok = ctx.run(`Remove the block “${name}”`, (d) => {
      const result = removeBlock(d, sectionKey, componentIndex, ctx.actor());
      out.archived = result.archived;
      return result.draft;
    });
    if (ok) {
      ctx.announce(`Removed “${name}”. Its ${out.archived?.length ?? 0} questions are archived and can be restored.`);
      ctx.select({ kind: "section", sectionKey });
    }
  };

  const removeBlocked =
    tier === "protected"
      ? "It is protected. Unlock it first."
      : linkage
        ? "It holds the questions the participant code is built from, which can never be removed."
        : null;

  return (
    <div className="stn-node">
      <header className="stn-node-head">
        <nav className="stn-crumbs" aria-label="Where this block is">
          <button type="button" className="stn-crumb" onClick={() => ctx.select({ kind: "section", sectionKey })}>
            {section.title}
          </button>
          <Icon name="chevron-right" size={14} />
          <span>Block {componentIndex + 1}</span>
        </nav>
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          {name}
          {def?.abbreviation ? <span className="stn-title-id">{def.abbreviation}</span> : null}
        </h2>
      </header>

      <div className="stn-banners">
        {tier === "locked" ? (
          <LockBanner title="A licensed questionnaire">
            Its wording, options, codes and question order can't be changed: they are fixed by its licence and by the evidence it was
            validated on. You can move the whole block, show it only to some participants, remove it whole, and make each question
            required or not.
          </LockBanner>
        ) : tier === "protected" && protection ? (
          <LockBanner
            tone="warn"
            title={protectedBanner(protection).title}
            actions={
              <Button size="sm" variant="secondary" icon="unlock" onClick={() => setUnlocking(true)} disabled={!ctx.canEdit}>
                Unlock…
              </Button>
            }
          >
            {protectedBanner(protection).body}
          </LockBanner>
        ) : protection && unlocked ? (
          <LockBanner
            tone="accent"
            icon="unlock"
            title="Unlocked for editing"
            actions={
              <Button size="sm" variant="secondary" icon="lock" onClick={() => relock(ctx, p.instrument)} disabled={!ctx.canEdit}>
                Lock again
              </Button>
            }
          >
            <UnlockedNote instrument={p.instrument} />
          </LockBanner>
        ) : null}
      </div>
      <IssueMessages issues={[...issues.general, ...(issues.byField.get("items") ?? [])]} />

      <Panel title={tier === "locked" ? "About this questionnaire" : "About this module"}>
        <Facts
          rows={[
            { label: "Name", value: name },
            ...(def?.abbreviation ? [{ label: "Abbreviation", value: def.abbreviation }] : []),
            { label: "Measures", value: def?.construct ?? "—" },
            ...(def?.citation ? [{ label: "Citation", value: def.citation }] : []),
            {
              label: "Licence",
              value: def ? `${LICENCE_STATUS[def.licence.status] ?? def.licence.status}${def.licence.holder ? ` (${def.licence.holder})` : ""}` : "—",
            },
            { label: "Wording can be changed", value: def ? (MODIFIABLE[def.licence.modifiable] ?? def.licence.modifiable) : "—" },
            ...(scoringOf(draft, def).length > 0 ? [{ label: "Scoring", value: <code>{scoringOf(draft, def).join(", ")}</code> }] : []),
            ...(def?.ageRange ? [{ label: "Validated ages", value: `${def.ageRange.min} to ${def.ageRange.max}` }] : []),
            { label: "Instrument ID", value: <code>{p.instrument}</code> },
          ]}
        />
        {p.form?.instructions ? (
          <div className="stn-instructions">
            <p className="stn-eyebrow">Instructions shown before its first question</p>
            <blockquote>{p.form.instructions}</blockquote>
          </div>
        ) : null}
      </Panel>

      <Panel
        title={`Its questions · ${p.items.length}`}
        description={p.subset ? `This block shows ${p.items.length} of the module's questions, in this order.` : undefined}
      >
        <NodeList blocks={blocks} sectionKey={sectionKey} withBlocks={false} select={ctx.select} />
      </Panel>

      <Panel title="When it's shown" field="displayIf">
        <ConditionBuilder
          subject={{ kind: "block", sectionKey, componentIndex }}
          noun={tier === "locked" ? "questionnaire" : "block"}
          expr={component.displayIf}
          readOnly={!ctx.canEdit || tier === "protected"}
          lockedReason={tier === "protected" ? "Every participant must see a protected module, so it can't be shown only to some." : ctx.readOnlyReason}
          issues={issues.byField.get("displayIf")}
          onWrite={(next) =>
            ctx.run(`Change when the block ${p.instrument} in ${sectionKey} is shown`, (d) => setBlockCondition(d, sectionKey, componentIndex, next).draft)
          }
        />
      </Panel>

      <Panel title="Remove block">
        {removeBlocked ? (
          <p className="stn-hint stn-lockreason">
            <Icon name="lock" size={14} /> {removeBlocked}
          </p>
        ) : (
          <>
            <p className="stn-flush">
              Removing the block archives its {p.items.length} question{p.items.length === 1 ? "" : "s"}. They stop being asked, their IDs stay
              reserved, and any of them can be restored{tier === "locked" ? " — which brings the whole questionnaire back" : ""}.
            </p>
            <div className="stn-row-actions">
              <Button variant="danger" icon="archive" onClick={() => setConfirmRemove(true)} disabled={!ctx.canEdit}>
                Remove block
              </Button>
            </div>
          </>
        )}
      </Panel>

      {confirmRemove ? (
        <ConfirmDialog
          title={`Remove “${name}”?`}
          body={
            <p className="stn-flush">
              All {p.items.length} of its questions are archived: participants won't be asked them, and answers already recorded stay
              readable. You can restore them from the archive.
            </p>
          }
          confirmLabel="Remove and archive its questions"
          destructive
          onCancel={() => setConfirmRemove(false)}
          onConfirm={remove}
        />
      ) : null}
      {unlocking ? <UnlockDialog instrument={p.instrument} onClose={() => setUnlocking(false)} /> : null}
      {tier === "locked" ? (
        <p className="stn-hint">
          <Badge icon="lock">Licensed</Badge> Required and ‘Prefer not to say’ can be set on each question from the settings panel.
        </p>
      ) : null}
    </div>
  );
}
