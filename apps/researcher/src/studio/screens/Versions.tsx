import { useId, useMemo, useState } from "react";
import { atLeast, extractDraft, type StudioDraft } from "@myself/studio";
import {
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
import { loadRelease, useRelease } from "../data/releases.js";
import { downloadText, formatDateTime, plural, toDate, versionLabel } from "../format.js";
import { navigate } from "../router.js";
import { AuditList, ChangeList, LoadError, changeHeadline } from "../shell/common.js";
import { PageHead } from "../shell/Shell.js";
import { ConfirmDialog, Dialog } from "../ui/dialog.js";
import { Badge, Button, EmptyState, Field, MenuButton, Notice, Skeleton, type MenuItem } from "../ui/kit.js";
import { TabPanel, Tabs } from "../ui/tabs.js";
import { useToast } from "../ui/toast.js";

/**
 * Every published version of a survey: which one is live, who published it and
 * why, what changed, and how many sittings were collected under it. From here a
 * publisher can restore a version into the draft (the ordinary rollback: restore
 * and publish) or, in an emergency, make an earlier version live again at once.
 */

type View = "history" | "compare" | "activity";
const DRAFT = "__draft__";

export function VersionsScreen({ surveyId, survey, editor }: { surveyId: string; survey: SurveyDoc | null; editor: DraftEditor }) {
  const versions = useVersions(surveyId);
  const stats = useResponseStats(surveyId);
  const [view, setView] = useState<View>("history");
  const [compare, setCompare] = useState<{ from: string; to: string } | null>(null);
  const idBase = useId().replace(/:/g, "");
  const live = survey?.active ?? null;

  return (
    <div className="stp-page">
      <PageHead
        title="Versions"
        lede={
          live
            ? `${versionLabel(live.version)} is live. Participants’ devices pick up a change of version at their next start screen; a sitting already under way always finishes on the version it started.`
            : "Nothing has been published from this survey yet."
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
              <p>When someone publishes the draft, each version appears here with its release note and what changed.</p>
            </EmptyState>
          ) : (
            <ol className="stp-versions" aria-label="Published versions, newest first">
              {versions.data.map((v) => (
                <VersionCard
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
            </ol>
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
    </div>
  );
}

function sittings(stats: Loadable<ResponseStatsResponse>, hash: string): string {
  if (stats.status !== "ready") return "—";
  const s = stats.data.byHash[hash];
  if (!s) return "None yet";
  return `${s.complete.toLocaleString("en-GB")} complete · ${s.partial.toLocaleString("en-GB")} partial`;
}

function VersionCard({
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
  const label = versionLabel(v.version);
  const headingId = useId();
  const publishedAt = toDate(v.publishedAt);

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
    <li className={`stp-card stp-version${live ? " live" : ""}`} aria-labelledby={headingId}>
      <div className="stp-version-head">
        <div className="stp-version-title">
          <h2 id={headingId} className="stp-h2">
            {label}
          </h2>
          {live ? (
            <Badge tone="accent" icon="check">
              Live
            </Badge>
          ) : (
            <Badge tone="muted">Previous</Badge>
          )}
          {v.source === "repository" ? <Badge title="Published before the Studio existed, from the project’s releases folder">From the repository</Badge> : null}
        </div>
        <div className="stp-actions">
          <Button size="sm" variant="ghost" icon="compare" onClick={onCompare}>
            Compare with draft
          </Button>
          <MenuButton label={`More actions for ${label}`} items={items} />
        </div>
      </div>
      <p className="stp-version-meta">
        Published {formatDateTime(publishedAt)}
        {v.publishedByEmail ? ` by ${v.publishedByEmail}` : ""}
      </p>
      <p className="stp-version-note">{v.releaseNote?.trim() ? v.releaseNote : <span className="stp-muted">No release note.</span>}</p>
      <dl className="stp-facts">
        <div>
          <dt>Authors</dt>
          <dd>{v.authors.length > 0 ? v.authors.join(", ") : "—"}</dd>
        </div>
        <div>
          <dt>Sittings recorded</dt>
          <dd>{sittings(stats, v.hash)}</dd>
        </div>
        <div>
          <dt>Questions</dt>
          <dd>{v.itemKeys.length.toLocaleString("en-GB")}</dd>
        </div>
        <div>
          <dt>Release</dt>
          <dd>
            <code>{v.releaseKey}</code>
          </dd>
        </div>
      </dl>
      {v.changeSummary ? (
        <details className="stp-details">
          <summary>What changed — {changeHeadline(v.changeSummary)}</summary>
          <ChangeList summary={v.changeSummary} />
        </details>
      ) : null}

      {dialog === "restore" ? (
        <RestoreDialog surveyId={surveyId} version={v} liveVersion={liveVersion} editor={editor} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "activate" ? (
        <ActivateDialog surveyId={surveyId} version={v} liveVersion={liveVersion} onClose={() => setDialog(null)} />
      ) : null}
    </li>
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
      <p className="stp-flush">
        The working draft becomes a copy of {label}. Nothing is published: {liveVersion ? `${versionLabel(liveVersion)} stays live` : "nothing goes live"}{" "}
        until someone publishes the draft.
      </p>
      <p>
        Any changes in the draft that haven&rsquo;t been published are replaced. You can bring them back with Undo in the
        editor in this tab until you close it; they aren&rsquo;t kept anywhere else.
      </p>
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
      width={560}
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
      <p className="stp-flush">
        This is the emergency switch. Participants&rsquo; devices change {liveVersion ? `from ${versionLabel(liveVersion)} ` : ""}to {label}{" "}
        the next time they reach the start screen; sittings already under way finish on the version they started. The
        draft isn&rsquo;t changed, and {liveVersion ? versionLabel(liveVersion) : "the current version"} stays in the history so you can switch back.
      </p>
      <p>
        For an ordinary rollback, restore {label} into the draft and publish it as a new version instead — that keeps the
        version history moving forward.
      </p>
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
        <Field label="From">
          {(p) => (
            <select {...p} className="st-select" value={from} onChange={(e) => onSelection({ from: e.target.value, to })}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <span className="stp-compare-arrow" aria-hidden="true">
          →
        </span>
        <Field label="To">
          {(p) => (
            <select {...p} className="st-select" value={to} onChange={(e) => onSelection({ from, to: e.target.value })}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {fromDraft.status === "error" ? (
        <LoadError error={fromDraft.error} retry={fromDraft.retry} />
      ) : toDraft.status === "error" ? (
        <LoadError error={toDraft.error} retry={toDraft.retry} />
      ) : !summary ? (
        <Skeleton lines={4} label="Comparing" />
      ) : (
        <section className="stp-card" aria-live="polite">
          <h2 className="stp-h2">
            {from === to ? "Comparing a version with itself" : `From ${nameOf(from)} to ${nameOf(to)}`}
          </h2>
          <p className="stp-muted">{changeHeadline(summary)}</p>
          <ChangeList summary={summary} empty={`No differences: ${nameOf(from)} and ${nameOf(to)} are the same.`} />
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
