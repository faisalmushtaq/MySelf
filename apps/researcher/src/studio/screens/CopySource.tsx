import { useMemo } from "react";
import { useVersions, type SurveyDoc } from "../data/index.js";
import { useLibraryCatalogue } from "../data/library.js";
import { orderCatalogue, type CatalogueStudy } from "../editor/library/model.js";
import { formatDate, toDate, versionLabel } from "../format.js";
import { useStudy } from "../router.js";
import { LoadError } from "../shell/common.js";
import { Field, Notice, Skeleton } from "../ui/kit.js";

/**
 * "Copy a published version" for a new survey (docs/16 §12.7): any survey's
 * published version, in any study space, this one first. A copy from another
 * study carries that study's consent and identity modules, unchanged and still
 * protected, and the dialog says so before anything is made.
 */

export interface CopyChoice {
  study: string;
  surveyId: string;
  version: string;
}

const key = (study: string, surveyId: string) => `${study}/${surveyId}`;

/** Whether there is anything to copy: from the catalogue once it is known, else this study's own surveys. */
export function useAnythingToCopy(existing: readonly SurveyDoc[]): boolean {
  const cat = useLibraryCatalogue();
  const here = useStudy();
  if (cat.status === "ready") return orderCatalogue(cat.data, here).length > 0;
  return cat.status === "loading" || existing.some((s) => s.versionCount > 0);
}

export function CopySource({
  existing,
  value,
  onChange,
  error,
}: {
  existing: readonly SurveyDoc[];
  value: CopyChoice | null;
  onChange: (choice: CopyChoice | null) => void;
  error: string | null;
}) {
  const here = useStudy();
  const cat = useLibraryCatalogue();
  const studies = useMemo(() => (cat.status === "ready" ? orderCatalogue(cat.data, here) : []), [cat, here]);

  if (cat.status === "loading") return <Skeleton lines={2} label="Loading the published surveys" />;
  if (cat.status === "error") {
    // The other study spaces couldn't be listed: this one's own surveys still can be.
    return (
      <>
        <LoadError error={`Other study spaces’ surveys couldn’t be listed. ${cat.error}`} retry={cat.retry} />
        <ThisStudyOnly existing={existing} value={value} onChange={onChange} error={error} />
      </>
    );
  }
  const chosenStudy = value ? studies.find((s) => s.study === value.study) : undefined;
  const chosenSurvey = chosenStudy?.surveys.find((v) => v.surveyId === value?.surveyId);
  return (
    <>
      <Field label="Survey">
        {(p) => (
          <select
            {...p}
            className="st-select"
            value={value ? key(value.study, value.surveyId) : ""}
            onChange={(e) => {
              const [study, surveyId] = splitKey(e.target.value);
              const survey = studies.find((s) => s.study === study)?.surveys.find((v) => v.surveyId === surveyId);
              onChange(survey ? { study, surveyId, version: survey.versions[0]?.version ?? "" } : null);
            }}
          >
            <option value="">Choose a survey…</option>
            {studies.map((s) => (
              <optgroup key={s.study} label={groupLabel(s)}>
                {s.surveys.map((v) => (
                  <option key={v.surveyId} value={key(s.study, v.surveyId)}>
                    {v.title} ({v.surveyId})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </Field>
      {chosenSurvey && value ? (
        <Field label="Version" error={error}>
          {(p) => (
            <select {...p} className="st-select" value={value.version} onChange={(e) => onChange({ ...value, version: e.target.value })}>
              {chosenSurvey.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {versionLabel(v.version)}
                  {v.version === chosenSurvey.live ? " · live" : ""} — published {formatDate(toDate(v.publishedAt))}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : error ? (
        <p className="st-field-msg st-field-msg-error">{error}</p>
      ) : null}
      {chosenStudy && !chosenStudy.here ? (
        <Notice tone="warn" title={`From another study space, “${chosenStudy.title}”`}>
          The copy keeps that study&rsquo;s consent wording as it is — check it is right for this study and change it before
          publishing — and its identity module still protected (unlock it, with the reason recorded, to change it).
        </Notice>
      ) : null}
    </>
  );
}

function groupLabel(s: CatalogueStudy): string {
  return s.here ? `This study space — ${s.title}` : `${s.title}${s.status === "closed" ? " (closed)" : ""}`;
}

function splitKey(value: string): [string, string] {
  const at = value.indexOf("/");
  return at < 0 ? ["", ""] : [value.slice(0, at), value.slice(at + 1)];
}

/** This study's own published surveys, as before the library — when the catalogue can't be had. */
function ThisStudyOnly({
  existing,
  value,
  onChange,
  error,
}: {
  existing: readonly SurveyDoc[];
  value: CopyChoice | null;
  onChange: (choice: CopyChoice | null) => void;
  error: string | null;
}) {
  const here = useStudy();
  const published = existing.filter((s) => s.versionCount > 0);
  if (published.length === 0) return <p className="stp-muted">No survey in this study space has published a version yet.</p>;
  return (
    <>
      <Field label="Survey">
        {(p) => (
          <select
            {...p}
            className="st-select"
            value={value?.study === here ? value.surveyId : ""}
            onChange={(e) => onChange(e.target.value ? { study: here, surveyId: e.target.value, version: "" } : null)}
          >
            <option value="">Choose a survey…</option>
            {published.map((s) => (
              <option key={s.surveyId} value={s.surveyId}>
                {s.title}
              </option>
            ))}
          </select>
        )}
      </Field>
      {value?.study === here && value.surveyId ? (
        <VersionSelect surveyId={value.surveyId} value={value.version} onChange={(version) => onChange({ ...value, version })} error={error} />
      ) : null}
    </>
  );
}

function VersionSelect({ surveyId, value, onChange, error }: { surveyId: string; value: string; onChange: (v: string) => void; error: string | null }) {
  const versions = useVersions(surveyId);
  if (versions.status === "loading") return <Skeleton lines={1} label="Loading versions" />;
  if (versions.status === "error") return <LoadError error={versions.error} retry={versions.retry} />;
  return (
    <Field label="Version" error={error}>
      {(p) => (
        <select {...p} className="st-select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a version…</option>
          {versions.data.map((v) => (
            <option key={v.version} value={v.version}>
              {versionLabel(v.version)} — published {formatDate(toDate(v.publishedAt))}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
