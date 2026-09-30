import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import type { ItemDefinition } from "@myself/schema";
import { ABSOLUTE_MAX_AGE_YEARS } from "@myself/schema";
import {
  archiveQuestion,
  deleteQuestion,
  findQuestion,
  liveQuestions,
  scaleUsage,
  setQuestionNotes,
  updateQuestion,
  type StudioDraft,
} from "@myself/studio";
import { versionLabel } from "../../format.js";
import { ConfirmDialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button, IconButton, InfoTip, StatusDot } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Disclosure, IssueMessages, LockTip, NumberField, ReadOnlyValue, SwitchRow, TextField } from "../node/controls.js";
import { noteRename } from "../node/identity.js";
import { questionIssues, type FieldIssues } from "../node/issues.js";
import { identifierLock, publishedPending, questionLock, tierAllows, type QuestionLock } from "../node/locks.js";
import { useQuestionWriter, type WriteQuestion } from "../node/QuestionEditor.js";
import { unlessUnchanged } from "../node/unchanged.js";
import { PRESENTATIONS } from "../node/types.js";
import { PatternExplanation, PatternTester } from "../node/WelcomeEditor.js";
import { patternError } from "../node/pattern.js";
import {
  conditionSummary,
  dependentsOf,
  keyProblem,
  parseNumber,
  requiredChoice,
  suggestedKey,
  suggestedVariable,
  variableProblem,
} from "./settings.js";

/**
 * The settings of a question, in five groups (DESIGN.md §5, Inspector):
 * Answer, Validation, Logic, Reporting and Status — only the settings its type
 * has, each a compact row, with what it does behind an ⓘ.
 */

export function QuestionInspector({ itemKey, stableId }: { itemKey: string; stableId: string }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const found = findQuestion(draft, itemKey)!;
  const item = found.item;
  const lock = questionLock(draft, itemKey, item, ctx.publishedItemKeys);
  const scaleUsers = useMemo(() => ("scale" in item ? scaleUsage(draft, item.scale) : []), [draft, item]);
  const issues = useMemo(() => questionIssues(ctx.issues, itemKey, scaleUsers), [ctx.issues, itemKey, scaleUsers]);
  const write = useQuestionWriter(itemKey);
  const can = (field: string) => ctx.canEdit && tierAllows(lock, field);
  const why = (field: string): string | null => {
    if (can(field)) return null;
    if (!ctx.canEdit) return ctx.readOnlyReason;
    if (lock.tier === "locked") return "Fixed by the questionnaire's licence.";
    if (lock.tier === "protected") return "Part of a protected module. Unlock it to change this.";
    return null;
  };
  const props: SectionProps = { itemKey, item, issues, write, can, why };

  return (
    <div className="sti">
      <h2 className="st-sr">Settings for {itemKey}</h2>
      <Answer {...props} />
      <Validation {...props} />
      <Logic itemKey={itemKey} item={item} />
      <Reporting {...props} stableId={stableId} lock={lock} />
      <Status itemKey={itemKey} item={item} lock={lock} />
    </div>
  );
}

interface SectionProps {
  itemKey: string;
  item: ItemDefinition;
  issues: FieldIssues;
  write: WriteQuestion;
  can: (field: string) => boolean;
  why: (field: string) => string | null;
}

function Group({ title, children, info, id }: { title: string; children: ReactNode; info?: string; id?: string }) {
  const headingId = useId();
  return (
    <section className="sti-group" aria-labelledby={id ?? headingId}>
      <div className="sti-titlerow">
        <h3 className="sti-title" id={id ?? headingId}>
          {title}
        </h3>
        {info ? <InfoTip text={info} label={title} /> : null}
      </div>
      {children}
    </section>
  );
}

const int = (min?: number, max?: number, optional?: boolean) => (text: string) =>
  parseNumber(text, { integer: true, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(optional ? { optional } : {}) });
const num = (optional?: boolean) => (text: string) => parseNumber(text, optional ? { optional } : {});

/** An on/off setting, or its value in words with why when it can't be changed. */
function Toggle({
  label,
  field,
  info,
  checked,
  onChange,
  can,
  why,
  on = "Yes",
  off = "No",
}: {
  label: string;
  field: string;
  info?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  can: (field: string) => boolean;
  why: (field: string) => string | null;
  on?: string;
  off?: string;
}) {
  return can(field) ? (
    <SwitchRow label={label} field={field} checked={checked} onChange={onChange} {...(info ? { info } : {})} />
  ) : (
    <ReadOnlyValue label={label} field={field} inline reason={why(field)}>
      {checked ? on : off}
    </ReadOnlyValue>
  );
}

// ---------------------------------------------------------------------------
// Answer: how it is answered
// ---------------------------------------------------------------------------

function Answer({ itemKey, item, issues, write, can, why }: SectionProps) {
  const ctx = useEditor();
  const label = (what: string) => `Change the ${what} of ${itemKey}`;
  const f = (field: string) => ({ field, issues: issues.byField.get(field), readOnly: !can(field), lockedReason: why(field) });
  const { value, storedOptional } = requiredChoice(item);
  const layoutId = useId();

  let type: ReactNode = null;
  switch (item.responseType) {
    case "single_choice": {
      const options = PRESENTATIONS.filter((p) => p.value !== "wheel" || item.presentation === "wheel");
      const current = item.presentation ?? "cards";
      const chosen = PRESENTATIONS.find((p) => p.value === current);
      type = (
        <>
          {can("presentation") ? (
            <div className="stn-field stn-field-inline">
              <div className="stn-labelrow">
                <label className="stn-label" htmlFor={layoutId}>
                  Layout
                </label>
                {chosen ? <InfoTip text={`${chosen.label}: ${chosen.description}`} label="the layout" /> : null}
              </div>
              <select
                id={layoutId}
                className="st-select sti-select"
                data-field="presentation"
                value={current}
                aria-describedby={`${layoutId}-desc`}
                onChange={(e) => {
                  const next = options.find((p) => p.value === e.target.value);
                  if (next && write(label("layout"), () => ({ presentation: next.value }))) ctx.announce(`Layout: ${next.label}.`);
                }}
              >
                {options.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span id={`${layoutId}-desc`} className="st-sr">
                {chosen?.description}
              </span>
            </div>
          ) : (
            <ReadOnlyValue label="Layout" field="presentation" inline reason={why("presentation")}>
              {chosen?.label ?? current}
            </ReadOnlyValue>
          )}
          {current === "spectrum" && can("spectrumReverse") ? (
            <SwitchRow
              label="Right to left"
              field="spectrumReverse"
              checked={item.spectrumReverse ?? false}
              onChange={(spectrumReverse) => write(label("layout"), () => ({ spectrumReverse }))}
              info="Lays the options out right to left. Only the display changes; the stored values stay the same."
            />
          ) : null}
          <Toggle
            label="Move on when chosen"
            field="autoAdvance"
            checked={item.autoAdvance !== false}
            onChange={(autoAdvance) => write(label("auto-advance"), () => ({ autoAdvance }))}
            info="Moves to the next question as soon as an option is chosen, after a short pause. Never for participants who have reduced motion turned on."
            can={can}
            why={why}
          />
        </>
      );
      break;
    }
    case "numeric":
      type = (
        <TextField
          label="Unit"
          optional
          inline
          {...f("unitLabel")}
          value={item.unitLabel ?? ""}
          placeholder="None"
          info="Shown after the box, e.g. “days” or “hours a week”."
          onCommit={(t) => write(label("unit"), () => ({ unitLabel: t.trim() ? t : null }))}
          emptyText="None"
        />
      );
      break;
    case "slider":
      type = (
        <>
          <NumberField label="Lowest" inline {...f("min")} value={item.min} parse={num()} onCommit={(n) => n !== null && write(label("range"), () => ({ min: n }))} />
          <NumberField label="Highest" inline {...f("max")} value={item.max} parse={num()} onCommit={(n) => n !== null && write(label("range"), () => ({ max: n }))} />
          <NumberField
            label="Step"
            inline
            {...f("step")}
            value={item.step ?? 1}
            parse={(t) => {
              const p = parseNumber(t);
              return p.ok && p.value !== null && p.value <= 0 ? { ok: false, message: "A step must be more than 0." } : p;
            }}
            info="How far one move of the slider goes."
            onCommit={(n) => n !== null && write(label("step"), () => ({ step: n }))}
          />
          <Toggle
            label="Show the number"
            field="showValue"
            checked={item.showValue !== false}
            onChange={(showValue) => write(label("number display"), () => ({ showValue }))}
            info="Shows the chosen number as the slider moves. When off, participants see only the labels at each end."
            can={can}
            why={why}
          />
        </>
      );
      break;
    case "ladder":
      type = (
        <>
          <NumberField label="Rungs" inline {...f("rungs")} value={item.rungs} parse={int(2, 30)} onCommit={(n) => n !== null && write(label("rungs"), () => ({ rungs: n }))} />
          <NumberField
            label="Bottom rung value"
            inline
            {...f("lowestValue")}
            value={item.lowestValue ?? 1}
            parse={int()}
            info="The number the bottom rung is stored as; each rung up adds one."
            onCommit={(n) => n !== null && write(label("rung values"), () => ({ lowestValue: n }))}
          />
        </>
      );
      break;
    default:
      type = null;
  }

  const answerable = item.responseType !== "info";
  if (!answerable && !type) return null;
  return (
    <Group title="Answer">
      {answerable ? (
        <>
          {can("required") ? (
            <SwitchRow
              label="Required"
              field="required"
              checked={value === "hard"}
              onChange={(required) => {
                // Exactly what the two choices wrote before: "hard" or "soft". An
                // item stored as "optional" shows as not required and is left as
                // it is until this is switched.
                if (write(`Change whether ${itemKey} is required`, () => ({ required: required ? "hard" : "soft" }))) {
                  ctx.announce(required ? "An answer is now required." : "An answer is no longer required.");
                }
              }}
              info={`On: participants can't continue without an answer. Off: they're asked “Leave this one blank?” and can skip it.${
                storedOptional ? " Stored as “optional”, which works exactly like off; it's left as it is unless you switch this on." : ""
              }`}
            />
          ) : (
            <ReadOnlyValue label="Required" field="required" inline reason={why("required")}>
              {value === "hard" ? "Yes" : "No"}
            </ReadOnlyValue>
          )}
          <IssueMessages issues={issues.byField.get("required")} />
          <Toggle
            label="Allow “Prefer not to say”"
            field="allowDecline"
            checked={item.allowDecline ?? false}
            onChange={(allowDecline) => write(`Change “Prefer not to say” on ${itemKey}`, () => ({ allowDecline }))}
            info="Adds a “Prefer not to say” button. The answer is recorded as declined, not skipped, so the two can be told apart."
            can={can}
            why={why}
            on="Offered"
            off="Not offered"
          />
          <IssueMessages issues={issues.byField.get("allowDecline")} />
        </>
      ) : null}
      {type}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Validation: what an answer must be
// ---------------------------------------------------------------------------

function Validation({ itemKey, item, issues, write, can, why }: SectionProps) {
  const ctx = useEditor();
  const f = (field: string) => ({ field, issues: issues.byField.get(field), readOnly: !can(field), lockedReason: why(field) });
  const label = (what: string) => `Change the ${what} of ${itemKey}`;

  let body: ReactNode = null;
  let info: string | undefined;
  switch (item.responseType) {
    case "text_short":
    case "text_long":
      body = (
        <>
          <NumberField
            label="Max length"
            inline
            {...f("maxChars")}
            value={item.maxChars ?? (item.responseType === "text_long" ? 5000 : 200)}
            parse={int(1)}
            suffix="chars"
            info="The most characters an answer can have."
            onCommit={(n) => n !== null && write(label("length limit"), () => ({ maxChars: n }))}
          />
          {item.responseType === "text_short" ? (
            <>
              <TextField
                label="Format"
                optional
                mono
                spellCheck={false}
                {...f("pattern")}
                value={item.pattern ?? ""}
                placeholder="Any text"
                validate={(t) => (t.trim() ? patternError(t) : null)}
                info="A regular expression the answer must match, e.g. ^[A-Za-z]{2}$ for two letters."
                infoLabel="the answer format"
                hint={item.pattern ? <PatternExplanation pattern={item.pattern} /> : undefined}
                onCommit={(t) => write(label("answer format"), () => ({ pattern: t.trim() ? t : null }))}
                emptyText="Any text"
              />
              {item.pattern ? <PatternTester pattern={item.pattern} label="Try an answer" /> : null}
              <TextField
                label="Format message"
                optional
                {...f("patternHint")}
                value={item.patternHint ?? ""}
                placeholder="Please check the format"
                info="Shown instead of “Please check the format”. Say what to type, e.g. “Two letters, like JA”."
                infoLabel="the format message"
                onCommit={(t) => write(label("format message"), () => ({ patternHint: t.trim() ? t : null }))}
                emptyText="“Please check the format”"
              />
            </>
          ) : null}
        </>
      );
      break;
    case "numeric":
      body = (
        <>
          <NumberField label="Minimum" optional inline {...f("min")} value={item.min} parse={num(true)} onCommit={(n) => write(label("limits"), () => ({ min: n }))} />
          <NumberField label="Maximum" optional inline {...f("max")} value={item.max} parse={num(true)} onCommit={(n) => write(label("limits"), () => ({ max: n }))} />
          <Toggle
            label="Whole numbers only"
            field="integerOnly"
            checked={item.integerOnly !== false}
            onChange={(integerOnly) => write(label("number kind"), () => ({ integerOnly }))}
            info="When off, participants can type decimals like 2.5."
            can={can}
            why={why}
            off="No — decimals allowed"
          />
        </>
      );
      break;
    case "date":
      info = `For a date of birth: a date making the participant younger or older than this is questioned. Whatever is set here, no survey accepts an age over ${ABSOLUTE_MAX_AGE_YEARS}, so an impossible date of birth can't enter the data.`;
      body = (
        <>
          <NumberField
            label="Youngest age"
            optional
            inline
            {...f("minAgeYears")}
            value={item.minAgeYears}
            parse={int(0, ABSOLUTE_MAX_AGE_YEARS, true)}
            suffix="years"
            onCommit={(n) => write(label("age limits"), () => ({ minAgeYears: n }))}
          />
          <NumberField
            label="Oldest age"
            optional
            inline
            {...f("maxAgeYears")}
            value={item.maxAgeYears}
            parse={int(0, ABSOLUTE_MAX_AGE_YEARS, true)}
            suffix="years"
            onCommit={(n) => write(label("age limits"), () => ({ maxAgeYears: n }))}
          />
        </>
      );
      break;
    case "multi_choice": {
      const count = ctx.draft.scales[item.scale]?.options.length ?? 0;
      body = (
        <NumberField
          label="Most ticks"
          optional
          inline
          {...f("maxSelections")}
          value={item.maxSelections}
          parse={int(1, Math.max(1, count), true)}
          info={`The most options a participant can tick. Leave empty for no limit. This question has ${count} options.`}
          onCommit={(n) => write(label("selection limit"), () => ({ maxSelections: n }))}
        />
      );
      break;
    }
    default:
      body = null;
  }
  if (!body) return null;
  return (
    <Group title="Validation" {...(info ? { info } : {})}>
      {body}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Logic: when it is shown, and what reads its answer
// ---------------------------------------------------------------------------

function Logic({ itemKey, item }: { itemKey: string; item: ItemDefinition }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const dependents = useMemo(() => dependentsOf(draft, itemKey), [draft, itemKey]);
  const conditionCount = dependents.questions.length + dependents.sections.length + dependents.blocks.length;
  const uses = dependents.pipes.length + dependents.checks.length;
  return (
    <Group title="Logic">
      <div className="sti-row">
        <span className="sti-row-label">Condition</span>
        <span className="sti-row-value">{item.displayIf ? "Shown to some" : "None"}</span>
        <Button size="sm" variant="ghost" aria-label="Edit the condition" onClick={() => ctx.select({ kind: "question", itemKey }, { field: "displayIf" })}>
          Edit
        </Button>
      </div>
      {conditionCount > 0 ? (
        <Disclosure summary={conditionSummary(dependents) ?? ""}>
          <DependentList dependents={dependents} />
        </Disclosure>
      ) : (
        <p className="sti-note">No condition uses its answer.</p>
      )}
      {uses > 0 ? (
        <Disclosure summary={`Its answer is used in ${uses} other place${uses === 1 ? "" : "s"}`}>
          <ul className="sti-links">
            {dependents.pipes.map((p) => (
              <li key={`pipe:${p.itemKey ?? p.text}`}>
                {p.itemKey ? <LinkTo itemKey={p.itemKey}>{p.text}</LinkTo> : p.text} — inserts it into its text
              </li>
            ))}
            {dependents.checks.map((c) => (
              <li key={`check:${c.itemKey}`}>
                <LinkTo itemKey={c.itemKey}>{c.text}</LinkTo> — checks its answer against it
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Reporting: how it is identified in the data
// ---------------------------------------------------------------------------

function Reporting({ itemKey, stableId, item, lock, issues, write, can, why }: SectionProps & { stableId: string; lock: QuestionLock }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const instrument = itemKey.slice(0, itemKey.indexOf("."));
  const key = itemKey.slice(itemKey.indexOf(".") + 1);
  // REVIEW FIX: both lock once published, so neither can change before that is known.
  const pending = publishedPending(ctx.publishedStatus);
  const keyLock = ctx.canEdit ? (identifierLock(lock, "ID") ?? pending) : ctx.readOnlyReason;
  const variableLock = ctx.canEdit ? (identifierLock(lock, "reporting label") ?? pending) : ctx.readOnlyReason;
  const notes = draft.notes[itemKey]?.codingNotes ?? "";
  const noteCount = [notes, item.researcherNote, item.a11yNote].filter((n) => !!n && n.trim()).length;

  const rename = useCallback(
    (next: string) => {
      const out = { itemKey };
      const ok = ctx.run(`Change the ID of ${stableId}`, (d) => {
        const result = updateQuestion(d, itemKey, { key: next }, { published: ctx.publishedItemKeys, ...(ctx.reserved ? { reserved: ctx.reserved } : {}) });
        out.itemKey = result.itemKey;
        return result.draft;
      });
      if (ok && out.itemKey !== itemKey) {
        noteRename(itemKey, out.itemKey);
        ctx.select({ kind: "question", itemKey: out.itemKey });
      }
    },
    [ctx, itemKey, stableId],
  );
  const validateKey = useCallback((t: string) => keyProblem(draft, itemKey, t, ctx.reserved), [draft, itemKey, ctx.reserved]);
  const validateVariable = useCallback((t: string) => variableProblem(draft, item.variable, t, ctx.reserved), [draft, item.variable, ctx.reserved]);

  const copy = () => {
    void navigator.clipboard?.writeText(itemKey).then(
      () => ctx.announce(`Copied ${itemKey}.`),
      () => ctx.announce("Couldn't copy. Select the ID and copy it instead."),
    );
  };

  const identifying = item.identifying ?? false;
  const identifyingEditable = can("identifying") && !(lock.identityRole && identifying);
  const identifyingReason = lock.identityRole
    ? "Always identifying: this answer identifies the participant, so it is always kept out of the research data."
    : why("identifying");

  return (
    <Group title="Reporting">
      <TextField
        label="ID"
        field="key"
        // Locked, it reads as the whole ID; editable, the box holds the part after the block's prefix.
        value={keyLock !== null ? itemKey : key}
        mono
        spellCheck={false}
        readOnly={keyLock !== null}
        lockedReason={keyLock}
        validate={validateKey}
        issues={issues.byField.get("key")}
        info={`The question's ID is ${itemKey}: every export lists its column as ${instrument}.<ID>. It can change until the question is first published.`}
        infoLabel="the ID"
        trailing={
          <span className="sti-idtools">
            {keyLock === null ? (
              <IconButton icon="restart" size="sm" label="Make the ID from the wording" onClick={() => rename(suggestedKey(draft, itemKey, item.stem.text, ctx.reserved))} />
            ) : null}
            <IconButton icon="copy" size="sm" label={`Copy ${itemKey}`} onClick={copy} />
          </span>
        }
        onCommit={rename}
      />
      <TextField
        label="Reporting label"
        field="variable"
        value={item.variable}
        mono
        spellCheck={false}
        readOnly={variableLock !== null}
        lockedReason={variableLock}
        validate={validateVariable}
        issues={issues.byField.get("variable")}
        info="The column name in the data: lowercase letters, numbers and underscores, at most 32 characters. Locked once published."
        trailing={
          variableLock === null ? (
            <span className="sti-idtools">
              <IconButton
                icon="restart"
                size="sm"
                label="Make the reporting label from the ID"
                onClick={() => write(`Change the reporting label of ${stableId}`, () => ({ variable: suggestedVariable(draft, key, item.variable, ctx.reserved) }))}
              />
            </span>
          ) : undefined
        }
        onCommit={(variable) => write(`Change the reporting label of ${stableId}`, () => ({ variable }))}
      />
      <TextField
        label="Category"
        optional
        field="reportingCategory"
        value={item.reportingCategory ?? ""}
        maxLength={64}
        placeholder="e.g. Screen use"
        readOnly={!can("reportingCategory")}
        lockedReason={why("reportingCategory")}
        issues={issues.byField.get("reportingCategory")}
        info="Groups this column in reports, e.g. “Screen use” or “Sleep”. Participants never see it."
        infoLabel="the reporting category"
        onCommit={(t) => write(`Change the reporting category of ${itemKey}`, () => ({ reportingCategory: t.trim() ? t : null }))}
        emptyText="None"
      />

      {identifyingEditable ? (
        <SwitchRow
          label="Identifying"
          field="identifying"
          checked={identifying}
          onChange={(next) => write(`Change whether ${itemKey} identifies someone`, () => ({ identifying: next }))}
          info="Kept apart from research data: answers go to the separate identity store when a sitting is uploaded and never appear in the research data, the researcher view or exports. Turn it on for names, dates of birth, addresses — anything that could identify someone."
        />
      ) : (
        <ReadOnlyValue label="Identifying" field="identifying" inline reason={identifyingReason}>
          {identifying ? (
            <span className="sti-flag">
              <Icon name="lock" size={14} /> Kept apart
            </span>
          ) : (
            "No"
          )}
        </ReadOnlyValue>
      )}
      <IssueMessages issues={issues.byField.get("identifying")} />

      <Disclosure summary={noteCount > 0 ? `Notes · ${noteCount}` : "Notes"} className="sti-notes">
        <TextField
          label="Coding notes"
          optional
          multiline
          field="codingNotes"
          value={notes}
          readOnly={!ctx.canEdit}
          lockedReason={ctx.readOnlyReason}
          info="For analysts: how to code or clean this column. Kept with the draft only — never published."
          onCommit={(t) =>
            ctx.run(`Edit the coding notes of ${itemKey}`, (d) =>
              // Stored trimmed: no undo step for a space at the end (unchanged.ts).
              unlessUnchanged(d, setQuestionNotes(d, itemKey, { codingNotes: t.trim() ? t : null }).draft, (x) => x.notes[itemKey]),
            )
          }
          emptyText="None"
        />
        <TextField
          label="Researcher note"
          optional
          multiline
          field="researcherNote"
          value={item.researcherNote ?? ""}
          readOnly={!can("researcherNote")}
          lockedReason={why("researcherNote")}
          issues={issues.byField.get("researcherNote")}
          info="Travels with the published version, for anyone reading the codebook. Participants never see it."
          onCommit={(t) => write(`Edit the researcher note of ${itemKey}`, () => ({ researcherNote: t.trim() ? t : null }))}
          emptyText="None"
        />
        <TextField
          label="Screen-reader note"
          optional
          multiline
          field="a11yNote"
          value={item.a11yNote ?? ""}
          readOnly={!can("a11yNote")}
          lockedReason={why("a11yNote")}
          issues={issues.byField.get("a11yNote")}
          info="Kept with the question for reference. The participant app does not read it out yet, so don't rely on it to explain anything to participants."
          onCommit={(t) => write(`Edit the screen-reader note of ${itemKey}`, () => ({ a11yNote: t.trim() ? t : null }))}
          emptyText="None"
        />
      </Disclosure>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function inBaseline(baseline: StudioDraft | null | undefined, itemKey: string): boolean {
  return !!baseline && liveQuestions(baseline).some((q) => q.itemKey === itemKey);
}

function Status({ itemKey, item, lock }: { itemKey: string; item: ItemDefinition; lock: QuestionLock }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const dependents = useMemo(() => dependentsOf(draft, itemKey), [draft, itemKey]);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const live = ctx.published?.active?.version ?? null;
  const baselineHas = useMemo(() => inBaseline(ctx.published?.baseline, itemKey), [ctx.published?.baseline, itemKey]);
  const conditionCount = dependents.questions.length + dependents.sections.length + dependents.blocks.length;

  const archiveBlocked =
    lock.tier === "locked"
      ? "A licensed questionnaire is only valid asked whole. Remove the whole block instead."
      : lock.tier === "protected"
        ? "Part of a protected module. Unlock it first."
        : lock.identityRole === "linkage"
          ? "The participant code is built from this answer, so it can never be removed."
          : null;
  // REVIEW FIX: only a never-published question may be deleted, so not before that is known.
  const pending = publishedPending(ctx.publishedStatus);
  const deleteBlocked = lock.published ? "Published questions are archived, never deleted." : (pending ?? archiveBlocked);

  const archive = () => {
    setConfirm(null);
    if (ctx.run(`Archive ${itemKey}`, (d) => archiveQuestion(d, itemKey, ctx.actor()).draft)) {
      ctx.announce("Archived. It's no longer asked; restore it from the centre panel.");
    }
  };
  const remove = () => {
    setConfirm(null);
    if (ctx.run(`Delete ${itemKey}`, (d) => deleteQuestion(d, itemKey, { published: ctx.publishedItemKeys }).draft)) {
      ctx.announce("Deleted. Undo brings it back.");
      ctx.select(null);
    }
  };
  const place = findQuestion(draft, itemKey)?.placements[0];

  const status = lock.published
    ? {
        tone: "accent" as const,
        text: baselineHas && live ? `Live in ${versionLabel(live)}` : "Published earlier",
        info: `${baselineHas && live ? `In the live version, ${versionLabel(live)}.` : "In an earlier published version."} Its ID and reporting label are fixed, and removing it archives it.`,
      }
    : pending
      ? { tone: "neutral" as const, text: "Checking…", info: pending }
      : {
          tone: "neutral" as const,
          text: "Not yet published",
          info: "Its ID and reporting label can still change, and deleting it removes it for good.",
        };

  return (
    <Group title="Status">
      <p className="sti-status">
        <StatusDot tone={status.tone} />
        <span>{status.text}</span>
        <InfoTip text={status.info} label="publishing" />
      </p>
      <div className="sti-actions">
        {archiveBlocked ? (
          <p className="sti-note">
            <LockTip reason={archiveBlocked} label="Why it can't be archived" />
            <span>Can't be archived on its own.</span>
            {lock.tier === "locked" && place ? (
              <button
                type="button"
                className="stp-textlink"
                onClick={() => ctx.select({ kind: "block", sectionKey: place.sectionKey, componentIndex: place.componentIndex })}
              >
                Go to the block
              </button>
            ) : null}
          </p>
        ) : (
          <Button size="sm" variant="secondary" icon="archive" onClick={() => setConfirm("archive")} disabled={!ctx.canEdit}>
            Archive
          </Button>
        )}
        {!lock.published && !deleteBlocked ? (
          <Button size="sm" variant="ghost" className="sti-delete" icon="trash" onClick={() => setConfirm("delete")} disabled={!ctx.canEdit}>
            Delete
          </Button>
        ) : null}
      </div>
      {confirm ? (
        <ConfirmDialog
          title={confirm === "archive" ? "Archive this question?" : "Delete this question?"}
          body={
            <>
              <p className="stn-flush">
                {confirm === "archive"
                  ? "It stops being asked. Its ID and reporting label stay reserved, answers already recorded stay readable, and you can restore it."
                  : `It was never published, so nothing was recorded under it. It is removed for good, and “${item.variable}” becomes free.`}
              </p>
              {conditionCount > 0 ? (
                <p>
                  <strong>
                    {conditionCount} condition{conditionCount === 1 ? " depends" : "s depend"} on its answer
                  </strong>{" "}
                  and will need changing — validation will point them out.
                </p>
              ) : null}
            </>
          }
          confirmLabel={confirm === "archive" ? "Archive" : "Delete"}
          destructive={confirm === "delete"}
          onCancel={() => setConfirm(null)}
          onConfirm={confirm === "archive" ? archive : remove}
        />
      ) : null}
    </Group>
  );
}

function LinkTo({ itemKey, children }: { itemKey: string; children: ReactNode }) {
  const { select } = useEditor();
  return (
    <button type="button" className="stp-textlink" onClick={() => select({ kind: "question", itemKey }, { field: "displayIf" })}>
      {children}
    </button>
  );
}

function DependentList({ dependents }: { dependents: ReturnType<typeof dependentsOf> }) {
  const { select } = useEditor();
  return (
    <ul className="sti-links">
      {dependents.questions.map((q) => (
        <li key={q.itemKey}>
          <LinkTo itemKey={q.itemKey}>{q.text}</LinkTo>
        </li>
      ))}
      {dependents.sections.map((s) => (
        <li key={`s:${s.sectionKey}`}>
          <button type="button" className="stp-textlink" onClick={() => select({ kind: "section", sectionKey: s.sectionKey }, { field: "displayIf" })}>
            Section “{s.title}”
          </button>
        </li>
      ))}
      {dependents.blocks.map((b) => (
        <li key={`b:${b.sectionKey}:${b.componentIndex}`}>
          <button
            type="button"
            className="stp-textlink"
            onClick={() => select({ kind: "block", sectionKey: b.sectionKey, componentIndex: b.componentIndex }, { field: "displayIf" })}
          >
            Block “{b.name}”
          </button>
        </li>
      ))}
    </ul>
  );
}
