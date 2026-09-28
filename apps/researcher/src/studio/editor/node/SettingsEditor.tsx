import { useCallback, useMemo } from "react";
import { updateSettings } from "@myself/studio";
import { Switch } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Facts, IssueMessages, Panel, TextField } from "./controls.js";
import { issuesAt, screenIssues } from "./issues.js";

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
      <header className="stn-node-head">
        <p className="stn-crumbs">Survey settings</p>
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          Survey settings
        </h2>
      </header>
      <IssueMessages issues={issues.general} />
      <Panel title="Name">
        <TextField
          label="Survey title"
          field="title"
          value={c.title}
          readOnly={readOnly}
          lockedReason={ctx.readOnlyReason}
          validate={validateTitle}
          hint="What researchers know it by, in the survey list, versions and exports. Participants don't see it — they see the study label on the start screen."
          issues={issuesAt(issues, "title")}
          onCommit={(title) => ctx.run("Rename the survey", (d) => updateSettings(d, { title }).draft)}
        />
      </Panel>
      <Panel title="Moving through the survey">
        <div data-field="allowBackNavigation">
          <Switch
            label="Participants can go back to earlier questions"
            checked={c.allowBackNavigation !== false}
            disabled={readOnly}
            onChange={(allowBackNavigation) => {
              if (ctx.run("Change whether participants can go back", (d) => updateSettings(d, { allowBackNavigation }).draft)) {
                ctx.announce(allowBackNavigation ? "Participants can go back." : "Participants can't go back.");
              }
            }}
            hint="When off, there is no Back button: each answer is final once the participant moves on. They can still change answers from the review screen at the end, if the survey has one."
          />
        </div>
      </Panel>
      <Panel title="About this survey" description="Set when the survey was created. Changing any of these would make it a different survey.">
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
