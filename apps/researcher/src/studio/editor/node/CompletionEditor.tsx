import { useCallback, useMemo } from "react";
import { updateScreen } from "@myself/studio";
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { IssueMessages, Panel, TextField } from "./controls.js";
import { issuesAt, screenIssues } from "./issues.js";
import { PipeList } from "./QuestionEditor.js";
import { unlessUnchanged } from "./unchanged.js";

/**
 * The end of the survey: the finish screen every participant sees, and the
 * review screen it offers ("Need to change anything? Go back to my answers").
 *
 * Pipes in the text — {first_name} — are kept exactly as they are and listed
 * underneath in words; one whose insertion has gone is flagged by validation,
 * because a participant would otherwise see the braces.
 */

type Which = "finish" | "review";

const REVIEW_DEFAULT = {
  title: "Change an answer",
  body: "Here's everything you told us. Tap anything that isn't right and you can change it.",
};

function ScreenFields({ which }: { which: Which }) {
  const ctx = useEditor();
  const screen = ctx.draft.composition.screens[which];
  const issues = useMemo(() => screenIssues(ctx.issues, "completion"), [ctx.issues]);
  const readOnly = !ctx.canEdit;
  const titlePipes = !!screen?.title?.pipes && Object.keys(screen.title.pipes).length > 0;
  const validateTitle = useCallback(
    (text: string) =>
      titlePipes && !text.trim()
        ? "This heading inserts an earlier answer, so emptying it would lose that. Type the new heading, or use “Remove heading”."
        : null,
    [titlePipes],
  );
  const noun = which === "finish" ? "finish screen" : "review screen";
  if (!screen) return null;
  return (
    <>
      <TextField
        label="Heading"
        field={`screens.${which}.title`}
        optional
        value={screen.title?.text ?? ""}
        inputClassName="stn-screentitle"
        readOnly={readOnly}
        validate={validateTitle}
        issues={issuesAt(issues, `screens.${which}.title`)}
        onCommit={(text) =>
          // No undo step for spaces typed into an empty heading (unchanged.ts).
          ctx.run(`Edit the ${noun}`, (d) => unlessUnchanged(d, updateScreen(d, which, { title: text.trim() ? text : null }).draft, (x) => x.composition.screens[which]))
        }
        after={
          <>
            <PipeList display={screen.title} />
            {screen.title && titlePipes && !readOnly ? (
              <Button size="sm" variant="ghost" onClick={() => ctx.run(`Remove the ${noun} heading`, (d) => updateScreen(d, which, { title: null }).draft)}>
                Remove heading
              </Button>
            ) : null}
          </>
        }
        emptyText="No heading"
      />
      <TextField
        label="Message"
        field={`screens.${which}.body`}
        value={screen.body.text}
        multiline
        readOnly={readOnly}
        issues={issuesAt(issues, `screens.${which}.body`)}
        onCommit={(text) => ctx.run(`Edit the ${noun}`, (d) => updateScreen(d, which, { body: text }).draft)}
        after={<PipeList display={screen.body} />}
        emptyText="No message"
      />
    </>
  );
}

export function CompletionEditor() {
  const ctx = useEditor();
  const screens = ctx.draft.composition.screens;
  const issues = useMemo(() => screenIssues(ctx.issues, "completion"), [ctx.issues]);
  const readOnly = !ctx.canEdit;
  return (
    <div className="stn-node">
      <header className="stn-node-head">
        <p className="stn-crumbs">Completion</p>
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          Completion screens
        </h2>
        <p className="stn-lead">What participants see when they have answered everything.</p>
      </header>
      <IssueMessages issues={issues.general} />

      <Panel title="Finish screen" field="screens.finish" description="Shown to every participant at the end. Their answers are saved by then.">
        {screens["finish"] ? (
          <article className="stn-card stn-card-screen">
            <ScreenFields which="finish" />
          </article>
        ) : (
          <>
            <IssueMessages issues={issuesAt(issues, "screens.finish")} />
            <Button
              icon="plus"
              disabled={readOnly}
              onClick={() => ctx.run("Add a finish screen", (d) => updateScreen(d, "finish", { title: "Thank you", body: "That's everything — thank you for taking part." }).draft)}
            >
              Add a finish screen
            </Button>
          </>
        )}
      </Panel>

      <Panel
        title="Review screen"
        field="screens.review"
        description={
          <>
            Offered from the finish screen as “Need to change anything? Go back to my answers”. It lists every answer so a participant who
            knows they got something wrong can tap it, change it and come back to the end — the change is recorded as a correction, not a
            first answer. Without a review screen, the offer isn't shown.
          </>
        }
      >
        {screens["review"] ? (
          <article className="stn-card stn-card-screen">
            <ScreenFields which="review" />
          </article>
        ) : (
          <Button
            icon="plus"
            disabled={readOnly}
            onClick={() => ctx.run("Add a review screen", (d) => updateScreen(d, "review", REVIEW_DEFAULT).draft)}
          >
            Add a review screen
          </Button>
        )}
      </Panel>
      <p className="stn-hint">
        Text in braces, like <code>{"{first_name}"}</code>, is replaced by an earlier answer. The Studio keeps existing insertions as they are;
        a new one typed here isn't set up to insert anything, and validation will say so.
      </p>
    </div>
  );
}
