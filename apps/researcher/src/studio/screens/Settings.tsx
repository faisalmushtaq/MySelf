import type { DraftEditor, SurveyDoc } from "../data/index.js";
import { formatDateTime, plural, toDate, versionLabel } from "../format.js";
import { Link } from "../router.js";
import { PageHead } from "../shell/Shell.js";
import { AccessPanel } from "./Access.js";

/** The facts about a survey, and who has access to the Studio. */
export function SettingsScreen({ surveyId, survey, editor }: { surveyId: string; survey: SurveyDoc | null; editor: DraftEditor }) {
  const active = survey?.active ?? null;
  return (
    <div className="stp-page">
      <PageHead title="Settings" />
      <div className="stp-stack">
        <section className="stp-card" aria-labelledby="settings-facts">
          <h2 id="settings-facts" className="stp-h2">
            About this survey
          </h2>
          <dl className="stp-facts stp-facts-wide">
            <div>
              <dt>Survey ID</dt>
              <dd>
                <code>{surveyId}</code>
              </dd>
            </div>
            <div>
              <dt>Title</dt>
              <dd>{survey?.title ?? "—"}</dd>
            </div>
            <div>
              <dt>Live version</dt>
              <dd>
                {active ? (
                  <>
                    {versionLabel(active.version)}, published {formatDateTime(toDate(active.publishedAt))}
                    {active.publishedByEmail ? ` by ${active.publishedByEmail}` : ""}
                  </>
                ) : (
                  "Nothing published yet"
                )}
              </dd>
            </div>
            <div>
              <dt>Versions published</dt>
              <dd>
                {survey ? plural(survey.versionCount, "version") : "—"}
                {survey?.latestVersion && survey.latestVersion !== active?.version ? ` (latest ${versionLabel(survey.latestVersion)})` : ""}
                {" · "}
                <Link to={{ name: "survey", surveyId, tab: "versions", q: null }}>See versions</Link>
              </dd>
            </div>
            <div>
              <dt>Draft</dt>
              <dd>
                {editor.status === "ready"
                  ? `Saved revision ${editor.revision}${editor.basedOn ? `, started from ${versionLabel(editor.basedOn.version)}` : ""}`
                  : editor.status === "loading"
                    ? "Loading…"
                    : (editor.error ?? "Not available")}
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{survey ? formatDateTime(toDate(survey.createdAt)) : "—"}</dd>
            </div>
          </dl>
        </section>
        <div>
          <h2 className="stp-h2 stp-section-title">Who has access</h2>
          <p className="stp-muted stp-section-lede">The Studio list is shared by every survey in the study.</p>
          <AccessPanel />
        </div>
      </div>
    </div>
  );
}
