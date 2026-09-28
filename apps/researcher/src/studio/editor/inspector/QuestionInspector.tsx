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
import { Badge, Button, IconButton, Switch } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Disclosure, IssueMessages, NumberField, ReadOnlyValue, TextField } from "../node/controls.js";
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
  notAvailableFor,
  parseNumber,
  requiredChoice,
  suggestedKey,
  suggestedVariable,
  variableProblem,
} from "./settings.js";

/**
 * The settings of a question: how it is answered, what is specific to its
 * type, how it is identified in the data, and where it stands — only the
 * settings its type has, and only in the words a researcher would use.
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

  return (
    <div className="sti">
      <header className="sti-head">
        <p className="sti-eyebrow">Question settings</p>
        <p className="sti-id">
          <code>{itemKey}</code>
        </p>
      </header>
      {item.responseType !== "info" ? <Answering itemKey={itemKey} item={item} issues={issues} write={write} can={can} why={why} /> : null}
      <TypeSettings itemKey={itemKey} item={item} issues={issues} write={write} can={can} why={why} />
      <Identity itemKey={itemKey} stableId={stableId} item={item} lock={lock} issues={issues} write={write} can={can} why={why} />
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

function Group({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  const headingId = useId();
  return (
    <section className="sti-group" aria-labelledby={id ?? headingId}>
      <h3 className="sti-title" id={id ?? headingId}>
        {title}
      </h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

function Answering({ itemKey, item, issues, write, can, why }: SectionProps) {
  const ctx = useEditor();
  const name = useId();
  const { value, storedOptional } = requiredChoice(item);
  const choices = [
    { value: "hard" as const, label: "Required", detail: "Can't continue without an answer." },
    { value: "soft" as const, label: "Not required", detail: "Participants are asked “Leave this one blank?” and can skip it." },
  ];
  return (
    <Group title="Answering">
      {can("required") ? (
        <fieldset className="sti-radios" data-field="required">
          <legend className="st-sr">Is an answer required?</legend>
          {choices.map((c) => (
            <label key={c.value} className={`sti-radio${value === c.value ? " on" : ""}`}>
              <input
                type="radio"
                name={name}
                value={c.value}
                checked={value === c.value}
                onChange={() => {
                  if (write(`Change whether ${itemKey} is required`, () => ({ required: c.value }))) {
                    ctx.announce(c.value === "hard" ? "An answer is now required." : "An answer is no longer required.");
                  }
                }}
              />
              <span>
                <strong>{c.label}</strong> — {c.detail}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <ReadOnlyValue label="Required" field="required" reason={why("required")}>
          {value === "hard" ? "Required — can't continue without an answer" : "Not required"}
        </ReadOnlyValue>
      )}
      {storedOptional ? (
        <p className="sti-note">
          Stored as “optional”, which participants experience exactly as not required. It is left as it is unless you choose Required.
        </p>
      ) : null}
      <IssueMessages issues={issues.byField.get("required")} />
      <div data-field="allowDecline">
        {can("allowDecline") ? (
          <Switch
            label="Offer “Prefer not to say”"
            checked={item.allowDecline ?? false}
            onChange={(allowDecline) => write(`Change “Prefer not to say” on ${itemKey}`, () => ({ allowDecline }))}
            hint="Adds a “Prefer not to say” button. The answer is recorded as declined, not skipped, so the two can be told apart."
          />
        ) : (
          <ReadOnlyValue label="“Prefer not to say”" reason={why("allowDecline")}>
            {item.allowDecline ? "Offered" : "Not offered"}
          </ReadOnlyValue>
        )}
        <IssueMessages issues={issues.byField.get("allowDecline")} />
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Settings specific to the type
// ---------------------------------------------------------------------------

const int = (min?: number, max?: number, optional?: boolean) => (text: string) =>
  parseNumber(text, { integer: true, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(optional ? { optional } : {}) });
const num = (optional?: boolean) => (text: string) => parseNumber(text, optional ? { optional } : {});

function TypeSettings({ itemKey, item, issues, write, can, why }: SectionProps) {
  const ctx = useEditor();
  const f = (field: string) => ({ field, issues: issues.byField.get(field), readOnly: !can(field), lockedReason: why(field) });
  const label = (what: string) => `Change the ${what} of ${itemKey}`;
  const presentationName = useId();
  const unavailable = notAvailableFor(item.responseType);

  let body: ReactNode = null;
  switch (item.responseType) {
    case "text_short":
    case "text_long":
      body = (
        <>
          <NumberField
            label="Longest answer"
            {...f("maxChars")}
            value={item.maxChars ?? (item.responseType === "text_long" ? 5000 : 200)}
            parse={int(1)}
            suffix="characters"
            onCommit={(n) => n !== null && write(label("length limit"), () => ({ maxChars: n }))}
          />
          {item.responseType === "text_short" ? (
            <>
              <TextField
                label="Answer format (pattern)"
                optional
                mono
                spellCheck={false}
                {...f("pattern")}
                value={item.pattern ?? ""}
                validate={(t) => (t.trim() ? patternError(t) : null)}
                hint={item.pattern ? <PatternExplanation pattern={item.pattern} /> : "A regular expression the answer must match, e.g. ^[A-Za-z]{2}$ for two letters."}
                onCommit={(t) => write(label("answer format"), () => ({ pattern: t.trim() ? t : null }))}
                emptyText="Any text"
              />
              {item.pattern ? <PatternTester pattern={item.pattern} label="Try an answer" /> : null}
              <TextField
                label="Message when the format doesn't match"
                optional
                {...f("patternHint")}
                value={item.patternHint ?? ""}
                hint="Shown instead of “Please check the format”. Say what to type, e.g. “Two letters, like JA”."
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
          <div className="sti-pair">
            <NumberField label="Smallest" optional {...f("min")} value={item.min} parse={num(true)} onCommit={(n) => write(label("limits"), () => ({ min: n }))} />
            <NumberField label="Largest" optional {...f("max")} value={item.max} parse={num(true)} onCommit={(n) => write(label("limits"), () => ({ max: n }))} />
          </div>
          <div data-field="integerOnly">
            {can("integerOnly") ? (
              <Switch
                label="Whole numbers only"
                checked={item.integerOnly !== false}
                onChange={(integerOnly) => write(label("number kind"), () => ({ integerOnly }))}
                hint="When off, participants can type decimals like 2.5."
              />
            ) : (
              <ReadOnlyValue label="Whole numbers only" reason={why("integerOnly")}>
                {item.integerOnly !== false ? "Yes" : "No — decimals allowed"}
              </ReadOnlyValue>
            )}
          </div>
          <TextField
            label="Unit"
            optional
            {...f("unitLabel")}
            value={item.unitLabel ?? ""}
            hint="Shown after the box, e.g. “days” or “hours a week”."
            onCommit={(t) => write(label("unit"), () => ({ unitLabel: t.trim() ? t : null }))}
            emptyText="None"
          />
        </>
      );
      break;
    case "slider":
      body = (
        <>
          <div className="sti-pair">
            <NumberField label="Lowest" {...f("min")} value={item.min} parse={num()} onCommit={(n) => n !== null && write(label("range"), () => ({ min: n }))} />
            <NumberField label="Highest" {...f("max")} value={item.max} parse={num()} onCommit={(n) => n !== null && write(label("range"), () => ({ max: n }))} />
          </div>
          <NumberField
            label="Step"
            {...f("step")}
            value={item.step ?? 1}
            parse={(t) => {
              const p = parseNumber(t);
              return p.ok && p.value !== null && p.value <= 0 ? { ok: false, message: "A step must be more than 0." } : p;
            }}
            hint="How far one move of the slider goes."
            onCommit={(n) => n !== null && write(label("step"), () => ({ step: n }))}
          />
          <div data-field="showValue">
            {can("showValue") ? (
              <Switch
                label="Show the chosen number"
                checked={item.showValue !== false}
                onChange={(showValue) => write(label("number display"), () => ({ showValue }))}
                hint="When off, participants see only the labels at each end."
              />
            ) : (
              <ReadOnlyValue label="Show the chosen number" reason={why("showValue")}>
                {item.showValue !== false ? "Yes" : "No"}
              </ReadOnlyValue>
            )}
          </div>
          <p className="sti-note">The labels at each end are edited on the question itself.</p>
        </>
      );
      break;
    case "date":
      body = (
        <>
          <div className="sti-pair">
            <NumberField
              label="Youngest age"
              optional
              {...f("minAgeYears")}
              value={item.minAgeYears}
              parse={int(0, ABSOLUTE_MAX_AGE_YEARS, true)}
              suffix="years"
              onCommit={(n) => write(label("age limits"), () => ({ minAgeYears: n }))}
            />
            <NumberField
              label="Oldest age"
              optional
              {...f("maxAgeYears")}
              value={item.maxAgeYears}
              parse={int(0, ABSOLUTE_MAX_AGE_YEARS, true)}
              suffix="years"
              onCommit={(n) => write(label("age limits"), () => ({ maxAgeYears: n }))}
            />
          </div>
          <p className="sti-note">
            For a date of birth: a date making the participant younger or older than this is questioned. Whatever is set here, no survey accepts an
            age over {ABSOLUTE_MAX_AGE_YEARS} — the app holds to that ceiling, so an impossible date of birth can't enter the data.
          </p>
        </>
      );
      break;
    case "multi_choice": {
      const count = ctx.draft.scales[item.scale]?.options.length ?? 0;
      body = (
        <NumberField
          label="Most options a participant can tick"
          optional
          {...f("maxSelections")}
          value={item.maxSelections}
          parse={int(1, Math.max(1, count), true)}
          hint={`Leave empty for no limit. This question has ${count} options.`}
          onCommit={(n) => write(label("selection limit"), () => ({ maxSelections: n }))}
        />
      );
      break;
    }
    case "single_choice": {
      const options = PRESENTATIONS.filter((p) => p.value !== "wheel" || item.presentation === "wheel");
      const current = item.presentation ?? "cards";
      body = (
        <>
          {can("presentation") ? (
            <fieldset className="sti-radios" data-field="presentation">
              <legend className="sti-legend">Layout</legend>
              {options.map((p) => (
                <label key={p.value} className={`sti-radio${current === p.value ? " on" : ""}`}>
                  <input
                    type="radio"
                    name={presentationName}
                    value={p.value}
                    checked={current === p.value}
                    onChange={() => {
                      if (write(label("layout"), () => ({ presentation: p.value }))) ctx.announce(`Layout: ${p.label}.`);
                    }}
                  />
                  <span>
                    <strong>{p.label}</strong> — {p.description}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <ReadOnlyValue label="Layout" field="presentation" reason={why("presentation")}>
              {PRESENTATIONS.find((p) => p.value === current)?.label ?? current}
            </ReadOnlyValue>
          )}
          {current === "spectrum" ? (
            <div data-field="spectrumReverse">
              {can("spectrumReverse") ? (
                <Switch
                  label="Lay the options out right to left"
                  checked={item.spectrumReverse ?? false}
                  onChange={(spectrumReverse) => write(label("layout"), () => ({ spectrumReverse }))}
                  hint="Only the display changes; the stored values stay the same."
                />
              ) : null}
            </div>
          ) : null}
          <div data-field="autoAdvance">
            {can("autoAdvance") ? (
              <Switch
                label="Move on as soon as an option is chosen"
                checked={item.autoAdvance !== false}
                onChange={(autoAdvance) => write(label("auto-advance"), () => ({ autoAdvance }))}
                hint="After a short pause. It never happens for participants who have reduced motion turned on."
              />
            ) : (
              <ReadOnlyValue label="Move on as soon as an option is chosen" reason={why("autoAdvance")}>
                {item.autoAdvance !== false ? "Yes" : "No"}
              </ReadOnlyValue>
            )}
          </div>
        </>
      );
      break;
    }
    case "ladder":
      body = (
        <>
          <div className="sti-pair">
            <NumberField label="Rungs" {...f("rungs")} value={item.rungs} parse={int(2, 30)} onCommit={(n) => n !== null && write(label("rungs"), () => ({ rungs: n }))} />
            <NumberField
              label="Bottom rung stored as"
              {...f("lowestValue")}
              value={item.lowestValue ?? 1}
              parse={int()}
              onCommit={(n) => n !== null && write(label("rung values"), () => ({ lowestValue: n }))}
            />
          </div>
          <p className="sti-note">The labels at the top and bottom are edited on the question itself.</p>
        </>
      );
      break;
    default:
      body = null;
  }

  if (!body && unavailable.length === 0) return null;
  return (
    <Group title="Answer settings">
      {body ?? <p className="sti-note">This type of question has no further settings.</p>}
      {unavailable.length > 0 ? (
        <Disclosure summary="Not available yet" className="sti-unavailable">
          <ul>
            {unavailable.map((u) => (
              <li key={u.label}>
                <strong>{u.label}.</strong> {u.reason}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Identity and reporting
// ---------------------------------------------------------------------------

function Identity({ itemKey, stableId, item, lock, issues, write, can, why }: SectionProps & { stableId: string; lock: QuestionLock }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const instrument = itemKey.slice(0, itemKey.indexOf("."));
  const key = itemKey.slice(itemKey.indexOf(".") + 1);
  // REVIEW FIX: both lock once published, so neither can change before that is known.
  const pending = publishedPending(ctx.publishedStatus);
  const keyLock = ctx.canEdit ? (identifierLock(lock, "ID") ?? pending) : ctx.readOnlyReason;
  const variableLock = ctx.canEdit ? (identifierLock(lock, "reporting label") ?? pending) : ctx.readOnlyReason;
  const notes = draft.notes[itemKey]?.codingNotes ?? "";

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

  return (
    <Group title="Identity and reporting">
      <TextField
        label="Question ID"
        field="key"
        value={key}
        mono
        spellCheck={false}
        readOnly={keyLock !== null}
        lockedReason={keyLock}
        validate={validateKey}
        issues={issues.byField.get("key")}
        hint={keyLock === null ? `Part of every export's column list as ${instrument}.<ID>. It can change until the question is first published.` : undefined}
        onCommit={rename}
        after={
          <div className="sti-idrow">
            <code className="sti-fullid">{itemKey}</code>
            <IconButton icon="copy" size="sm" label={`Copy ${itemKey}`} onClick={copy} />
            {keyLock === null ? (
              <Button size="sm" variant="ghost" onClick={() => rename(suggestedKey(draft, itemKey, item.stem.text, ctx.reserved))}>
                Make from the wording
              </Button>
            ) : null}
          </div>
        }
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
        hint={variableLock === null ? "The column name in the data: lowercase letters, numbers and underscores, at most 32 characters. Locked once published." : undefined}
        onCommit={(variable) => write(`Change the reporting label of ${stableId}`, () => ({ variable }))}
        after={
          variableLock === null ? (
            <div className="sti-idrow">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => write(`Change the reporting label of ${stableId}`, () => ({ variable: suggestedVariable(draft, key, item.variable, ctx.reserved) }))}
              >
                Make from the ID
              </Button>
            </div>
          ) : null
        }
      />
      <TextField
        label="Reporting category"
        optional
        field="reportingCategory"
        value={item.reportingCategory ?? ""}
        maxLength={64}
        readOnly={!can("reportingCategory")}
        lockedReason={why("reportingCategory")}
        issues={issues.byField.get("reportingCategory")}
        hint="Groups this column in reports, e.g. “Screen use” or “Sleep”. Participants never see it."
        onCommit={(t) => write(`Change the reporting category of ${itemKey}`, () => ({ reportingCategory: t.trim() ? t : null }))}
        emptyText="None"
      />

      <div className="sti-sensitivity" data-field="identifying">
        {identifyingEditable ? (
          <Switch
            label="Identifying — kept apart from research data"
            checked={identifying}
            onChange={(next) => write(`Change whether ${itemKey} identifies someone`, () => ({ identifying: next }))}
            hint="Answers go to the separate identity store when a sitting is uploaded and never appear in the research data, the researcher view or exports. Turn it on for names, dates of birth, addresses — anything that could identify someone."
          />
        ) : (
          <ReadOnlyValue
            label="Data sensitivity"
            reason={
              lock.identityRole
                ? "Always identifying: this answer identifies the participant, so it is always kept out of the research data."
                : why("identifying")
            }
          >
            {identifying ? (
              <>
                <Icon name="lock" size={14} /> Identifying — kept apart from research data
              </>
            ) : (
              "Not identifying — goes into the research data"
            )}
          </ReadOnlyValue>
        )}
        <IssueMessages issues={issues.byField.get("identifying")} />
      </div>

      <TextField
        label="Coding notes"
        optional
        multiline
        field="codingNotes"
        value={notes}
        readOnly={!ctx.canEdit}
        lockedReason={ctx.readOnlyReason}
        hint="For analysts: how to code or clean this column. Kept with the draft only — never published."
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
        hint="Travels with the published version, for anyone reading the codebook. Participants never see it."
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
        hint="Kept with the question for reference. The participant app does not read it out yet, so don't rely on it to explain anything to participants."
        onCommit={(t) => write(`Edit the screen-reader note of ${itemKey}`, () => ({ a11yNote: t.trim() ? t : null }))}
        emptyText="None"
      />
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

  return (
    <Group title="Status">
      <p className="sti-status">
        {lock.published ? (
          <>
            <Badge tone="accent" icon="publish">
              Published
            </Badge>{" "}
            {baselineHas && live ? `In the live version, ${versionLabel(live)}.` : "In an earlier published version."} Its ID and reporting label
            are fixed, and removing it archives it.
          </>
        ) : pending ? (
          <>
            <Badge tone="muted">Checking</Badge> {pending}
          </>
        ) : (
          <>
            <Badge tone="muted">Not yet published</Badge> Its ID and reporting label can still change, and deleting it removes it for good.
          </>
        )}
      </p>
      {conditionCount > 0 ? (
        <Disclosure summary={conditionSummary(dependents) ?? ""}>
          <DependentList dependents={dependents} />
        </Disclosure>
      ) : (
        <p className="sti-note">No condition depends on its answer.</p>
      )}
      {dependents.pipes.length > 0 || dependents.checks.length > 0 ? (
        <Disclosure summary={`Its answer is used in ${dependents.pipes.length + dependents.checks.length} other place${dependents.pipes.length + dependents.checks.length === 1 ? "" : "s"}`}>
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
      <div className="sti-actions">
        {archiveBlocked ? (
          <p className="sti-note">
            <Icon name="lock" size={14} /> {archiveBlocked}
            {lock.tier === "locked" && place ? (
              <>
                {" "}
                <button
                  type="button"
                  className="stp-textlink"
                  onClick={() => ctx.select({ kind: "block", sectionKey: place.sectionKey, componentIndex: place.componentIndex })}
                >
                  Go to the block
                </button>
              </>
            ) : null}
          </p>
        ) : (
          <Button icon="archive" onClick={() => setConfirm("archive")} disabled={!ctx.canEdit}>
            Archive
          </Button>
        )}
        {!lock.published && !deleteBlocked ? (
          <Button variant="ghost" icon="trash" onClick={() => setConfirm("delete")} disabled={!ctx.canEdit}>
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
