import { useCallback, useMemo, useState } from "react";
import type { ItemDefinition } from "@myself/schema";
import {
  changeQuestionType,
  findQuestion,
  liveQuestions,
  replaceWithNewType,
  scaleUsage,
  studioTypeOf,
  StudioOpError,
  updateQuestion,
  type QuestionPatch,
  type QuestionTypeId,
  type StudioDraft,
} from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { Badge, Button } from "../../ui/kit.js";
import { useToast } from "../../ui/toast.js";
import { useEditor } from "../context.js";
import { ConditionBuilder } from "./ConditionBuilder.js";
import { Disclosure, IssueMessages, LockBanner, Panel, TextField } from "./controls.js";
import { fieldsShownFor, questionIssues, unplacedIssues, type FieldIssues } from "./issues.js";
import { FieldsEditor, GroupsEditor, StatementsEditor } from "./ListEditors.js";
import { identityText, lockedBanner, protectedBanner, publishedPending, questionLock, tierAllows, typeLock, type QuestionLock } from "./locks.js";
import { OptionsEditor } from "./OptionsEditor.js";
import { pipeUses } from "./pipes.js";
import { TypePickerDialog } from "./TypePicker.js";
import { TYPE_ICONS, typeLabel } from "./types.js";
import { unlessUnchanged } from "./unchanged.js";
import { relock, UnlockDialog, UnlockedNote } from "./UnlockDialog.js";

/**
 * A question, edited as the participant sees it: a white card with the
 * question in large type, then its description, help and answer, then when it
 * is shown. Settings that change how it is answered but not what it says live
 * in the settings panel on the right.
 */

export type WriteQuestion = (label: string, make: (item: ItemDefinition) => QuestionPatch) => boolean;

/** Change a question through `updateQuestion`, building the change from the draft being changed. */
export function useQuestionWriter(itemKey: string): WriteQuestion {
  const ctx = useEditor();
  return useCallback(
    (label, make) =>
      ctx.run(label, (d) => {
        const q = findQuestion(d, itemKey);
        if (!q) throw new StudioOpError("That question is no longer in the draft.", "not_found");
        const next = updateQuestion(d, itemKey, make(q.item), {
          published: ctx.publishedItemKeys,
          ...(ctx.reserved ? { reserved: ctx.reserved } : {}),
        }).draft;
        // REVIEW FIX: no undo step or save for an edit that changed nothing (unchanged.ts).
        return unlessUnchanged(d, next, (x) => findQuestion(x, itemKey)?.item);
      }),
    [ctx, itemKey],
  );
}

export function QuestionEditor({ itemKey }: { itemKey: string }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const toast = useToast();
  const found = findQuestion(draft, itemKey)!;
  const item = found.item;
  const scale = "scale" in item ? draft.scales[item.scale] : undefined;
  const studioType = studioTypeOf(item, scale);
  const lock = questionLock(draft, itemKey, item, ctx.publishedItemKeys);
  const scaleUsers = useMemo(() => ("scale" in item ? scaleUsage(draft, item.scale) : []), [draft, item]);
  const issues = useMemo(() => questionIssues(ctx.issues, itemKey, scaleUsers), [ctx.issues, itemKey, scaleUsers]);
  const place = useMemo(() => placeOf(draft, itemKey), [draft, itemKey]);
  const write = useQuestionWriter(itemKey);
  const can = (field: string) => ctx.canEdit && tierAllows(lock, field);
  const [unlocking, setUnlocking] = useState(false);
  const [picking, setPicking] = useState(false);
  // REVIEW FIX: whether it was published decides between changing the type and
  // replacing the question, so neither is offered until that is known.
  const typeReason = typeLock(lock) ?? publishedPending(ctx.publishedStatus);

  const pickType = (typeId: QuestionTypeId) => {
    setPicking(false);
    if (lock.published) {
      const out: { itemKey?: string } = {};
      const ok = ctx.run(`Replace ${itemKey} with a new ${typeLabel(typeId).toLowerCase()} question`, (d) => {
        const result = replaceWithNewType(d, itemKey, typeId, { ...ctx.actor(), ...(ctx.reserved ? { reserved: ctx.reserved } : {}) });
        out.itemKey = result.itemKey;
        return result.draft;
      });
      if (ok && out.itemKey) {
        ctx.select({ kind: "question", itemKey: out.itemKey });
        toast.success(
          `Replaced with a new ${typeLabel(typeId).toLowerCase()} question`,
          `The old question (${itemKey}) is archived: its answers stay readable under its own ID, and the new one starts its own column.`,
        );
      }
      return;
    }
    if (ctx.run(`Change ${itemKey} to ${typeLabel(typeId).toLowerCase()}`, (d) => changeQuestionType(d, itemKey, typeId, { published: ctx.publishedItemKeys }).draft)) {
      ctx.announce(`This question is now a ${typeLabel(typeId).toLowerCase()} question.`);
    }
  };

  return (
    <div className="stn-node stn-question">
      <header className="stn-node-head">
        <nav className="stn-crumbs" aria-label="Where this question is">
          {place ? (
            <>
              <button type="button" className="stn-crumb" onClick={() => ctx.select({ kind: "section", sectionKey: place.sectionKey })}>
                {place.sectionTitle}
              </button>
              <Icon name="chevron-right" size={14} />
              <button
                type="button"
                className="stn-crumb"
                onClick={() => ctx.select({ kind: "block", sectionKey: place.sectionKey, componentIndex: place.componentIndex })}
              >
                {place.blockName}
              </button>
            </>
          ) : (
            <span>Not placed in any section</span>
          )}
        </nav>
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          {place ? `Question ${place.number} of ${place.total}` : "Question"}
          <span className="stn-title-id">{itemKey}</span>
        </h2>
      </header>

      <QuestionBanners lock={lock} onUnlock={() => setUnlocking(true)} variable={item.variable} />

      <article className="stn-card" aria-label="The question as participants see it">
        <div className="stn-card-top">
          <span className="stn-typechip">
            <Icon name={TYPE_ICONS[studioType]} size={16} />
            {typeLabel(studioType)}
          </span>
          {item.responseType !== "info" ? (
            item.required === "hard" ? (
              <Badge icon="check">Required</Badge>
            ) : (
              <Badge tone="muted">Not required</Badge>
            )
          ) : null}
          {item.displayIf ? (
            <Badge tone="accent" icon="branch">
              Shown only to some
            </Badge>
          ) : null}
          {lock.published ? <Badge tone="muted">Published</Badge> : null}
        </div>
        <IssueMessages issues={unplacedIssues(issues, fieldsShownFor(item.responseType))} />

        <TextField
          label="Question text — what participants read"
          field="stem"
          value={item.stem.text}
          multiline
          inputClassName="stn-stem"
          readOnly={!can("stem")}
          issues={issues.byField.get("stem")}
          onCommit={(text) => write(`Edit wording of ${itemKey}`, (it) => ({ stem: { ...it.stem, text } }))}
          after={<PipeList display={item.stem} />}
          emptyText="No question text yet"
        />

        <LedeField itemKey={itemKey} item={item} editable={can("lede")} issues={issues} write={write} />
        <MoreInfoField itemKey={itemKey} item={item} editable={can("moreInfo")} issues={issues} write={write} />

        <TextField
          label="Help text"
          field="hint"
          optional
          value={item.hint ?? ""}
          multiline
          readOnly={!can("hint")}
          hint="Offered on request (“Remind me what this is about”) or after a long pause on this question. Never shown by default."
          issues={issues.byField.get("hint")}
          onCommit={(text) => write(`Edit help text of ${itemKey}`, () => ({ hint: text.trim() ? text : null }))}
          emptyText="No help text"
        />

        <section className="stn-answer" aria-labelledby={`${itemKey}-answer`} data-field="responseType" tabIndex={-1}>
          <div className="stn-answer-head">
            <h3 id={`${itemKey}-answer`} className="stn-eyebrow">
              Answer
            </h3>
            <span className="stn-typechip strong">
              <Icon name={TYPE_ICONS[studioType]} size={16} />
              {typeLabel(studioType)}
            </span>
            {typeReason ? (
              <span className="stn-hint stn-lockreason">
                <Icon name="lock" size={13} /> {typeReason}
              </span>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setPicking(true)} disabled={!ctx.canEdit}>
                Change type
              </Button>
            )}
          </div>
          <IssueMessages issues={issues.byField.get("responseType")} />
          <AnswerEditor itemKey={itemKey} item={item} issues={issues} write={write} can={can} />
        </section>
      </article>

      <Panel title="When it's shown" field="displayIf">
        <ConditionBuilder
          subject={{ kind: "question", itemKey }}
          noun="question"
          expr={item.displayIf}
          readOnly={!can("displayIf")}
          lockedReason={
            lock.tier === "locked" ? (
              <>
                The questions of a licensed questionnaire are asked together.{" "}
                {place ? (
                  <button
                    type="button"
                    className="stp-textlink"
                    onClick={() => ctx.select({ kind: "block", sectionKey: place.sectionKey, componentIndex: place.componentIndex }, { field: "displayIf" })}
                  >
                    Show or hide the whole questionnaire from its block
                  </button>
                ) : null}
                .
              </>
            ) : lock.tier === "protected" ? (
              "Part of a protected module. Unlock it to change when this question is shown."
            ) : ctx.readOnlyReason
          }
          issues={issues.byField.get("displayIf")}
          onWrite={(next) => write(`Change when ${itemKey} is shown`, () => ({ displayIf: next }))}
        />
      </Panel>

      {picking ? (
        <TypePickerDialog
          title={lock.published ? "Replace with a new question of another type" : "Change the answer type"}
          current={studioType}
          intro={
            lock.published ? (
              <p className="stn-flush">
                This question has been published, so answers are already stored under its ID as {typeLabel(studioType).toLowerCase()} answers.
                Changing its type would mix two kinds of answer under one ID. Instead, choose a type to <strong>replace it with a new question</strong>
                : the old one is archived — its answers stay readable — and the new one, with the same wording, starts its own column.
              </p>
            ) : (
              <p className="stn-flush">
                The wording, condition, help text and notes stay. What is specific to the answer is rebuilt for the new type; a choice
                question keeps its options when it becomes another kind of choice.
              </p>
            )
          }
          actionLabel={lock.published ? (label) => `Replace with ${label.toLowerCase()}` : undefined}
          onPick={pickType}
          onClose={() => setPicking(false)}
        />
      ) : null}
      {unlocking ? <UnlockDialog instrument={lock.instrument} onClose={() => setUnlocking(false)} /> : null}
    </div>
  );
}

function QuestionBanners({ lock, onUnlock, variable }: { lock: QuestionLock; onUnlock: () => void; variable: string }) {
  const ctx = useEditor();
  const banners = [];
  if (lock.tier === "locked") {
    const text = lockedBanner(lock);
    banners.push(
      <LockBanner key="locked" title={text.title}>
        {text.body}
      </LockBanner>,
    );
  } else if (lock.tier === "protected" && lock.protection) {
    const text = protectedBanner(lock.protection);
    banners.push(
      <LockBanner
        key="protected"
        tone="warn"
        title={text.title}
        actions={
          <Button size="sm" variant="secondary" icon="unlock" onClick={onUnlock} disabled={!ctx.canEdit}>
            Unlock…
          </Button>
        }
      >
        {text.body}
      </LockBanner>,
    );
  } else if (lock.protection && lock.unlocked) {
    banners.push(
      <LockBanner
        key="unlocked"
        icon="unlock"
        tone="accent"
        title={`Unlocked: ${lock.protection.reason === "ethics" ? "ethics-approved consent" : "participant identifiers"}`}
        actions={
          <Button size="sm" variant="secondary" icon="lock" onClick={() => relock(ctx, lock.instrument)} disabled={!ctx.canEdit}>
            Lock again
          </Button>
        }
      >
        <UnlockedNote instrument={lock.instrument} />
      </LockBanner>,
    );
  }
  if (lock.identityRole) {
    banners.push(
      <LockBanner key="identity" icon="user" title={lock.identityRole === "linkage" ? "Part of the participant code" : "Identifies the participant"}>
        {identityText(lock.identityRole, variable)}
      </LockBanner>,
    );
  }
  return banners.length > 0 ? <div className="stn-banners">{banners}</div> : null;
}

/** Inserted answers in a piece of text, said in words. */
export function PipeList({ display }: { display: { text: string; pipes?: Record<string, unknown> | undefined } | undefined }) {
  const { draft } = useEditor();
  const uses = pipeUses(display as Parameters<typeof pipeUses>[0], draft).filter((u) => u.defined && u.used);
  if (uses.length === 0) return null;
  return (
    <ul className="stn-pipes" aria-label="Inserted answers">
      {uses.map((u) => (
        <li key={u.name}>
          <code>{`{${u.name}}`}</code> is replaced by {u.description}
          {u.fallback ? `, or “${u.fallback}” when there is none` : ""}.
        </li>
      ))}
    </ul>
  );
}

function LedeField({
  itemKey,
  item,
  editable,
  issues,
  write,
}: {
  itemKey: string;
  item: ItemDefinition;
  editable: boolean;
  issues: FieldIssues;
  write: WriteQuestion;
}) {
  const hasPipes = !!item.lede?.pipes && Object.keys(item.lede.pipes).length > 0;
  const validate = useCallback(
    (text: string) =>
      hasPipes && !text.trim() ? "This description inserts an earlier answer, so it can't be emptied here. Undo to go back, or type the new description." : null,
    [hasPipes],
  );
  // A description that can't be written and isn't there is noise, not information.
  if (!editable && !item.lede) return null;
  return (
    <TextField
      label="Description or guidance"
      field="lede"
      optional
      value={item.lede?.text ?? ""}
      multiline
      inputClassName="stn-lede"
      readOnly={!editable}
      validate={validate}
      hint="Shown under the question in body text — for an example, a definition or a reassurance, so the question itself stays short."
      issues={issues.byField.get("lede")}
      onCommit={(text) => write(`Edit the description of ${itemKey}`, (it) => ({ lede: text.trim() ? { ...(it.lede ?? {}), text } : null }))}
      after={<PipeList display={item.lede} />}
      emptyText="No description"
    />
  );
}

function MoreInfoField({
  itemKey,
  item,
  editable,
  issues,
  write,
}: {
  itemKey: string;
  item: ItemDefinition;
  editable: boolean;
  issues: FieldIssues;
  write: WriteQuestion;
}) {
  const info = item.moreInfo;
  // Open once someone starts one, and kept open if its text is emptied, so the
  // box being typed in never disappears from under the caret.
  const [open, setOpen] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("More information");
  const label = info?.label ?? pendingLabel;
  const fieldIssues = issues.byField.get("moreInfo");
  const hasPipes = !!info?.body.pipes && Object.keys(info.body.pipes).length > 0;
  const labelValidate = useCallback((text: string) => (text.trim() ? null : "Give it a label, for example “How we look after your information”."), []);
  const bodyValidate = useCallback(
    (text: string) => (hasPipes && !text.trim() ? "This text inserts an earlier answer, so it can't be emptied here. Undo to go back, or type the new text." : null),
    [hasPipes],
  );

  if (!info && !open) {
    if (!editable) return null;
    return (
      <div className="stn-field" data-field="moreInfo" tabIndex={-1}>
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setOpen(true)}>
          Add “More information”
        </Button>
        <p className="stn-hint">A collapsed panel under the question, for detail a participant may want but shouldn't have to read.</p>
      </div>
    );
  }
  return (
    <Disclosure summary={`More information${info ? `: “${info.label}”` : ""}`} defaultOpen={open || (fieldIssues?.length ?? 0) > 0} className="stn-moreinfo">
      <div data-field="moreInfo">
        <TextField
          label="Its label"
          field="moreInfo.label"
          value={label}
          readOnly={!editable}
          validate={labelValidate}
          hint="The link participants tap to open it."
          onCommit={(text) => {
            if (info) write(`Edit “More information” of ${itemKey}`, (it) => ({ moreInfo: { ...(it.moreInfo ?? { body: { text: "" } }), label: text } }));
            else setPendingLabel(text);
          }}
        />
        <TextField
          label="What it says"
          field="moreInfo.body"
          value={info?.body.text ?? ""}
          multiline
          readOnly={!editable}
          validate={bodyValidate}
          hint={info ? "Empty it to remove “More information” altogether." : "Saved once it has some text."}
          issues={fieldIssues}
          onCommit={(text) => {
            if (!text.trim()) {
              setOpen(true);
              if (info) setPendingLabel(info.label);
            }
            write(`Edit “More information” of ${itemKey}`, (it) =>
              text.trim() ? { moreInfo: { label: it.moreInfo?.label ?? label, body: { ...(it.moreInfo?.body ?? {}), text } } } : { moreInfo: null },
            );
          }}
          after={<PipeList display={info?.body} />}
          emptyText="Nothing yet"
        />
      </div>
    </Disclosure>
  );
}

/** What is specific to the question's type, in the card's answer area. */
function AnswerEditor({
  itemKey,
  item,
  issues,
  write,
  can,
}: {
  itemKey: string;
  item: ItemDefinition;
  issues: FieldIssues;
  write: WriteQuestion;
  can: (field: string) => boolean;
}) {
  const choiceNoun = item.responseType === "rank_group" ? "item" : "option";
  switch (item.responseType) {
    case "single_choice":
    case "multi_choice":
      return (
        <>
          {item.responseType === "multi_choice" ? (
            <p className="stn-answer-note">
              Participants tick every option that applies{item.maxSelections ? `, up to ${item.maxSelections}` : ""}.
            </p>
          ) : null}
          <OptionsEditor itemKey={itemKey} scaleKey={item.scale} issues={issues} />
        </>
      );
    case "rank_group":
      return (
        <>
          <p className="stn-answer-note">Participants drag each item into a group. These are the items:</p>
          <OptionsEditor itemKey={itemKey} scaleKey={item.scale} issues={issues} statementNoun={choiceNoun} />
          <h4 className="stn-eyebrow stn-gap-top">Groups</h4>
          <GroupsEditor itemKey={itemKey} groups={item.groups} editable={can("groups")} issues={issues.byField.get("groups")} />
        </>
      );
    case "checkbox_set":
      return (
        <>
          <p className="stn-answer-note">Participants tick each statement to show they understand and agree.</p>
          <StatementsEditor itemKey={itemKey} statements={item.statements} editable={can("statements")} issues={issues.byField.get("statements")} />
        </>
      );
    case "form_fields":
      return (
        <>
          <p className="stn-answer-note">Participants fill in several labelled boxes on one screen.</p>
          <FieldsEditor itemKey={itemKey} fields={item.fields} editable={can("fields")} issues={issues.byField.get("fields")} />
        </>
      );
    case "slider":
      return (
        <div className="stn-scaleends">
          <p className="stn-answer-note">
            Participants drag along a range from {item.min} to {item.max}
            {item.step && item.step !== 1 ? ` in steps of ${item.step}` : ""}. Set the numbers in the settings panel.
          </p>
          <div className="stn-track" aria-hidden="true">
            <span />
          </div>
          <div className="stn-ends">
            <TextField
              label={`Label at ${item.min}`}
              field="minLabel"
              value={item.minLabel ?? ""}
              readOnly={!can("minLabel")}
              issues={issues.byField.get("minLabel")}
              placeholder="e.g. None of it"
              onCommit={(text) => write(`Edit the slider labels of ${itemKey}`, () => ({ minLabel: text.trim() ? text : null }))}
              emptyText="No label"
            />
            <TextField
              label={`Label at ${item.max}`}
              field="maxLabel"
              value={item.maxLabel ?? ""}
              readOnly={!can("maxLabel")}
              issues={issues.byField.get("maxLabel")}
              placeholder="e.g. All of it"
              onCommit={(text) => write(`Edit the slider labels of ${itemKey}`, () => ({ maxLabel: text.trim() ? text : null }))}
              emptyText="No label"
            />
          </div>
        </div>
      );
    case "ladder":
      return (
        <div className="stn-scaleends">
          <p className="stn-answer-note">
            A drawn ladder of {item.rungs} rungs; participants tap the rung where they would put themselves. Rungs are stored as{" "}
            {item.lowestValue ?? 1} (bottom) to {(item.lowestValue ?? 1) + item.rungs - 1} (top).
          </p>
          <TextField
            label="Label at the top"
            field="topLabel"
            value={item.topLabel ?? ""}
            readOnly={!can("topLabel")}
            issues={issues.byField.get("topLabel")}
            onCommit={(text) => write(`Edit the ladder labels of ${itemKey}`, () => ({ topLabel: text.trim() ? text : null }))}
            emptyText="No label"
          />
          <TextField
            label="Label at the bottom"
            field="bottomLabel"
            value={item.bottomLabel ?? ""}
            readOnly={!can("bottomLabel")}
            issues={issues.byField.get("bottomLabel")}
            onCommit={(text) => write(`Edit the ladder labels of ${itemKey}`, () => ({ bottomLabel: text.trim() ? text : null }))}
            emptyText="No label"
          />
        </div>
      );
    case "numeric": {
      const range =
        item.min !== undefined && item.max !== undefined
          ? ` from ${item.min} to ${item.max}`
          : item.min !== undefined
            ? ` of at least ${item.min}`
            : item.max !== undefined
              ? ` of at most ${item.max}`
              : "";
      return (
        <div className="stn-preview-box" aria-hidden="false">
          <span className="stn-preview-input">{item.integerOnly === false ? "12.5" : "12"}</span>
          {item.unitLabel ? <span className="stn-preview-unit">{item.unitLabel}</span> : null}
          <p className="stn-answer-note">
            Participants type a {item.integerOnly === false ? "number" : "whole number"}
            {range}. Limits and the unit are in the settings panel.
          </p>
        </div>
      );
    }
    case "date":
      return (
        <p className="stn-answer-note">
          Participants pick a date
          {item.minAgeYears !== undefined || item.maxAgeYears !== undefined
            ? `; a date of birth making them younger than ${item.minAgeYears ?? 0} or older than ${item.maxAgeYears ?? 120} is questioned`
            : ""}
          . Age limits are in the settings panel.
        </p>
      );
    case "text_short":
    case "text_long":
      return (
        <div className="stn-preview-box">
          <span className={`stn-preview-input${item.responseType === "text_long" ? " long" : ""}`} />
          <p className="stn-answer-note">
            Participants type {item.responseType === "text_long" ? "as much as they like" : "a short answer"}, up to {item.maxChars ?? (item.responseType === "text_long" ? 5000 : 200)}{" "}
            characters
            {item.responseType === "text_short" && item.pattern ? ", in the format set in the settings panel" : ""}.
          </p>
        </div>
      );
    case "info":
      return <p className="stn-answer-note">Nothing to answer: participants read this and carry on.</p>;
  }
}

/** Where a question sits, for the breadcrumb and "Question 12 of 147". */
function placeOf(draft: StudioDraft, itemKey: string) {
  const live = liveQuestions(draft);
  const q = live.find((x) => x.itemKey === itemKey);
  if (!q) return null;
  const section = draft.composition.sections[q.sectionIndex];
  const def = draft.instruments[q.refKey];
  return {
    sectionKey: q.sectionKey,
    sectionTitle: section?.title ?? q.sectionKey,
    componentIndex: q.componentIndex,
    blockName: def?.name ?? q.instrument,
    number: q.position + 1,
    total: live.length,
  };
}
