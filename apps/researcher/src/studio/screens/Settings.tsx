import type { DraftEditor, SurveyDoc } from "../data/index.js";
import { formatDateTime, plural, toDate, versionLabel } from "../format.js";
import { Link } from "../router.js";
import { PageHead } from "../shell/Shell.js";
import { StatusDot } from "../ui/kit.js";
import { AccessPanel } from "./Access.js";

/** The facts about a survey, and who has access to the Studio. */
export function SettingsScreen({ surveyId, survey, editor }: { surveyId: string; survey: SurveyDoc | null; editor: DraftEditor }) {
  const active = survey?.active ?? null;
  return (
    <div className="stp-page">
      <PageHead title="Settings" />
      <section className="stp-section" aria-labelledby="settings-facts">
        <div className="stp-section-head">
          <h2 id="settings-facts" className="stp-h2">
            About this survey
          </h2>
        </div>
        <dl className="stp-kv">
          <div>
            <dt>Title</dt>
            <dd>{survey?.title ?? "—"}</dd>
          </div>
          <div>
            <dt>Survey ID</dt>
            <dd>
              <span className="stp-id">{surveyId}</span>
            </dd>
          </div>
          <div>
            <dt>Live version</dt>
            <dd>
              {active ? (
                <>
                  <span className="stp-dotted">
                    <StatusDot tone="accent" />
                    <span className="stp-version-label">{versionLabel(active.version)}</span>
                  </span>
                  <span className="stp-muted">
                    {" "}
                    · published {formatDateTime(toDate(active.publishedAt))}
                    {active.publishedByEmail ? ` by ${active.publishedByEmail}` : ""}
                  </span>
                </>
              ) : (
                <span className="stp-muted">Nothing published yet</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Versions</dt>
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
      <section className="stp-section" aria-labelledby="settings-access">
        <div className="stp-section-head">
          <div>
            <h2 id="settings-access" className="stp-h2">
              Who has access
            </h2>
            <p>Shared by every survey in the study.</p>
          </div>
        </div>
        <AccessPanel nested />
      </section>
    </div>
  );
}
