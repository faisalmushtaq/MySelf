import { memo, useCallback, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  addOption,
  addOtherOption,
  findQuestion,
  forkScale,
  moveOption,
  removeOption,
  shortText,
  updateOption,
  type Issue,
  type ScaleInput,
  type StudioDraft,
} from "@myself/studio";
import { ConfirmDialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button, IconButton, InfoTip, Notice, Tooltip } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { IssueMessages, useSyncedText } from "./controls.js";
import { focusSoon } from "./focus.js";
import type { FieldIssues } from "./issues.js";
import { unlessUnchanged } from "./unchanged.js";
import {
  dropIndex,
  kindLabel,
  listPublished,
  moveIndex,
  newOptionLabel,
  OPTION_KINDS,
  optionsAccess,
  otherBlocked,
  relabelWarning,
  removalConsequence,
  removeBlocked,
  sharedWith,
  type OptionKind,
} from "./options.js";

/**
 * A choice question's options, edited as the participant will see them.
 *
 * What a researcher sees here is the label; what the data records is the
 * option's value, shown beside it as "= 3". The value never changes —
 * not when the option is reworded, not when it is moved — which is what keeps
 * answers comparable from one version to the next, and why a removed value is
 * retired rather than handed to a new option.
 *
 * Rows are reordered by dragging the handle, or from the keyboard with the
 * arrow keys on the handle (Alt+↑/↓ from anywhere in the row). Each move is
 * announced, and focus stays on the row that moved.
 */

type ScaleOption = ScaleInput["options"][number];
type Glyph = "radio" | "check" | "none";

/** The option list a question uses in a draft, for comparing before and after an edit. */
function scaleOfQuestion(draft: StudioDraft, itemKey: string): ScaleInput | null {
  const item = findQuestion(draft, itemKey)?.item;
  return item && "scale" in item ? (draft.scales[item.scale] ?? null) : null;
}

export function OptionsEditor({
  itemKey,
  scaleKey,
  issues,
  statementNoun = "option",
  glyph = "radio",
}: {
  itemKey: string;
  scaleKey: string;
  issues: FieldIssues;
  statementNoun?: string;
  /** What each row is drawn with, as the participant sees it: a radio, a tick box, or nothing (items to sort). */
  glyph?: Glyph;
}) {
  const ctx = useEditor();
  const { draft } = ctx;
  const scale = draft.scales[scaleKey];
  const access = useMemo(() => optionsAccess(draft, itemKey), [draft, itemKey]);
  const shared = useMemo(() => sharedWith(draft, itemKey), [draft, itemKey]);
  const editable = ctx.canEdit && access.editable;
  const publishedCodes = ctx.published?.publishedScaleCodes.get(scaleKey);
  // REVIEW FIX: until what has been published is known, a removed value is
  // treated as published — asked about, and retired rather than freed — since
  // a freed value can be handed to a new option and old answers misread.
  const publishedKnown = ctx.publishedStatus === "ready";
  const isPublished = !publishedKnown || listPublished(draft, itemKey, ctx.publishedItemKeys);
  const helpId = useId();
  const [removing, setRemoving] = useState<ScaleOption | null>(null);
  const [marker, setMarker] = useState<{ index: number; after: boolean } | null>(null);
  const [added, setAdded] = useState<{ followUp: string; forked: boolean } | null>(null);
  const dragging = useRef<number | null>(null);

  // The row callbacks read the latest draft through a ref, so they keep one
  // identity and a memoised row re-renders only when its own option changes.
  const latest = useRef({ ctx, scale, itemKey, publishedCodes, isPublished, publishedKnown });
  latest.current = { ctx, scale, itemKey, publishedCodes, isPublished, publishedKnown };

  // REVIEW FIX: labels and descriptions are stored trimmed, so a space typed at
  // the end changes nothing; `unlessUnchanged` keeps that from recording an
  // empty undo step and an autosave.
  const onLabel = useCallback((code: number, label: string) => {
    const { ctx, itemKey } = latest.current;
    ctx.run(`Edit option ${code} of ${itemKey}`, (d) => unlessUnchanged(d, updateOption(d, itemKey, code, { label }).draft, (x) => scaleOfQuestion(x, itemKey)));
  }, []);
  const onDescription = useCallback((code: number, description: string) => {
    const { ctx, itemKey } = latest.current;
    ctx.run(`Edit the description of option ${code} of ${itemKey}`, (d) =>
      unlessUnchanged(
        d,
        updateOption(d, itemKey, code, { description: description.trim() ? description : null }).draft,
        (x) => scaleOfQuestion(x, itemKey),
      ),
    );
  }, []);
  const onKind = useCallback((code: number, kind: NonNullable<OptionKind>) => {
    const { ctx, itemKey } = latest.current;
    if (ctx.run(`Change the kind of option ${code} of ${itemKey}`, (d) => updateOption(d, itemKey, code, { kind }).draft)) {
      ctx.announce(`Option ${code} is now “${kindLabel(kind)}”.`);
    }
  }, []);
  const onMove = useCallback((code: number, to: number, focusPart?: string) => {
    const { ctx, itemKey, scale } = latest.current;
    if (!scale) return;
    const option = scale.options.find((o) => o.code === code);
    if (!option) return;
    if (ctx.run(`Reorder the options of ${itemKey}`, (d) => moveOption(d, itemKey, code, to).draft)) {
      ctx.announce(`Moved “${option.label}” to position ${to + 1} of ${scale.options.length}.`);
      if (focusPart) focusSoon(`[data-row-code="${code}"] [data-part="${focusPart}"]`);
    }
  }, []);
  const onRemove = useCallback((code: number) => {
    const { scale, isPublished } = latest.current;
    const option = scale?.options.find((o) => o.code === code);
    if (!option) return;
    // `remove` reads everything it needs from the ref, so this callback can keep one identity.
    if (isPublished) setRemoving(option);
    else remove(option);
  }, []);

  function remove(option: ScaleOption) {
    const { ctx, itemKey, scale, publishedKnown } = latest.current;
    const index = scale?.options.findIndex((o) => o.code === option.code) ?? -1;
    const ok = ctx.run(`Remove option ${option.code} of ${itemKey}`, (d) =>
      removeOption(d, itemKey, option.code, { published: publishedKnown ? ctx.publishedItemKeys : true, at: new Date().toISOString() }).draft,
    );
    if (ok) {
      ctx.announce(`Removed “${option.label}”. Undo brings it back.`);
      const next = scale?.options.filter((o) => o.code !== option.code)[Math.max(0, index - 1)];
      if (next) focusSoon(`[data-row-code="${next.code}"] [data-part="label"]`);
    }
  }

  const drag = useMemo(
    () => ({
      start: (code: number, e: DragEvent<HTMLElement>) => {
        dragging.current = code;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(code));
        const row = (e.currentTarget as HTMLElement).closest("li");
        if (row) e.dataTransfer.setDragImage(row, 24, 24);
      },
      over: (index: number, e: DragEvent<HTMLElement>) => {
        if (dragging.current === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        setMarker((m) => (m && m.index === index && m.after === after ? m : { index, after }));
      },
      drop: (index: number, e: DragEvent<HTMLElement>) => {
        const code = dragging.current;
        dragging.current = null;
        setMarker(null);
        if (code === null) return;
        e.preventDefault();
        const options = latest.current.scale?.options ?? [];
        const from = options.findIndex((o) => o.code === code);
        if (from < 0) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const to = dropIndex(from, index, e.clientY > rect.top + rect.height / 2);
        if (to !== from) onMove(code, to);
      },
      end: () => {
        dragging.current = null;
        setMarker(null);
      },
    }),
    [onMove],
  );

  if (!scale) {
    return <Notice tone="error">The option list “{scaleKey}” is missing from this survey, so there is nothing to choose from.</Notice>;
  }

  const codes = new Set(scale.options.map((o) => o.code));
  const orphanIssues: Issue[] = [];
  for (const [code, list] of issues.byOption) if (!codes.has(code)) orphanIssues.push(...list);
  const retired = draft.retiredCodes[scaleKey] ?? [];
  const blocked = removeBlocked(scale);
  const otherReason = otherBlocked(draft, itemKey);
  const canFork = ctx.canEdit && (access.editable || access.canFork);

  const fork = () => {
    const ok = ctx.run(`Give ${itemKey} its own options`, (d) => forkScale(d, itemKey).draft);
    if (ok) ctx.announce("This question now has its own copy of the options. The other questions keep theirs.");
  };

  const addNew = () => {
    const out: { code?: number } = {};
    const label = newOptionLabel(scale);
    const ok = ctx.run(`Add an option to ${itemKey}`, (d) => {
      const result = addOption(d, itemKey, { label }, publishedCodes ? { publishedCodes: new Set(publishedCodes.keys()) } : {});
      out.code = result.code;
      return result.draft;
    });
    if (ok && out.code !== undefined) {
      ctx.announce(`Added “${label}”, stored as ${out.code}.`);
      focusSoon(`[data-row-code="${out.code}"] [data-part="label"]`, { select: true });
    }
  };

  const addOther = () => {
    const out: { followUp?: string; forked?: boolean } = {};
    const ok = ctx.run(`Add “Other (please specify)” to ${itemKey}`, (d) => {
      const result = addOtherOption(d, itemKey, {
        ...(ctx.reserved ? { reserved: ctx.reserved } : {}),
        ...(publishedCodes ? { publishedCodes: new Set(publishedCodes.keys()) } : {}),
      });
      out.followUp = result.followUpItemKey;
      out.forked = result.scaleKey !== scaleKey;
      return result.draft;
    });
    if (ok && out.followUp) {
      setAdded({ followUp: out.followUp, forked: out.forked ?? false });
      ctx.announce("Added an “Other” option and a follow-up question shown only when “Other” is chosen.");
      // REVIEW FIX: the "Add ‘Other’" button is gone now; the next step is the follow-up.
      focusSoon("[data-followup-action]");
    }
  };

  const usersCount = shared.live.length + 1;
  const quietReason = !access.editable && (access.why === "locked" || access.why === "protected");

  return (
    <div className="stn-options" data-field="options" tabIndex={-1} aria-describedby={helpId}>
      {shared.live.length > 0 ? (
        <SharedNotice
          count={usersCount}
          others={shared.live}
          archived={shared.archived.length}
          canFork={canFork}
          editable={editable}
          onFork={fork}
        />
      ) : null}
      {!access.editable ? (
        // A licensed or protected question already says so at the top; here the
        // reason is only the list's description.
        <p className={quietReason ? "st-sr" : "stn-inline-note"}>
          {quietReason ? null : <Icon name="lock" size={14} />} {access.reason}
        </p>
      ) : null}
      <p id={helpId} className="st-sr">
        {editable
          ? "Each option's stored value never changes — not when it is reworded, not when it is moved — so answers stay comparable across versions. Drag the handle to reorder, or use the arrow keys on it."
          : "Each option's stored value never changes, so answers stay comparable across versions."}
      </p>
      <ol
        className={`stn-opts${editable ? " editable" : ""}`}
        aria-label={`${statementNoun === "option" ? "Options" : "Items"}, in the order participants see them`}
      >
        {scale.options.map((option, index) => (
          <OptionRow
            key={option.code}
            option={option}
            index={index}
            count={scale.options.length}
            editable={editable}
            glyph={glyph}
            removeBlockedReason={blocked}
            issues={issues.byOption.get(option.code)}
            relabel={relabelWarning(publishedCodes, option)}
            marker={marker && marker.index === index ? (marker.after ? "after" : "before") : null}
            onLabel={onLabel}
            onDescription={onDescription}
            onKind={onKind}
            onMove={onMove}
            onRemove={onRemove}
            drag={drag}
          />
        ))}
      </ol>
      <IssueMessages issues={[...(issues.byField.get("scale") ?? []), ...(issues.byField.get("options") ?? []), ...orphanIssues]} />
      {retired.length > 0 ? (
        <p className="stn-inline-note">
          Retired: {retired.map((r) => `${r.code} “${r.label}”`).join(", ")}
          <InfoTip text="Values of removed options are retired, never given to a new option, so answers already recorded keep their meaning." label="retired values" />
        </p>
      ) : null}
      {editable ? (
        <div className="stn-addrow">
          <Button size="sm" variant="ghost" icon="plus" onClick={addNew}>
            Add option
          </Button>
          {otherReason === null ? (
            <>
              <Button size="sm" variant="ghost" icon="plus" onClick={addOther} aria-describedby={`${helpId}-other`}>
                Add ‘Other’
              </Button>
              <InfoTip text={otherText(shared.live.length > 0)} label="Add ‘Other’" />
              <span id={`${helpId}-other`} className="st-sr">
                {otherText(shared.live.length > 0)}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      {added ? (
        <div className="stn-gap">
          <Notice
            tone="accent"
            title="Added “Other” and a follow-up question"
            action={
              <Button size="sm" data-followup-action onClick={() => ctx.select({ kind: "question", itemKey: added.followUp }, { field: "stem" })}>
                Edit the follow-up
              </Button>
            }
          >
            Asked straight after this one, only to participants who choose “Other”.
            {added.forked ? " This question now has its own copy of the options." : ""}
          </Notice>
        </div>
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove “${shortText(removing.label, 40)}”?`}
          body={
            <>
              <p className="stn-flush">{removalConsequence(removing, true, publishedCodes)}</p>
              {shared.live.length > 0 ? <p>It is removed from all {usersCount} questions that share this list.</p> : null}
            </>
          }
          confirmLabel="Remove and retire the value"
          destructive
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const option = removing;
            setRemoving(null);
            remove(option);
          }}
        />
      ) : null}
    </div>
  );
}

const otherText = (shared: boolean) =>
  `Adds an “Other” option and a short text question straight after this one, shown only when “Other” is chosen, so the text gets its own column.${
    shared ? " This question gets its own copy of the options first, so the others don't gain an “Other”." : ""
  }`;

/**
 * The value an option is stored as, shown as "= 3". It never changes — not
 * when the option is reworded or moved — which is what keeps answers
 * comparable from one version to the next.
 */
export function StoredAs({ code }: { code: number }) {
  return (
    <Tooltip text={`Stored as ${code} — never changes`}>
      <span className="stn-code">
        <span aria-hidden="true">= {code}</span>
        <span className="st-sr">Stored as {code}</span>
      </span>
    </Tooltip>
  );
}

/** "Shared list": one line saying the options are shared, with the way out of sharing them. */
function SharedNotice({
  count,
  others,
  archived,
  canFork,
  editable,
  onFork,
}: {
  count: number;
  others: string[];
  archived: number;
  canFork: boolean;
  editable: boolean;
  onFork: () => void;
}) {
  const { draft, select } = useEditor();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const textOf = (itemKey: string) => {
    const [instrument, key] = [itemKey.slice(0, itemKey.indexOf(".")), itemKey.slice(itemKey.indexOf(".") + 1)];
    for (const def of Object.values(draft.instruments)) {
      if (def.instrument !== instrument) continue;
      const item = (def.forms[0]?.items ?? []).find((i) => i.key === key);
      if (item) return shortText(item.stem.text, 48);
    }
    return itemKey;
  };
  const first = others.slice(0, 2).map((k) => `“${textOf(k)}”`);
  const more = others.length - first.length;
  const info = `Also used by ${first.join(", ")}${more > 0 ? ` and ${more} more` : ""}.${
    editable ? ` Changes to the options apply to all ${count} questions${archived > 0 ? `, and to ${archived} archived question${archived === 1 ? "" : "s"}` : ""}.` : ""
  }`;
  return (
    <div className="stn-shared" role="note">
      <div className="stn-notice stn-notice-neutral">
        <Icon name="copy" size={16} />
        <span className="stn-notice-text">
          Shared list · {editable ? `edits apply to all ${count} questions` : `used by ${count} questions`}
        </span>
        <InfoTip text={info} label="the shared list" />
        <span className="stn-notice-actions">
          <button type="button" className="stn-textbtn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
            {`${count - 1} other question${count === 2 ? "" : "s"}`}
          </button>
          {canFork ? (
            <Button size="sm" variant="secondary" onClick={onFork}>
              Give this question its own list
            </Button>
          ) : null}
        </span>
      </div>
      <ul id={listId} className="stn-links" hidden={!open}>
        {others.map((k) => (
          <li key={k}>
            <button type="button" className="stp-textlink" onClick={() => select({ kind: "question", itemKey: k })}>
              {textOf(k)}
            </button>{" "}
            <code>{k}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  option: ScaleOption;
  index: number;
  count: number;
  editable: boolean;
  glyph: Glyph;
  removeBlockedReason: string | null;
  issues: Issue[] | undefined;
  relabel: string | null;
  marker: "before" | "after" | null;
  onLabel: (code: number, label: string) => void;
  onDescription: (code: number, description: string) => void;
  onKind: (code: number, kind: NonNullable<OptionKind>) => void;
  onMove: (code: number, to: number, focusPart?: string) => void;
  onRemove: (code: number) => void;
  drag: {
    start: (code: number, e: DragEvent<HTMLElement>) => void;
    over: (index: number, e: DragEvent<HTMLElement>) => void;
    drop: (index: number, e: DragEvent<HTMLElement>) => void;
    end: () => void;
  };
}

const sameIssues = (a: Issue[] | undefined, b: Issue[] | undefined) =>
  (a ?? []).map((i) => i.message).join("\n") === (b ?? []).map((i) => i.message).join("\n");

/**
 * Every edit clones the draft, so each option arrives as a new object even when
 * nothing about it changed; comparing what it says keeps a 20-option list from
 * re-rendering every row on every keystroke in one of them.
 */
function rowPropsEqual(a: RowProps, b: RowProps): boolean {
  return (
    a.option.code === b.option.code &&
    a.option.label === b.option.label &&
    a.option.description === b.option.description &&
    a.option.kind === b.option.kind &&
    a.index === b.index &&
    a.count === b.count &&
    a.editable === b.editable &&
    a.glyph === b.glyph &&
    a.removeBlockedReason === b.removeBlockedReason &&
    a.relabel === b.relabel &&
    a.marker === b.marker &&
    sameIssues(a.issues, b.issues) &&
    a.onLabel === b.onLabel &&
    a.drag === b.drag
  );
}

const OptionRow = memo(function OptionRow(props: RowProps) {
  const { option, index, count, editable, glyph, removeBlockedReason, issues, relabel, marker, onLabel, onDescription, onKind, onMove, onRemove, drag } =
    props;
  const code = option.code;
  const id = useId();
  const [showDescription, setShowDescription] = useState(!!option.description);
  const commitLabel = useCallback((text: string) => onLabel(code, text), [onLabel, code]);
  const validateLabel = useCallback(
    (text: string) => (text.trim() ? null : "An option needs a label. The last label is kept until you type one."),
    [],
  );
  const commitDescription = useCallback((text: string) => onDescription(code, text), [onDescription, code]);
  const label = useSyncedText(option.label, commitLabel, validateLabel);
  const description = useSyncedText(option.description ?? "", commitDescription);
  const position = `option ${index + 1} of ${count}`;
  const kind = option.kind ?? "substantive";
  const msgId = `${id}-msgs`;
  const hasMsgs = !!label.localError || (issues?.length ?? 0) > 0 || !!relabel;
  const mark = glyph === "none" ? null : <span className={`stn-opt-glyph stn-glyph-${glyph}`} aria-hidden="true" />;

  const moveKeys = (e: KeyboardEvent<HTMLElement>, part: string, requireAlt: boolean) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (requireAlt && !e.altKey) return;
    const to = moveIndex(index, e.key === "ArrowUp" ? -1 : 1, count);
    e.preventDefault();
    if (to !== null) onMove(code, to, part);
  };

  if (!editable) {
    return (
      <li className={`stn-opt readonly${glyph === "none" ? " no-glyph" : ""}`} data-row-code={code}>
        {mark}
        <div className="stn-opt-main">
          <span className="stn-opt-text" data-option-code={code} tabIndex={-1}>
            {option.label}
          </span>
          {option.description ? <span className="stn-opt-desc">{option.description}</span> : null}
          <IssueMessages issues={issues} />
        </div>
        <div className="stn-opt-meta">
          {kind !== "substantive" ? <span className="stn-kind">{kindLabel(kind)}</span> : null}
          <StoredAs code={code} />
        </div>
      </li>
    );
  }

  return (
    <li
      className={`stn-opt${glyph === "none" ? " no-glyph" : ""}${kind !== "substantive" ? " has-kind" : ""}${marker ? ` drop-${marker}` : ""}`}
      data-row-code={code}
      onDragOver={(e) => drag.over(index, e)}
      onDrop={(e) => drag.drop(index, e)}
      onKeyDown={(e) => {
        const part = (e.target as HTMLElement).dataset["part"];
        // Not from the kind menu, where Alt+↓ is how the keyboard opens a menu.
        if (part && part !== "handle" && part !== "kind") moveKeys(e, part, true);
      }}
    >
      <button
        type="button"
        className="stn-opt-handle"
        data-part="handle"
        draggable
        onDragStart={(e) => drag.start(code, e)}
        onDragEnd={drag.end}
        onKeyDown={(e) => moveKeys(e, "handle", false)}
        aria-label={`Reorder “${option.label}”, ${position}. Use the up and down arrow keys to move it.`}
      >
        <Icon name="grip" size={16} />
      </button>
      {mark}
      <div className="stn-opt-main">
        <input
          className="stn-opt-label"
          data-part="label"
          data-option-code={code}
          aria-label={`Label of ${position}`}
          aria-describedby={hasMsgs ? msgId : undefined}
          aria-invalid={label.localError ? true : undefined}
          autoComplete="off"
          {...label.bind}
        />
        {showDescription ? (
          <input
            className="stn-opt-descinput"
            data-part="description"
            aria-label={`Description of ${position} (optional)`}
            placeholder="Description (optional)"
            autoComplete="off"
            {...description.bind}
          />
        ) : null}
        {hasMsgs ? (
          <div id={msgId}>
            <IssueMessages issues={issues} local={label.localError} />
            {relabel && !(issues ?? []).some((i) => i.code === "options.relabelled") ? (
              <p className="stn-msg stn-msg-warning">
                <Icon name="warning" size={14} />
                <span>
                  <span className="st-sr">Warning: </span>
                  {relabel}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="stn-opt-meta">
        {!showDescription ? (
          <button
            type="button"
            className="stn-opt-reveal stn-textbtn"
            data-part="add-description"
            aria-label={`Add a description to ${position}`}
            onClick={() => {
              setShowDescription(true);
              // REVIEW FIX: this button disappears; carry on in the box it opened.
              focusSoon(`[data-row-code="${code}"] [data-part="description"]`);
            }}
          >
            <Icon name="plus" size={14} />
            Description
          </button>
        ) : null}
        <select
          className="stn-kind-select stn-opt-reveal"
          data-part="kind"
          aria-label={`Kind of ${position}`}
          value={kind}
          onChange={(e) => onKind(code, e.target.value as NonNullable<OptionKind>)}
        >
          {OPTION_KINDS.filter((k) => k.value !== "other_specify" || kind === "other_specify").map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <StoredAs code={code} />
      </div>
      <IconButton
        icon="trash"
        size="sm"
        variant="danger"
        className="stn-opt-remove"
        data-part="remove"
        label={removeBlockedReason ? `Can't remove “${option.label}”: a choice question needs at least two options` : `Remove “${option.label}”`}
        aria-disabled={removeBlockedReason ? true : undefined}
        onClick={() => {
          if (!removeBlockedReason) onRemove(code);
        }}
      />
    </li>
  );
}, rowPropsEqual);
