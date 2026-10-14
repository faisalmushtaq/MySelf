import { useMemo, useState } from "react";
import {
  adoptLibraryLicence,
  editTier,
  identityRoleOf,
  isUnlocked,
  libraryLicenceUpdate,
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
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { useLibraryUi } from "../library/LibraryContext.js";
import { updatesForBlock } from "../library/model.js";
import { ModuleUpdateBanner } from "../library/ModuleUpdate.js";
import { BlockOrigins } from "../library/Provenance.js";
import { saveRefusal } from "../outline/actions.js";
import { ConditionBuilder } from "./ConditionBuilder.js";
import { Facts, IssueMessages, LockBanner, Panel } from "./controls.js";
import { blockIssues } from "./issues.js";
import { protectedBanner } from "./locks.js";
import { NodeList } from "./NodeList.js";
import { relock, UnlockDialog, unlockedText } from "./UnlockDialog.js";

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
  const library = useLibraryUi();
  const updates = useMemo(() => (blocks[0] ? updatesForBlock(library.updates, blocks[0]) : []), [library.updates, blocks]);
  const itemKeys = useMemo(() => blocks[0]?.questions.map((q) => q.itemKey) ?? [], [blocks]);
  const cantSave = saveRefusal(draft, p.instrument, tier, p.items.length);
  const linkage = p.items.some((item) => identityRoleOf(`${p.instrument}.${item.key}`, item) === "linkage");
  const name = def?.name ?? p.instrument;
  const licenceUpdate = tier === "locked" ? libraryLicenceUpdate(draft, p.instrument) : null;
  const adoptLicence = () => {
    if (ctx.run(`Use the library's licence for “${name}”`, (d) => adoptLibraryLicence(d, p.instrument).draft)) {
      ctx.announce(`“${name}” is openly licensed: its wording can now be edited.`);
    }
  };

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

  const lockNotice =
    tier === "locked" ? (
      <LockBanner
        title="Licensed questionnaire · wording locked"
        info={
          licenceUpdate
            ? "The instrument library now lists this questionnaire as openly licensed, so its wording may be changed. Use the library's licence to edit it here; the change is kept with the survey's history."
            : "Its wording, options, codes and question order are fixed by its licence and by the evidence it was validated on. You can move the whole block, show it only to some participants, remove it whole, and make each question required or not."
        }
        infoLabel="the licence"
        actions={
          licenceUpdate ? (
            <Button size="sm" variant="secondary" icon="unlock" onClick={adoptLicence} disabled={!ctx.canEdit}>
              Use the library's licence
            </Button>
          ) : undefined
        }
      />
    ) : tier === "protected" && protection ? (
      <LockBanner
        title={protection.reason === "ethics" ? "Ethics-approved consent · locked" : "Participant identifiers · locked"}
        info={`${protectedBanner(protection).title}. ${protectedBanner(protection).body}`}
        infoLabel="this lock"
        actions={
          <Button size="sm" variant="secondary" icon="unlock" onClick={() => setUnlocking(true)} disabled={!ctx.canEdit}>
            Unlock…
          </Button>
        }
      />
    ) : protection && unlocked ? (
      <LockBanner
        tone="accent"
        icon="unlock"
        title="Unlocked for editing"
        info={unlockedText(draft, p.instrument)}
        infoLabel="the unlock"
        actions={
          <Button size="sm" variant="secondary" icon="lock" onClick={() => relock(ctx, p.instrument)} disabled={!ctx.canEdit}>
            Lock again
          </Button>
        }
      />
    ) : null;

  return (
    <div className="stn-node">
      <header className="stn-head">
        <nav className="stn-crumbs" aria-label="Where this block is">
          <button type="button" className="stn-crumb" onClick={() => ctx.select({ kind: "section", sectionKey })}>
            {section.title}
          </button>
          <Icon name="chevron-right" size={12} className="st-icon stn-crumb-sep" />
          <span>Block {componentIndex + 1}</span>
        </nav>
      </header>
      <div className="stn-pagehead">
        <div className="stn-titlerow">
          <h2 className="stn-title" tabIndex={-1} data-editor-heading>
            {name}
          </h2>
          {def?.abbreviation ? <span className="stn-title-meta">{def.abbreviation}</span> : null}
        </div>
        {def?.construct ? <p className="stn-lead">{def.construct}</p> : null}
      </div>

      {lockNotice || updates.length > 0 ? (
        <div className="stn-notices">
          {lockNotice}
          {updates.map((u) => (
            <ModuleUpdateBanner key={u.importId} update={u} />
          ))}
        </div>
      ) : null}
      <IssueMessages issues={[...issues.general, ...(issues.byField.get("items") ?? [])]} />

      <Panel title={`Questions · ${p.items.length}`} description={p.subset ? `A chosen ${p.items.length} of the module's questions, in this order.` : undefined}>
        <NodeList blocks={blocks} sectionKey={sectionKey} withBlocks={false} select={ctx.select} />
      </Panel>

      <Panel
        title="Condition"
        field="displayIf"
        info="Conditions can only use answers given earlier. To skip ahead, hide the questions in between — the survey always moves forward."
      >
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
            <p className="stn-subhead">Instructions before its first question</p>
            <blockquote>{p.form.instructions}</blockquote>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Library"
        info="Saved modules are shared by every study space. A survey that uses one is told when a newer version is saved, and chooses whether to take it."
      >
        <BlockOrigins itemKeys={itemKeys} />
        {cantSave ? (
          <p className="stn-inline-note">
            <Icon name="lock" size={14} /> {cantSave}
          </p>
        ) : (
          <div className="stn-actionrow">
            <p className="stn-flush stn-muted">Save its questions as a module any survey can add from the library.</p>
            <Button
              variant="secondary"
              icon="library"
              onClick={() => library.openSave({ sectionKey, componentIndex })}
              disabled={!ctx.canEdit}
            >
              Save to library…
            </Button>
          </div>
        )}
      </Panel>

      <Panel title="Remove block">
        {removeBlocked ? (
          <p className="stn-inline-note">
            <Icon name="lock" size={14} /> {removeBlocked}
          </p>
        ) : (
          <div className="stn-actionrow">
            <p className="stn-flush stn-muted">
              Archives its {p.items.length} question{p.items.length === 1 ? "" : "s"}; any can be restored
              {tier === "locked" ? ", which brings the whole questionnaire back" : ""}.
            </p>
            <Button variant="secondary" className="stn-danger-btn" icon="archive" onClick={() => setConfirmRemove(true)} disabled={!ctx.canEdit}>
              Remove block
            </Button>
          </div>
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
    </div>
  );
}
