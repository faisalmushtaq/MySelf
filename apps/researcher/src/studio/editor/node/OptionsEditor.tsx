import { memo, useCallback, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  addOption,
  addOtherOption,
  forkScale,
  moveOption,
  removeOption,
  shortText,
  updateOption,
  type Issue,
  type ScaleInput,
} from "@myself/studio";
import { ConfirmDialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button, IconButton, Notice } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Disclosure, IssueMessages, useSyncedText } from "./controls.js";
import { focusSoon } from "./focus.js";
import type { FieldIssues } from "./issues.js";
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
 * option's value, shown beside it as "Stored as 3". The value never changes —
 * not when the option is reworded, not when it is moved — which is what keeps
 * answers comparable from one version to the next, and why a removed value is
 * retired rather than handed to a new option.
 *
 * Rows are reordered by dragging the handle, or from the keyboard with the
 * arrow keys on the handle (Alt+↑/↓ from anywhere in the row). Each move is
 * announced, and focus stays on the row that moved.
 */

type ScaleOption = ScaleInput["options"][number];

export function OptionsEditor({
  itemKey,
  scaleKey,
  issues,
  statementNoun = "option",
}: {
  itemKey: string;
  scaleKey: string;
  issues: FieldIssues;
  statementNoun?: string;
}) {
  const ctx = useEditor();
  const { draft } = ctx;
  const scale = draft.scales[scaleKey];
  const access = useMemo(() => optionsAccess(draft, itemKey), [draft, itemKey]);
  const shared = useMemo(() => sharedWith(draft, itemKey), [draft, itemKey]);
  const editable = ctx.canEdit && access.editable;
  const publishedCodes = ctx.published?.publishedScaleCodes.get(scaleKey);
  const isPublished = listPublished(draft, itemKey, ctx.publishedItemKeys);
  const helpId = useId();
  const [removing, setRemoving] = useState<ScaleOption | null>(null);
  const [marker, setMarker] = useState<{ index: number; after: boolean } | null>(null);
  const [added, setAdded] = useState<{ followUp: string; forked: boolean } | null>(null);
  const dragging = useRef<number | null>(null);

  // The row callbacks read the latest draft through a ref, so they keep one
  // identity and a memoised row re-renders only when its own option changes.
  const latest = useRef({ ctx, scale, itemKey, publishedCodes, isPublished });
  latest.current = { ctx, scale, itemKey, publishedCodes, isPublished };

  const onLabel = useCallback((code: number, label: string) => {
    const { ctx, itemKey } = latest.current;
    ctx.run(`Edit option ${code} of ${itemKey}`, (d) => updateOption(d, itemKey, code, { label }).draft);
  }, []);
  const onDescription = useCallback((code: number, description: string) => {
    const { ctx, itemKey } = latest.current;
    ctx.run(`Edit the description of option ${code} of ${itemKey}`, (d) =>
      updateOption(d, itemKey, code, { description: description.trim() ? description : null }).draft,
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
    const { ctx, itemKey, scale } = latest.current;
    const index = scale?.options.findIndex((o) => o.code === option.code) ?? -1;
    const ok = ctx.run(`Remove option ${option.code} of ${itemKey}`, (d) =>
      removeOption(d, itemKey, option.code, { published: ctx.publishedItemKeys, at: new Date().toISOString() }).draft,
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
    }
  };

  const usersCount = shared.live.length + 1;

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
        <p className="stn-hint stn-lockreason">
          <Icon name="lock" size={14} /> {access.reason}
        </p>
      ) : null}
      <p id={helpId} className="stn-hint">
        {editable
          ? "Each option's stored value never changes — not when it is reworded, not when it is moved — so answers stay comparable across versions. Drag the handle to reorder, or use the arrow keys on it."
          : "Each option's stored value never changes, so answers stay comparable across versions."}
      </p>
      <ol className={`stn-opts${editable ? " editable" : ""}`} aria-label={`${statementNoun === "option" ? "Options" : "Items"}, in the order participants see them`}>
        {scale.options.map((option, index) => (
          <OptionRow
            key={option.code}
            option={option}
            index={index}
            count={scale.options.length}
            editable={editable}
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
        <p className="stn-hint">
          Retired values, never reused: {retired.map((r) => `${r.code} (“${r.label}”)`).join(", ")}.
        </p>
      ) : null}
      {editable ? (
        <div className="stn-row-actions">
          <Button size="sm" icon="plus" onClick={addNew}>
            Add option
          </Button>
          {otherReason === null ? (
            <Button size="sm" variant="ghost" icon="plus" onClick={addOther} aria-describedby={`${helpId}-other`}>
              Add “Other (please specify)”
            </Button>
          ) : null}
        </div>
      ) : null}
      {editable && otherReason === null ? (
        <p id={`${helpId}-other`} className="stn-hint">
          “Other” adds the option and a short text question straight after this one, shown only when “Other” is chosen, so the
          text gets its own column.
          {shared.live.length > 0 ? " This question gets its own copy of the options first, so the others don't gain an “Other”." : ""}
        </p>
      ) : null}
      {added ? (
        <div className="stn-gap">
          <Notice
            tone="accent"
            title="Added “Other” and a follow-up question"
            action={
              <Button size="sm" onClick={() => ctx.select({ kind: "question", itemKey: added.followUp }, { field: "stem" })}>
                Edit the follow-up
              </Button>
            }
          >
            “Please tell us what” is asked straight after this question, only to participants who choose “Other”.
            {added.forked ? " This question now has its own copy of the options." : ""}
          </Notice>
        </div>
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove “${shortText(removing.label, 40)}”?`}
          body={
            <>
              <p className="stn-flush">{removalConsequence(removing, true, publishedCodes?.get(removing.code))}</p>
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
  return (
    <div className="stn-shared" role="note">
      <p className="stn-flush">
        <Icon name="copy" size={15} /> <strong>This list is shared by {count} questions:</strong> this one, {first.join(", ")}
        {more > 0 ? ` and ${more} more` : ""}.
        {editable
          ? ` Changes apply to all of them${archived > 0 ? `, and to ${archived} archived question${archived === 1 ? "" : "s"}` : ""}.`
          : ""}
      </p>
      <div className="stn-row-actions">
        {canFork ? (
          <Button size="sm" variant="secondary" onClick={onFork}>
            Give this question its own list
          </Button>
        ) : null}
        <Disclosure summary={`See all ${count - 1} other question${count === 2 ? "" : "s"}`}>
          <ul className="stn-links">
            {others.map((k) => (
              <li key={k}>
                <button type="button" className="stp-textlink" onClick={() => select({ kind: "question", itemKey: k })}>
                  {textOf(k)}
                </button>{" "}
                <code>{k}</code>
              </li>
            ))}
          </ul>
        </Disclosure>
      </div>
    </div>
  );
}

interface RowProps {
  option: ScaleOption;
  index: number;
  count: number;
  editable: boolean;
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
    a.removeBlockedReason === b.removeBlockedReason &&
    a.relabel === b.relabel &&
    a.marker === b.marker &&
    sameIssues(a.issues, b.issues) &&
    a.onLabel === b.onLabel &&
    a.drag === b.drag
  );
}

const OptionRow = memo(function OptionRow(props: RowProps) {
  const { option, index, count, editable, removeBlockedReason, issues, relabel, marker, onLabel, onDescription, onKind, onMove, onRemove, drag } = props;
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

  const moveKeys = (e: KeyboardEvent<HTMLElement>, part: string, requireAlt: boolean) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (requireAlt && !e.altKey) return;
    const to = moveIndex(index, e.key === "ArrowUp" ? -1 : 1, count);
    e.preventDefault();
    if (to !== null) onMove(code, to, part);
  };

  if (!editable) {
    return (
      <li className="stn-opt readonly" data-row-code={code}>
        <div className="stn-opt-main">
          <span className="stn-opt-text" data-option-code={code} tabIndex={-1}>
            {option.label}
          </span>
          {option.description ? <span className="stn-opt-desc">{option.description}</span> : null}
        </div>
        <div className="stn-opt-meta">
          {kind !== "substantive" ? <span className="stn-kind">{kindLabel(kind)}</span> : null}
          <span className="stn-code">Stored as {code}</span>
        </div>
        <IssueMessages issues={issues} />
      </li>
    );
  }

  return (
    <li
      className={`stn-opt${marker ? ` drop-${marker}` : ""}`}
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
        <Icon name="grip" size={18} />
      </button>
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
            placeholder="Optional description shown under the label"
            autoComplete="off"
            {...description.bind}
          />
        ) : null}
        <div className="stn-opt-meta">
          <span className="stn-code" title="The value recorded in the data when this option is chosen. It never changes.">
            Stored as {code}
          </span>
          <select
            className="stn-kind-select"
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
          {!showDescription ? (
            <button type="button" className="stn-linkbtn" data-part="add-description" onClick={() => setShowDescription(true)}>
              Add a description
            </button>
          ) : null}
        </div>
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
      <IconButton
        icon="trash"
        size="sm"
        variant="danger"
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
