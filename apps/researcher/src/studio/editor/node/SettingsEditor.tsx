import { useCallback, useMemo } from "react";
import { updateSettings } from "@myself/studio";
import { useEditor } from "../context.js";
import { Facts, IssueMessages, Panel, SwitchRow, TextField } from "./controls.js";
import { issuesAt, screenIssues } from "./issues.js";
import { unlessUnchanged } from "./unchanged.js";

/** Plain names for the composition's reading levels and age bands. */
export const READING_LEVELS: Record<string, string> = {
  standard: "Standard",
  simplified: "Simplified",
  early_reader: "Early reader",
};

export function ageBandLabel(band: string): string {
  return band === "adult" ? "Adults" : `${band.replace("-", " to ")} year olds`;
}

/**
 * Survey-wide settings: the title researchers know it by, and whether
 * participants can go back. The survey's ID, language, reading level and age
 * band are facts about what was built rather than settings: every block names
 * its language, so changing it would make a different survey.
 */
export function SettingsEditor() {
  const ctx = useEditor();
  const c = ctx.draft.composition;
  const issues = useMemo(() => screenIssues(ctx.issues, "survey"), [ctx.issues]);
  const validateTitle = useCallback((text: string) => (text.trim() ? null : "The survey needs a title."), []);
  const readOnly = !ctx.canEdit;
  return (
    <div className="stn-node">
      <header className="stn-pagehead">
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          Survey settings
        </h2>
      </header>
      <IssueMessages issues={issues.general} />
      <Panel title="General">
        <TextField
          label="Survey title"
          field="title"
          value={c.title}
          readOnly={readOnly}
          lockedReason={ctx.readOnlyReason}
          validate={validateTitle}
          info="What researchers know it by, in the survey list, versions and exports. Participants don't see it — they see the study label on the start screen."
          issues={issuesAt(issues, "title")}
          onCommit={(title) =>
            // Stored trimmed: no undo step for a space at the end (unchanged.ts).
            ctx.run("Rename the survey", (d) => unlessUnchanged(d, updateSettings(d, { title }).draft, (x) => x.composition.title))
          }
        />
        <SwitchRow
          label="Participants can go back"
          field="allowBackNavigation"
          checked={c.allowBackNavigation !== false}
          disabled={readOnly}
          onChange={(allowBackNavigation) => {
            if (ctx.run("Change whether participants can go back", (d) => updateSettings(d, { allowBackNavigation }).draft)) {
              ctx.announce(allowBackNavigation ? "Participants can go back." : "Participants can't go back.");
            }
          }}
          info="When off, there is no Back button: each answer is final once the participant moves on. They can still change answers from the review screen at the end, if the survey has one."
        />
      </Panel>
      <Panel
        title="Pacing"
        info="Help for participants who are taking a long time. Researchers can also end a sitting that has run out of time: five taps on the progress bar, then the staff PIN."
      >
        <SwitchRow
          label="Reassure someone stuck on a question"
          field="effort.stuckPrompt"
          checked={c.effort?.stuckPrompt !== false}
          disabled={readOnly}
          onChange={(stuckPrompt) => {
            if (ctx.run("Change whether stuck participants are reassured", (d) => updateSettings(d, { effort: { stuckPrompt } }).draft)) {
              ctx.announce(stuckPrompt ? "Stuck participants are reassured." : "No reassurance for stuck participants.");
            }
          }}
          info="After someone has sat on an unanswered question, without touching the screen, for several times as long as it takes to read (20 to 90 seconds), a note says: “Take your time. If you're not sure, choose the answer that fits best.” Once per question; never on text, consent or information screens."
        />
        <SwitchRow
          label="…and offer to skip it"
          field="effort.stuckPromptOffersSkip"
          checked={c.effort?.stuckPrompt !== false && c.effort?.stuckPromptOffersSkip !== false}
          disabled={readOnly || c.effort?.stuckPrompt === false}
          onChange={(stuckPromptOffersSkip) => {
            if (ctx.run("Change whether stuck participants can skip", (d) => updateSettings(d, { effort: { stuckPromptOffersSkip } }).draft)) {
              ctx.announce(stuckPromptOffersSkip ? "Stuck participants are offered a skip." : "Stuck participants are not offered a skip.");
            }
          }}
          info="Adds a “Skip this one” button to the note. Never on a question that must be answered."
        />
      </Panel>
      <Panel title="About this survey" info="Set when the survey was created. Changing any of these would make it a different survey.">
        <Facts
          rows={[
            { label: "Survey ID", value: <code>{ctx.draft.surveyId}</code> },
            { label: "Study", value: <code>{c.study}</code> },
            { label: "Language", value: c.language },
            { label: "Reading level", value: READING_LEVELS[c.readingLevel] ?? c.readingLevel },
            { label: "Age band", value: ageBandLabel(c.ageBand) },
          ]}
        />
      </Panel>
    </div>
  );
}
