import { useCallback, useId, useMemo, useState } from "react";
import { updateWelcome, type StudioDraft, type WelcomePatch } from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { IssueMessages, Panel, ReadOnlyValue, TextField } from "./controls.js";
import { issuesAt, screenIssues } from "./issues.js";
import { explainPattern, isAnchored, patternError, testPattern } from "./pattern.js";
import { unlessUnchanged } from "./unchanged.js";

/**
 * The start screen: the first thing a participant sees, before any question.
 * It asks for the code the research team gave them, says what the study is,
 * and says who to contact.
 */

const DEFAULT_CODE = {
  pattern: "^[A-Za-z0-9]{3,16}$",
  hint: "Letters and numbers, between 3 and 16 characters",
};

/** What `updateWelcome` can change. */
const welcomePart = (d: StudioDraft) => [d.composition.participantCode, d.composition.studyLabel, d.composition.contact];

export function WelcomeEditor() {
  const ctx = useEditor();
  const { draft } = ctx;
  const c = draft.composition;
  const code = c.participantCode;
  const issues = useMemo(() => screenIssues(ctx.issues, "welcome"), [ctx.issues]);
  const readOnly = !ctx.canEdit;
  const write = useCallback(
    // No undo step for an edit that changes nothing, e.g. spaces in an empty box (unchanged.ts).
    (label: string, patch: WelcomePatch) => ctx.run(label, (d) => unlessUnchanged(d, updateWelcome(d, patch).draft, welcomePart)),
    [ctx],
  );
  const validatePattern = useCallback((text: string) => (text.trim() ? patternError(text) : "The code needs a format, or any text at all would be accepted."), []);

  return (
    <div className="stn-node">
      <header className="stn-pagehead">
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          Start screen
        </h2>
        <p className="stn-lead">The first screen, where participants enter the code the research team gave them.</p>
      </header>

      <WelcomePreview />
      <IssueMessages issues={issues.general} />

      <Panel title="Study label">
        <TextField
          label="Study label"
          hideLabel
          field="studyLabel"
          value={c.studyLabel ?? ""}
          placeholder="e.g. Notre Dame · 2026"
          readOnly={readOnly}
          hint="Shown above the code box. The survey's title isn't shown to participants."
          issues={issuesAt(issues, "studyLabel")}
          onCommit={(text) => write("Edit the study label", { studyLabel: text.trim() ? text : null })}
          emptyText="None"
        />
      </Panel>

      <Panel title="Participant code" field="participantCode">
        {code ? (
          <>
            <TextField
              label="Label"
              field="participantCode.label"
              value={code.label ?? ""}
              placeholder="Your participant code"
              readOnly={readOnly}
              info="The label above the box. Left empty, it reads “Your participant code”."
              infoLabel="the code box's label"
              issues={issuesAt(issues, "participantCode.label")}
              onCommit={(text) => write("Edit the start screen", { participantCode: { label: text.trim() ? text : null } })}
              emptyText="Your participant code (the default)"
            />
            <TextField
              label="Instructions"
              field="participantCode.instructions"
              optional
              multiline
              value={code.instructions ?? ""}
              readOnly={readOnly}
              info="Where the code comes from, and what to do without one."
              infoLabel="the instructions"
              issues={issuesAt(issues, "participantCode.instructions")}
              onCommit={(text) => write("Edit the start screen", { participantCode: { instructions: text.trim() ? text : null } })}
              emptyText="No instructions"
            />
            <div className="stn-pair">
              <TextField
                label="Placeholder"
                field="participantCode.placeholder"
                optional
                value={code.placeholder ?? ""}
                readOnly={readOnly}
                info="Shown greyed out in the empty box until something is typed, e.g. NDC0042."
                infoLabel="the placeholder"
                issues={issuesAt(issues, "participantCode.placeholder")}
                onCommit={(text) => write("Edit the start screen", { participantCode: { placeholder: text.trim() ? text : null } })}
                emptyText="None"
              />
              <TextField
                label="Format hint"
                field="participantCode.hint"
                value={code.hint}
                readOnly={readOnly}
                info="Shown when a code doesn't match the format, so a mistyped code can be put right."
                infoLabel="the format hint"
                issues={issuesAt(issues, "participantCode.hint")}
                onCommit={(text) => write("Edit the start screen", { participantCode: { hint: text } })}
                emptyText="No hint"
              />
            </div>
            <div className="stn-pair">
              <TextField
                label="Format"
                field="participantCode.pattern"
                value={code.pattern}
                mono
                spellCheck={false}
                readOnly={readOnly}
                validate={validatePattern}
                info="A regular expression every code must match."
                infoLabel="the format"
                hint={<PatternExplanation pattern={code.pattern} />}
                issues={issuesAt(issues, "participantCode.pattern")}
                onCommit={(pattern) => write("Edit the start screen format", { participantCode: { pattern } })}
              />
              <PatternTester pattern={code.pattern} label="Test a code" />
            </div>
            {code.variable ? (
              <ReadOnlyValue
                label="Stored as"
                field="participantCode.variable"
                mono
                inline
                reason="The code's column in the data. Earlier sittings are stored under it, so it stays as it is."
              >
                {code.variable}
              </ReadOnlyValue>
            ) : null}
            <IssueMessages issues={issuesAt(issues, "participantCode.variable")} />
          </>
        ) : (
          <>
            <IssueMessages issues={issues.byField.get("participantCode")} />
            <div className="stn-actionrow">
              <p className="stn-flush stn-muted">Not asked for yet.</p>
              <Button size="sm" variant="secondary" icon="plus" disabled={readOnly} onClick={() => write("Set up the participant code", { participantCode: DEFAULT_CODE })}>
                Ask for a participant code
              </Button>
            </div>
          </>
        )}
      </Panel>

      <ContactPanel />
    </div>
  );
}

/** A plain-English reading of a pattern, with a warning when it isn't anchored. */
export function PatternExplanation({ pattern }: { pattern: string }) {
  const explained = explainPattern(pattern);
  return (
    <>
      {explained ?? "A custom format. Test some answers below to check it does what you expect."}
      {pattern && !patternError(pattern) && !isAnchored(pattern) ? (
        <>
          {" "}
          <strong>Without ^ at the start and $ at the end, the rule only has to appear somewhere in what is typed.</strong>
        </>
      ) : null}
    </>
  );
}

/** Try an answer against a pattern, checked exactly as the participant app checks it. */
export function PatternTester({ pattern, label }: { pattern: string; label: string }) {
  const id = useId();
  const [sample, setSample] = useState("");
  const result = testPattern(pattern, sample);
  return (
    <div className="stn-field stn-tester">
      <label className="stn-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="st-input stn-mono"
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        placeholder="Type an example to try it"
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-result`}
      />
      <p id={`${id}-result`} className={`stn-tester-result stn-tester-${result.status}`} aria-live="polite">
        {result.status === "empty" ? (
          "Only for trying the format; nothing is saved."
        ) : (
          <>
            <Icon name={result.status === "match" ? "check" : result.status === "invalid" ? "error" : "close"} size={15} />
            <span>
              {result.status === "match" ? "Accepted: " : result.status === "no-match" ? "Refused: " : "Can't test: "}
              {result.message}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function ContactPanel() {
  const ctx = useEditor();
  const contact = ctx.draft.composition.contact;
  const issues = useMemo(() => screenIssues(ctx.issues, "welcome"), [ctx.issues]);
  const [open, setOpen] = useState(false);
  const readOnly = !ctx.canEdit;
  const validateEmail = useCallback(
    (text: string) => (!text.trim() ? "A contact needs an email address." : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim()) ? null : "Enter an email address, like name@example.ac.uk."),
    [],
  );
  const write = (patch: WelcomePatch) => ctx.run("Edit the contact details", (d) => unlessUnchanged(d, updateWelcome(d, patch).draft, welcomePart));

  return (
    <Panel
      title="Contact"
      info="Shown quietly on the first screen, so a participant or a parent knows who to ask."
      field="contact"
      actions={
        contact && !readOnly ? (
          <Button size="sm" variant="ghost" icon="trash" onClick={() => write({ contact: null })}>
            Remove contact details
          </Button>
        ) : null
      }
    >
      {contact || open ? (
        <>
          <div className="stn-pair">
            <TextField
              label="Email"
              field="contact.email"
              value={contact?.email ?? ""}
              readOnly={readOnly}
              validate={validateEmail}
              issues={issuesAt(issues, "contact.email")}
              onCommit={(email) => write({ contact: { email: email.trim() } })}
            />
            <TextField
              label="Ethics reference"
              field="contact.ethicsReference"
              optional
              value={contact?.ethicsReference ?? ""}
              readOnly={readOnly || !contact}
              lockedReason={!contact ? "Add an email address first." : null}
              issues={issuesAt(issues, "contact.ethicsReference")}
              onCommit={(text) => write({ contact: { ethicsReference: text.trim() ? text : null } })}
              emptyText="None"
            />
          </div>
          <TextField
            label="Note"
            field="contact.note"
            optional
            multiline
            value={contact?.note ?? ""}
            readOnly={readOnly || !contact}
            lockedReason={!contact ? "Add an email address first." : null}
            issues={issuesAt(issues, "contact.note")}
            onCommit={(text) => write({ contact: { note: text.trim() ? text : null } })}
            emptyText="None"
          />
        </>
      ) : (
        <div className="stn-actionrow">
          <p className="stn-flush stn-muted">No contact details.</p>
          <Button size="sm" variant="secondary" icon="plus" disabled={readOnly} onClick={() => setOpen(true)}>
            Add contact details
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** The first screen as a participant sees it, drawn small. */
function WelcomePreview() {
  const { draft } = useEditor();
  const c = draft.composition;
  const code = c.participantCode;
  return (
    <figure className="stn-miniscreen" aria-label="How the start screen looks">
      <div className="stn-miniscreen-body">
        {c.studyLabel ? <p className="stn-mini-label">{c.studyLabel}</p> : null}
        {code ? (
          <>
            {code.instructions ? <p className="stn-mini-text">{code.instructions}</p> : null}
            <p className="stn-mini-field">{code.label || "Your participant code"}</p>
            <p className="stn-mini-input">{code.placeholder ?? "NDC0000"}</p>
          </>
        ) : (
          <p className="stn-mini-text">No participant code is asked for.</p>
        )}
        {c.contact ? (
          <p className="stn-mini-contact">
            {c.contact.email}
            {c.contact.ethicsReference ? ` · Ethics ${c.contact.ethicsReference}` : ""}
          </p>
        ) : null}
      </div>
      <figcaption className="stn-hint">Sketch · open Preview to see it exactly</figcaption>
    </figure>
  );
}
