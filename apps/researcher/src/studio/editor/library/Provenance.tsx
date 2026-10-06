import { useId, useMemo } from "react";
import { provenanceOf, type FragmentOrigin, type ImportRecord } from "@myself/studio";
import { useLibraryCatalogue } from "../../data/library.js";
import { formatDateTime } from "../../format.js";
import { useStudy } from "../../router.js";
import { InfoTip } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Facts } from "../node/controls.js";
import { useLibraryUi } from "./LibraryContext.js";
import { originWords, type OriginNames } from "./model.js";
import { validatedEntries } from "./Shelves.js";

/**
 * Where a copied question came from (docs/16 §12.5), for the settings panel:
 * the survey, version and study it was copied from, the validated
 * questionnaire, or the saved module and version — and its ID there, when it
 * was renamed on the way in.
 */

/** Names for the sources a phrase mentions: survey and study titles from the catalogue, module titles from the shelf. */
export function useOriginNames(origins: readonly FragmentOrigin[]): OriginNames {
  const here = useStudy();
  const lib = useLibraryUi();
  const wantsCatalogue = origins.some((o) => o.kind === "release");
  const cat = useLibraryCatalogue(wantsCatalogue);
  return useMemo<OriginNames>(() => {
    const studies = cat.status === "ready" ? cat.data.studies : [];
    return {
      here,
      studyTitle: (study) => studies.find((s) => s.study === study)?.title ?? null,
      surveyTitle: (study, surveyId) => studies.find((s) => s.study === study)?.surveys.find((v) => v.surveyId === surveyId)?.title ?? null,
      moduleTitle: (moduleId) => lib.modules.get(moduleId)?.title ?? null,
      validatedName: (refKey) => validatedEntries().entries.find((e) => e.refKey === refKey)?.name ?? null,
    };
  }, [cat, here, lib.modules]);
}

const ORIGIN_HELP =
  "Kept with the draft and with every version published from it, and in the provenance download. A copy keeps its question ID and variable unless they were already taken here.";

/** The "Copied from" group for one question, or nothing when it was not copied. */
export function CopiedFrom({ itemKey }: { itemKey: string }) {
  const ctx = useEditor();
  const headingId = useId();
  const draft = ctx.draft;
  const found = useMemo(() => {
    try {
      return provenanceOf(draft, itemKey);
    } catch {
      return null;
    }
  }, [draft, itemKey]);
  const origins = useMemo(() => (found ? [found.record.origin] : []), [found]);
  const names = useOriginNames(origins);
  if (!found) return null;
  const { record, sourceKey } = found;
  return (
    <section className="sti-group" aria-labelledby={headingId}>
      <div className="sti-titlerow">
        <h3 className="sti-title" id={headingId}>
          Copied from
        </h3>
        <InfoTip text={ORIGIN_HELP} label="where it was copied from" />
      </div>
      <Facts rows={provenanceRows(record, sourceKey, itemKey, names)} />
    </section>
  );
}

function provenanceRows(record: ImportRecord, sourceKey: string, itemKey: string, names: OriginNames) {
  const at = new Date(record.at);
  const renamedVariable = Object.entries(record.variablesRenamed ?? {});
  return [
    { label: kindLabel(record.origin), value: originWords(record.origin, names) },
    ...(sourceKey !== itemKey ? [{ label: "Its ID there", value: <code>{sourceKey}</code>, info: "Renamed here because the ID was taken, so its data will not line up with the original’s." }] : []),
    ...(renamedVariable.length > 0
      ? [{ label: "Variables renamed", value: renamedVariable.map(([from, to]) => `${from} → ${to}`).join(", ") }]
      : []),
    { label: "Added", value: `${record.byEmail || record.by}, ${formatDateTime(Number.isNaN(at.getTime()) ? null : at)}` },
  ];
}

function kindLabel(origin: FragmentOrigin): string {
  switch (origin.kind) {
    case "release":
      return "Survey";
    case "validated":
      return "Questionnaire";
    case "module":
      return "Saved module";
  }
}

/** The sources a block's questions were copied from, each once, in words. */
export function BlockOrigins({ itemKeys }: { itemKeys: readonly string[] }) {
  const ctx = useEditor();
  const draft = ctx.draft;
  const records = useMemo(() => {
    const out = new Map<string, { record: ImportRecord; count: number }>();
    for (const key of itemKeys) {
      let found: ReturnType<typeof provenanceOf> = null;
      try {
        found = provenanceOf(draft, key);
      } catch {
        found = null;
      }
      if (!found) continue;
      const entry = out.get(found.record.id);
      if (entry) entry.count += 1;
      else out.set(found.record.id, { record: found.record, count: 1 });
    }
    return [...out.values()];
  }, [draft, itemKeys]);
  const origins = useMemo(() => records.map((r) => r.record.origin), [records]);
  const names = useOriginNames(origins);
  if (records.length === 0) return null;
  return (
    <ul className="stl-origins">
      {records.map(({ record, count }) => (
        <li key={record.id}>
          {count === itemKeys.length ? "Copied from " : `${count} of its questions copied from `}
          {originWords(record.origin, names)}
        </li>
      ))}
    </ul>
  );
}
