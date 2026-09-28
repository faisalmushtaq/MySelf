import { useCallback, useId, useMemo, useState } from "react";
import { updateWelcome, type WelcomePatch } from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { IssueMessages, Panel, ReadOnlyValue, TextField } from "./controls.js";
import { issuesAt, screenIssues } from "./issues.js";
import { explainPattern, isAnchored, patternError, testPattern } from "./pattern.js";

/**
 * The start screen: the first thing a participant sees, before any question.
 * It asks for the code the research team gave them, says what the study is,
 * and says who to contact.
 */

const DEFAULT_CODE = {
  pattern: "^[A-Za-z0-9]{3,16}$",
  hint: "Letters and numbers, between 3 and 16 characters",
};

export function WelcomeEditor() {
  const ctx = useEditor();
  const { draft } = ctx;
  const c = draft.composition;
  const code = c.participantCode;
  const issues = useMemo(() => screenIssues(ctx.issues, "welcome"), [ctx.issues]);
  const readOnly = !ctx.canEdit;
  const write = useCallback(
    (label: string, patch: WelcomePatch) => ctx.run(label, (d) => updateWelcome(d, patch).draft),
    [ctx],
  );
  const validatePattern = useCallback((text: string) => (text.trim() ? patternError(text) : "The code needs a format, or any text at all would be accepted."), []);

  return (
    <div className="stn-node">
      <header className="stn-node-head">
        <p className="stn-crumbs">Start screen</p>
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          Start screen
        </h2>
        <p className="stn-lead">
          These appear on the first screen, before any question: a participant types the code the research team gave them to begin.
        </p>
      </header>

      <WelcomePreview />
      <IssueMessages issues={issues.general} />

      <Panel title="Participant code" field="participantCode">
        {code ? (
          <>
            <TextField
              label="Label"
              field="participantCode.label"
              value={code.label ?? ""}
              placeholder="Your participant code"
              readOnly={readOnly}
              hint="The box's label. Left empty, it reads “Your participant code”."
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
              hint="Where the code comes from, and what to do without one."
              issues={issuesAt(issues, "participantCode.instructions")}
              onCommit={(text) => write("Edit the start screen", { participantCode: { instructions: text.trim() ? text : null } })}
              emptyText="No instructions"
            />
            <TextField
              label="Example in the empty box"
              field="participantCode.placeholder"
              optional
              value={code.placeholder ?? ""}
              readOnly={readOnly}
              hint="Shown greyed out in the box until something is typed, e.g. NDC0042."
              issues={issuesAt(issues, "participantCode.placeholder")}
              onCommit={(text) => write("Edit the start screen", { participantCode: { placeholder: text.trim() ? text : null } })}
              emptyText="None"
            />
            <TextField
              label="Format hint"
              field="participantCode.hint"
              value={code.hint}
              readOnly={readOnly}
              hint="Shown when a code doesn't match the format, so a mistyped code can be put right."
              issues={issuesAt(issues, "participantCode.hint")}
              onCommit={(text) => write("Edit the start screen", { participantCode: { hint: text } })}
              emptyText="No hint"
            />
            <TextField
              label="Format (pattern)"
              field="participantCode.pattern"
              value={code.pattern}
              mono
              spellCheck={false}
              readOnly={readOnly}
              validate={validatePattern}
              hint={<PatternExplanation pattern={code.pattern} />}
              issues={issuesAt(issues, "participantCode.pattern")}
              onCommit={(pattern) => write("Edit the start screen format", { participantCode: { pattern } })}
            />
            <PatternTester pattern={code.pattern} label="Test a code" />
            {code.variable ? (
              <ReadOnlyValue
                label="Stored in the data as"
                field="participantCode.variable"
                mono
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
            <p className="stn-flush">This survey doesn't ask for a participant code yet.</p>
            <div className="stn-row-actions">
              <Button icon="plus" disabled={readOnly} onClick={() => write("Set up the participant code", { participantCode: DEFAULT_CODE })}>
                Ask for a participant code
              </Button>
            </div>
          </>
        )}
      </Panel>

      <Panel title="About the study">
        <TextField
          label="Study label"
          field="studyLabel"
          optional
          value={c.studyLabel ?? ""}
          readOnly={readOnly}
          hint="A short label shown above the code box, e.g. “Notre Dame · 2026”. The survey's full title isn't shown to participants."
          issues={issuesAt(issues, "studyLabel")}
          onCommit={(text) => write("Edit the study label", { studyLabel: text.trim() ? text : null })}
          emptyText="None"
        />
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
      <p id={`${id}-result`} className={`stn-tester-result ${result.status}`} aria-live="polite">
        {result.status === "empty" ? (
          "Nothing is saved from this box — it is only for trying the format."
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
  const write = (patch: WelcomePatch) => ctx.run("Edit the contact details", (d) => updateWelcome(d, patch).draft);

  return (
    <Panel
      title="Contact"
      description="Shown quietly on the first screen, so a participant or a parent knows who to ask."
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
        <div className="stn-row-actions">
          <Button icon="plus" disabled={readOnly} onClick={() => setOpen(true)}>
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
      <figcaption className="stn-hint">A sketch of the start screen. Use Preview to see it exactly.</figcaption>
    </figure>
  );
}
