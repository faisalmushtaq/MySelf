import { useId, useMemo, useState } from "react";
import { atLeast, extractDraft, type StudioDraft } from "@myself/studio";
import {
  loadAudit,
  studio,
  StudioCallError,
  useAudit,
  useResponseStats,
  useStudioSession,
  useVersions,
  type DraftEditor,
  type Loadable,
  type ResponseStatsResponse,
  type SurveyDoc,
  type VersionDoc,
} from "../data/index.js";
import { diffDrafts } from "../data/model-adapter.js";
import { provenanceCsv, provenanceDocument, provenanceFilename, provenanceRows } from "../data/provenance.js";
import { loadRelease, useRelease } from "../data/releases.js";
import { useStudy } from "../router.js";
import { downloadText, formatDate, formatDateTime, toDate, versionLabel } from "../format.js";
import { navigate } from "../router.js";
import { AuditList, ChangeList, LoadError, changeHeadline } from "../shell/common.js";
import { PageHead } from "../shell/Shell.js";
import { Dialog } from "../ui/dialog.js";
import { Button, EmptyState, Field, IconButton, InfoTip, MenuButton, Notice, Skeleton, StatusDot, type MenuItem } from "../ui/kit.js";
import { TabPanel, Tabs } from "../ui/tabs.js";
import { ParticipantLinkDialog } from "./ParticipantLink.js";
import { useToast } from "../ui/toast.js";

/**
 * Every published version of a survey: which one is live, who published it and
 * why, what changed, and how many sittings were collected under it. From here a
 * publisher can restore a version into the draft (the ordinary rollback: restore
 * and publish) or, in an emergency, make an earlier version live again at once.
 */

type View = "history" | "compare" | "activity";
const DRAFT = "__draft__";

const LIVE_HELP =
  "Participants’ devices pick up a change of version at their next start screen; a sitting already under way always finishes on the version it started.";

export function VersionsScreen({ surveyId, survey, editor }: { surveyId: string; survey: SurveyDoc | null; editor: DraftEditor }) {
  const versions = useVersions(surveyId);
  const stats = useResponseStats(surveyId);
  const [view, setView] = useState<View>("history");
  const [showLink, setShowLink] = useState(false);
  const [compare, setCompare] = useState<{ from: string; to: string } | null>(null);
  const idBase = useId().replace(/:/g, "");
  const live = survey?.active ?? null;

  return (
    <div className="stp-page">
      <PageHead
        title="Versions"
        actions={
          <>
            {/* The survey's participant link, once something is live for it to open (D-56). */}
            {live ? (
              <Button icon="link" onClick={() => setShowLink(true)}>
                Participant link
              </Button>
            ) : null}
            <ProvenanceDownload surveyId={surveyId} survey={survey} versions={versions} stats={stats} />
          </>
        }
        lede={
          live ? (
            <>
              <span className="stp-dotted">
                <StatusDot tone="accent" />
                {versionLabel(live.version)} is live
              </span>
              <InfoTip label="the live version" text={LIVE_HELP} />
            </>
          ) : (
            "Nothing published yet."
          )
        }
      />
      <Tabs
        label="Versions"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { value: "history", label: "History", count: versions.status === "ready" ? versions.data.length : null },
          { value: "compare", label: "Compare" },
          { value: "activity", label: "Activity" },
        ]}
      />
      <TabPanel idBase={idBase} value={view}>
        {versions.status === "loading" ? (
          <Skeleton lines={6} label="Loading versions" />
        ) : versions.status === "error" ? (
          <LoadError error={versions.error} retry={versions.retry} />
        ) : view === "history" ? (
          versions.data.length === 0 ? (
            <EmptyState icon="publish" title="No versions yet">
              <p>Each published version appears here, with its note and what changed.</p>
            </EmptyState>
          ) : (
            <div className="stp-table-wrap">
              <table className="stp-table stp-vtable" aria-label="Published versions, newest first">
                <thead>
                  <tr>
                    <th scope="col" className="stp-col-toggle">
                      <span className="st-sr">Details</span>
                    </th>
                    <th scope="col" className="stp-col-version">
                      Version
                    </th>
                    <th scope="col" className="stp-col-status">
                      Status
                    </th>
                    <th scope="col" className="stp-col-when stp-hide-narrow">
                      Published
                    </th>
                    <th scope="col" className="stp-col-by stp-hide-medium">
                      By
                    </th>
                    <th scope="col" className="stp-hide-narrow">
                      Note
                    </th>
                    <th scope="col" className="stp-col-sittings stp-num stp-hide-medium">
                      Sittings
                    </th>
                    <th scope="col" className="stp-col-actions stp-cell-action">
                      <span className="st-sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versions.data.map((v) => (
                    <VersionRow
                      key={v.version}
                      surveyId={surveyId}
                      version={v}
                      live={live?.hash === v.hash}
                      liveVersion={live?.version ?? null}
                      stats={stats}
                      editor={editor}
                      onCompare={() => {
                        setCompare({ from: v.version, to: DRAFT });
                        setView("compare");
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : view === "compare" ? (
          <CompareView
            versions={versions.data}
            liveVersion={live?.version ?? null}
            editor={editor}
            selection={compare}
            onSelection={setCompare}
          />
        ) : (
          <ActivityView surveyId={surveyId} />
        )}
      </TabPanel>
      {showLink && survey ? <ParticipantLinkDialog survey={survey} onClose={() => setShowLink(false)} /> : null}
    </div>
  );
}

/**
 * The provenance of every version, as a spreadsheet or as JSON (docs/16
 * §10.2): read from what the Studio already keeps — the version records,
 * their releases, the audit trail and the sitting counts — when asked for.
 */
function ProvenanceDownload({
  surveyId,
  survey,
  versions,
  stats,
}: {
  surveyId: string;
  survey: SurveyDoc | null;
  versions: Loadable<VersionDoc[]>;
  stats: Loadable<ResponseStatsResponse>;
}) {
  const toast = useToast();
  const study = useStudy();
  const [busy, setBusy] = useState(false);
  const ready = versions.status === "ready" && versions.data.length > 0;

  const download = (format: "csv" | "json") => {
    if (versions.status !== "ready") return;
    const list = versions.data;
    setBusy(true);
    Promise.all([
      loadAudit(surveyId),
      // A release that can't be read leaves its MyStory column empty rather than the whole download undone.
      Promise.all(list.map((v) => loadRelease(v.hash).then((r) => [v.hash, r.raw] as const, () => null))),
    ])
      .then(([audit, loaded]) => {
        const live = survey?.active ?? null;
        const rows = provenanceRows({
          versions: list,
          live,
          audit,
          releases: new Map(loaded.filter((x): x is readonly [string, unknown] => x !== null)),
          sittings: stats.status === "ready" ? stats.data.byHash : null,
        });
        const now = new Date();
        if (format === "csv") {
          downloadText(provenanceCsv(rows), provenanceFilename(surveyId, now, "csv"), "text/csv;charset=utf-8");
        } else {
          const doc = provenanceDocument(rows, { study, surveyId, title: survey?.title ?? null, live, exportedAt: now });
          downloadText(`${JSON.stringify(doc, null, 2)}\n`, provenanceFilename(surveyId, now, "json"));
        }
      })
      .catch((e: unknown) => toast.error("Couldn’t prepare the provenance", e instanceof Error ? e.message : undefined))
      .finally(() => setBusy(false));
  };

  const hint = ready ? undefined : "There are no published versions yet.";
  return (
    <MenuButton
      label="Download provenance"
      icon="arrow-down"
      buttonLabel={busy ? "Preparing…" : "Download provenance"}
      items={[
        { label: "As a spreadsheet (CSV)", icon: "arrow-down", onSelect: () => download("csv"), disabled: !ready || busy, ...(hint ? { hint } : {}) },
        { label: "As JSON", icon: "arrow-down", onSelect: () => download("json"), disabled: !ready || busy, ...(hint ? { hint } : {}) },
      ]}
    />
  );
}

/**
 * Complete sittings, for the row; the details show complete and partial.
 * Still counting shows a shimmer, and a count that couldn't be had a dash
 * that says so — never the same dash for both.
 */
function SittingsCell({ stats, hash }: { stats: Loadable<ResponseStatsResponse>; hash: string }) {
  if (stats.status === "loading") {
    return (
      <span className="stp-skel-inline" role="status" aria-label="Counting sittings">
        <span />
      </span>
    );
  }
  if (stats.status === "error") {
    return (
      <span className="stp-meta" title="Couldn’t count the sittings">
        —<span className="st-sr">Couldn’t count the sittings</span>
      </span>
    );
  }
  const s = stats.data.byHash[hash];
  if (!s) return <span className="stp-meta">None</span>;
  return <span>{`${s.complete.toLocaleString("en-GB")} complete`}</span>;
}

function sittings(stats: Loadable<ResponseStatsResponse>, hash: string): string {
  if (stats.status !== "ready") return "—";
  const s = stats.data.byHash[hash];
  if (!s) return "None yet";
  return `${s.complete.toLocaleString("en-GB")} complete · ${s.partial.toLocaleString("en-GB")} partial`;
}

function VersionRow({
  surveyId,
  version: v,
  live,
  liveVersion,
  stats,
  editor,
  onCompare,
}: {
  surveyId: string;
  version: VersionDoc;
  live: boolean;
  liveVersion: string | null;
  stats: Loadable<ResponseStatsResponse>;
  editor: DraftEditor;
  onCompare: () => void;
}) {
  const session = useStudioSession();
  const toast = useToast();
  const canPublish = atLeast(session.role, "publisher");
  const [dialog, setDialog] = useState<"restore" | "activate" | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [open, setOpen] = useState(false);
  const label = versionLabel(v.version);
  const detailId = useId();
  const publishedAt = toDate(v.publishedAt);
  const note = v.releaseNote?.trim() ? v.releaseNote : null;

  const download = () => {
    setDownloading(true);
    loadRelease(v.hash)
      .then((r) => downloadText(r.json, `${v.releaseKey}.manifest.json`))
      .catch((e: unknown) => toast.error(`Couldn’t download ${label}`, e instanceof Error ? e.message : undefined))
      .finally(() => setDownloading(false));
  };

  const items: MenuItem[] = [
    { label: downloading ? "Downloading…" : "Download manifest (JSON)", icon: "arrow-down", onSelect: download, disabled: downloading },
    {
      label: "Restore into draft",
      icon: "restore",
      onSelect: () => setDialog("restore"),
      disabled: !canPublish,
      ...(canPublish ? {} : { hint: "Publishers and admins can restore versions." }),
    },
    {
      label: "Make live again",
      icon: "publish",
      onSelect: () => setDialog("activate"),
      disabled: !canPublish || live,
      ...(live ? { hint: "This is the live version." } : canPublish ? {} : { hint: "Publishers and admins can do this." }),
    },
  ];

  return (
    <>
      <tr className={open ? "open" : undefined}>
        <td className="stp-col-toggle">
          <IconButton
            size="sm"
            icon={open ? "chevron-down" : "chevron-right"}
            label={`Details of ${label}`}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            onClick={() => setOpen((o) => !o)}
          />
        </td>
        <th scope="row">
          <span className="stp-version-label">{label}</span>
        </th>
        <td>
          {live ? (
            <span className="stp-dotted">
              <StatusDot tone="accent" />
              Live
            </span>
          ) : (
            <span className="stp-dotted stp-muted">
              <StatusDot />
              Previous
            </span>
          )}
        </td>
        <td className="stp-hide-narrow">
          <span className="stp-muted stp-truncate" title={formatDateTime(publishedAt)}>
            {formatDate(publishedAt)}
          </span>
        </td>
        <td className="stp-hide-medium">
          {v.publishedByEmail ? (
            <span className="stp-truncate" title={v.publishedByEmail}>
              {v.publishedByEmail}
            </span>
          ) : v.source === "repository" ? (
            <span className="stp-meta" title="Published before the Studio existed, from the project’s releases folder">
              Repository
            </span>
          ) : (
            <span className="stp-meta">—</span>
          )}
        </td>
        <td className="stp-hide-narrow">
          {note ? (
            <span className="stp-truncate" title={note}>
              {note}
            </span>
          ) : (
            <span className="stp-meta">No note</span>
          )}
        </td>
        <td className="stp-num stp-hide-medium">
          <SittingsCell stats={stats} hash={v.hash} />
        </td>
        <td className="stp-cell-action">
          <span className="stp-actions">
            <IconButton icon="compare" label={`Compare ${label} with the draft`} onClick={onCompare} />
            <MenuButton label={`More actions for ${label}`} items={items} />
          </span>
          {dialog === "restore" ? (
            <RestoreDialog surveyId={surveyId} version={v} liveVersion={liveVersion} editor={editor} onClose={() => setDialog(null)} />
          ) : null}
          {dialog === "activate" ? (
            <ActivateDialog surveyId={surveyId} version={v} liveVersion={liveVersion} onClose={() => setDialog(null)} />
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr className="stp-vdetail" id={detailId}>
          <td colSpan={8}>
            <div className="stp-vdetail-inner">
              <p className={`stp-version-note${note ? "" : " stp-meta"}`}>{note ?? "No release note."}</p>
              <dl className="stp-kv stp-kv-compact">
                <div>
                  <dt>Published</dt>
                  <dd>
                    {formatDateTime(publishedAt)}
                    {v.publishedByEmail ? ` by ${v.publishedByEmail}` : ""}
                    {v.source === "repository" ? " · from the repository, before the Studio existed" : ""}
                  </dd>
                </div>
                <div>
                  <dt>Authors</dt>
                  <dd>{v.authors.length > 0 ? v.authors.join(", ") : "—"}</dd>
                </div>
                <div>
                  <dt>Sittings</dt>
                  <dd>{sittings(stats, v.hash)}</dd>
                </div>
                <div>
                  <dt>Questions</dt>
                  <dd>{v.itemKeys.length.toLocaleString("en-GB")}</dd>
                </div>
                <div>
                  <dt>Release</dt>
                  <dd>
                    <span className="stp-id">{v.releaseKey}</span>
                  </dd>
                </div>
              </dl>
              {v.changeSummary ? (
                <div className="stp-vdetail-changes">
                  <h3 className="stp-h3">
                    What changed <span className="stp-count">{changeHeadline(v.changeSummary)}</span>
                  </h3>
                  <ChangeList summary={v.changeSummary} />
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RestoreDialog({
  surveyId,
  version: v,
  liveVersion,
  editor,
  onClose,
}: {
  surveyId: string;
  version: VersionDoc;
  liveVersion: string | null;
  editor: DraftEditor;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = versionLabel(v.version);
  const pending = editor.hasUnsavedChanges || editor.save.kind === "saving";
  const blocked = editor.save.kind === "conflict" ? "Resolve the conflict in the draft first." : editor.status !== "ready" ? "The draft hasn’t loaded." : null;

  return (
    <Dialog
      title={`Restore ${label} into the draft?`}
      onClose={onClose}
      dismissable={!busy}
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={pending || !!blocked}
            onClick={() => {
              setBusy(true);
              setError(null);
              studio
                .restoreVersion({ surveyId, version: v.version, expectedRevision: editor.revision })
                .then(() => {
                  toast.show({
                    tone: "success",
                    title: `Draft restored from ${label}`,
                    body: "Nothing has been published. Undo in the editor brings back what was there before.",
                    action: { label: "Open the editor", onClick: () => navigate({ name: "survey", surveyId, tab: "edit", q: null }) },
                  });
                  onClose();
                })
                .catch((e: unknown) => {
                  setBusy(false);
                  if (e instanceof StudioCallError && e.details?.kind === "conflict") {
                    setError("Someone saved the draft while you were restoring, so nothing was restored. Check what changed, then try again.");
                  } else setError(e instanceof StudioCallError ? e.message : `${label} couldn’t be restored. Try again.`);
                });
            }}
          >
            Restore {label}
          </Button>
        </>
      }
    >
      <div className="st-confirm-body">
        <p>
          The draft becomes a copy of {label}. Nothing is published: {liveVersion ? `${versionLabel(liveVersion)} stays live` : "nothing goes live"}{" "}
          until someone publishes the draft.
        </p>
        <p>
          Unpublished changes in the draft are replaced. Undo in the editor brings them back until you close this tab;
          they aren&rsquo;t kept anywhere else.
        </p>
      </div>
      {pending ? (
        <Notice
          tone="warn"
          action={
            <Button size="sm" variant="secondary" onClick={() => void editor.saveNow()}>
              Save now
            </Button>
          }
        >
          This tab has changes that are still being saved. Once the draft is saved, you can restore.
        </Notice>
      ) : null}
      {blocked ? <Notice tone="warn">{blocked}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}

const MIN_REASON = 10;

function ActivateDialog({
  surveyId,
  version: v,
  liveVersion,
  onClose,
}: {
  surveyId: string;
  version: VersionDoc;
  liveVersion: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const label = versionLabel(v.version);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonError = reason.trim().length < MIN_REASON ? `Say why, in at least ${MIN_REASON} characters.` : null;
  const typedError = typed.trim() !== label ? `Type ${label} exactly.` : null;

  const submit = () => {
    setSubmitted(true);
    if (reasonError || typedError) return;
    setBusy(true);
    setError(null);
    studio
      .activateVersion({ surveyId, version: v.version, reason: reason.trim() })
      .then(async (res) => {
        // Success is reported only once the public pointer says so: that is
        // what devices read, and a success message for a change they can't see
        // would be worse than none.
        //
        // A failure to READ the pointer back is not a failure of the change,
        // which the server has already made: it must not reach the catch
        // below, whose message says nothing changed and invites a repeat.
        const confirmed = await studio.confirmLive(surveyId, res.hash).catch(() => false);
        if (confirmed) {
          toast.success(`${label} is live again`, "Devices switch to it at their next start screen.");
          onClose();
        } else {
          setBusy(false);
          setError(
            `The server accepted the change, but the Studio couldn’t yet confirm that the live version shows ${label}. Wait a minute and reload this page to check before doing anything else.`,
          );
        }
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(e instanceof StudioCallError ? e.message : `${label} couldn’t be made live. Nothing changed.`);
      });
  };

  return (
    <Dialog
      title={`Make ${label} live again?`}
      onClose={onClose}
      dismissable={!busy}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={submit}>
            Make {label} live
          </Button>
        </>
      }
    >
      <div className="st-confirm-body">
        <p>
          This is the emergency switch. Devices change {liveVersion ? `from ${versionLabel(liveVersion)} ` : ""}to {label} at
          their next start screen; sittings under way finish on the version they started. The draft isn&rsquo;t changed,
          and {liveVersion ? versionLabel(liveVersion) : "the current version"} stays in the history so you can switch back.
        </p>
        <p>
          For an ordinary rollback, restore {label} into the draft and publish it as a new version instead, so the history
          keeps moving forward.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Reason" hint="Recorded in the activity log with your name." error={submitted ? reasonError : null}>
          {(p) => <textarea {...p} className="st-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <Field label={<>Type <strong>{label}</strong> to confirm</>} error={submitted ? typedError : null}>
          {(p) => (
            <input
              {...p}
              className="st-input st-input-mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <button type="submit" hidden />
      </form>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}

// ── Compare ───────────────────────────────────────────────────────────────

function useDraftOf(versions: readonly VersionDoc[], choice: string, editor: DraftEditor): Loadable<StudioDraft | null> {
  const v = choice === DRAFT ? null : (versions.find((x) => x.version === choice) ?? null);
  const release = useRelease(v?.hash ?? null);
  return useMemo(() => {
    if (choice === DRAFT) return editor.draft ? { status: "ready", data: editor.draft } : { status: "loading" };
    if (release.status !== "ready") return release;
    if (!release.data) return { status: "ready", data: null };
    try {
      return { status: "ready", data: extractDraft(release.data.raw) };
    } catch {
      return { status: "error", error: `${versionLabel(v?.version)} couldn’t be opened for comparison.`, retry: () => undefined };
    }
  }, [choice, editor.draft, release, v?.version]);
}

function CompareView({
  versions,
  liveVersion,
  editor,
  selection,
  onSelection,
}: {
  versions: readonly VersionDoc[];
  liveVersion: string | null;
  editor: DraftEditor;
  selection: { from: string; to: string } | null;
  onSelection: (s: { from: string; to: string }) => void;
}) {
  const from = selection?.from ?? liveVersion ?? versions[0]?.version ?? DRAFT;
  const to = selection?.to ?? DRAFT;
  const fromDraft = useDraftOf(versions, from, editor);
  const toDraft = useDraftOf(versions, to, editor);
  const nameOf = (c: string) => (c === DRAFT ? "the working draft" : versionLabel(c));
  const shortName = (c: string) => (c === DRAFT ? "Working draft" : versionLabel(c));
  const fromId = useId();
  const toId = useId();

  const options = [
    { value: DRAFT, label: `Working draft${editor.hasUnsavedChanges ? " (including unsaved changes)" : ""}` },
    ...versions.map((v) => ({ value: v.version, label: `${versionLabel(v.version)}${v.version === liveVersion ? " (live)" : ""}` })),
  ];

  const summary = useMemo(() => {
    if (fromDraft.status !== "ready" || toDraft.status !== "ready" || !toDraft.data) return null;
    return diffDrafts(fromDraft.data, toDraft.data);
  }, [fromDraft, toDraft]);

  if (versions.length === 0 && !editor.draft) {
    return <EmptyState icon="compare" title="Nothing to compare yet" />;
  }

  return (
    <div className="stp-compare">
      <div className="stp-compare-pick">
        <label htmlFor={fromId}>From</label>
        <select id={fromId} className="st-select" value={from} onChange={(e) => onSelection({ from: e.target.value, to })}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="stp-compare-arrow" aria-hidden="true">
          →
        </span>
        <label htmlFor={toId}>To</label>
        <select id={toId} className="st-select" value={to} onChange={(e) => onSelection({ from, to: e.target.value })}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {fromDraft.status === "error" ? (
        <LoadError error={fromDraft.error} retry={fromDraft.retry} />
      ) : toDraft.status === "error" ? (
        <LoadError error={toDraft.error} retry={toDraft.retry} />
      ) : !summary ? (
        <Skeleton lines={4} label="Comparing" />
      ) : (
        <section className="stp-compare-result" aria-live="polite" aria-labelledby={`${fromId}-result`}>
          <div className="stp-section-head">
            <div>
              <h2 id={`${fromId}-result`} className="stp-h2">
                {from === to ? `${shortName(from)}, compared with itself` : `From ${nameOf(from)} to ${nameOf(to)}`}
              </h2>
              <p>
                {summary.entries.length > 0
                  ? changeHeadline(summary)
                  : `No differences: ${nameOf(from)} and ${nameOf(to)} are the same.`}
              </p>
            </div>
          </div>
          {summary.entries.length > 0 ? <ChangeList summary={summary} /> : null}
        </section>
      )}
    </div>
  );
}

// ── Activity ──────────────────────────────────────────────────────────────

function ActivityView({ surveyId }: { surveyId: string }) {
  const audit = useAudit(surveyId, 100);
  if (audit.status === "loading") return <Skeleton lines={6} label="Loading activity" />;
  if (audit.status === "error") return <LoadError error={audit.error} retry={audit.retry} />;
  return <AuditList rows={audit.data} empty="Publishing, restoring and editing this survey are recorded here." />;
}
