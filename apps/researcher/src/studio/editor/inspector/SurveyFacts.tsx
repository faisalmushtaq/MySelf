import { useMemo, type ReactNode } from "react";
import { liveQuestions, summariseIssues, type ArchivedQuestion } from "@myself/studio";
import { formatDateTime, toDate, versionLabel } from "../../format.js";
import { Badge, Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Facts } from "../node/controls.js";
import { ageBandLabel, READING_LEVELS } from "../node/SettingsEditor.js";

/**
 * The survey at a glance, for the settings panel when no question is chosen:
 * what it is, what is live, and how the draft stands.
 */
export function SurveyFacts({ tip }: { tip?: ReactNode }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const c = draft.composition;
  const questions = useMemo(() => new Set(liveQuestions(draft).map((q) => q.itemKey)), [draft]);
  // Not counted until what has been published is known: every question would count as new.
  const newQuestions = ctx.publishedStatus === "ready" ? [...questions].filter((k) => !ctx.publishedItemKeys.has(k)).length : 0;
  const { errors, warnings } = summariseIssues(ctx.issues);
  const active = ctx.published?.active ?? null;
  const unlocked = Object.keys(draft.unlocked);

  return (
    <div className="sti">
      <header className="sti-head">
        <p className="sti-eyebrow">Survey</p>
      </header>
      {tip ? <div className="sti-tip">{tip}</div> : null}
      <section className="sti-group" aria-label="About this survey">
        <Facts
          rows={[
            { label: "Survey ID", value: <code>{draft.surveyId}</code> },
            { label: "Language", value: c.language },
            { label: "Reading level", value: READING_LEVELS[c.readingLevel] ?? c.readingLevel },
            { label: "Age band", value: ageBandLabel(c.ageBand) },
            {
              label: "Live version",
              value: active
                ? `${versionLabel(active.version)}, published ${formatDateTime(toDate(active.publishedAt))}`
                : ctx.publishedStatus === "loading"
                  ? "Loading…"
                  : "Not published yet",
            },
            ...(ctx.editor.basedOn ? [{ label: "Draft started from", value: versionLabel(ctx.editor.basedOn.version) }] : []),
            { label: "Questions", value: `${questions.size}${newQuestions > 0 ? ` (${newQuestions} not yet published)` : ""}` },
            { label: "Archived", value: String(draft.archived.length) },
          ]}
        />
      </section>
      <section className="sti-group" aria-labelledby="sti-facts-checks">
        <h3 className="sti-title" id="sti-facts-checks">
          Checks
        </h3>
        <p className="sti-status">
          {errors > 0 ? (
            <Badge tone="error" icon="error">
              {errors} to fix before publishing
            </Badge>
          ) : (
            <Badge tone="accent" icon="check">
              Nothing stops publishing
            </Badge>
          )}{" "}
          {warnings > 0 ? (
            <Badge tone="warn" icon="warning">
              {warnings} to check
            </Badge>
          ) : null}
        </p>
        {errors + warnings > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => ctx.setValidationOpen(true)}>
            See the list
          </Button>
        ) : null}
        {!ctx.issuesFresh ? <p className="sti-note">Checking your latest change…</p> : null}
      </section>
      {unlocked.length > 0 ? (
        <section className="sti-group" aria-labelledby="sti-facts-unlocked">
          <h3 className="sti-title" id="sti-facts-unlocked">
            Unlocked for editing
          </h3>
          <ul className="sti-links">
            {unlocked.map((k) => (
              <li key={k}>
                <code>{k}</code> — {draft.unlocked[k]?.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** An archived question's facts, beside the restore controls in the centre. */
export function ArchivedFacts({ record }: { record: ArchivedQuestion }) {
  const ctx = useEditor();
  const at = new Date(record.archivedAt);
  return (
    <div className="sti">
      <header className="sti-head">
        <p className="sti-eyebrow">Archived question</p>
        <p className="sti-id">
          <code>{record.itemKey}</code>
        </p>
      </header>
      <section className="sti-group" aria-label="About this archived question">
        <Facts
          rows={[
            { label: "Question ID", value: <code>{record.itemKey}</code> },
            { label: "Reporting label", value: <code>{record.item.variable}</code> },
            { label: "Archived", value: `${formatDateTime(Number.isNaN(at.getTime()) ? null : at)} by ${record.archivedBy}` },
            {
              label: "Published",
              value: ctx.publishedItemKeys.has(record.itemKey)
                ? "Yes — its ID and label stay reserved for good"
                : // REVIEW FIX: not "No" while what has been published is still unknown.
                  ctx.publishedStatus !== "ready"
                  ? "Checking…"
                  : "No — it can be deleted",
            },
          ]}
        />
      </section>
    </div>
  );
}
