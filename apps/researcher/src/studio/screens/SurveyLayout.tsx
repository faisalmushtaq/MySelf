import { useId, useMemo, useRef, useState } from "react";
import { atLeast, type StudioDraft, type StudioRole } from "@myself/studio";
import { useDraftSession, type DraftSession } from "../data/draft-editor.js";
import { usePublishedContext, useStudioSession, useSurvey, type DraftEditor } from "../data/index.js";
import { diffDrafts } from "../data/model-adapter.js";
import { EditorPage } from "../editor/EditorPage.js";
import { SHOW_SHORTCUTS_EVENT } from "../editor/Toolbar.js";
import { formatTime, ROLE_NAMES } from "../format.js";
import { PreviewPage } from "../preview/PreviewPage.js";
import { navigate, useNavigationGuard, type SurveyTab } from "../router.js";
import { ChangeList, LoadError, changeHeadline } from "../shell/common.js";
import { Banner, Shell, type ShellTab } from "../shell/Shell.js";
import { ConfirmDialog } from "../ui/dialog.js";
import { Button, EmptyState, InfoTip, Skeleton, type MenuItem } from "../ui/kit.js";
import { SettingsScreen } from "./Settings.js";
import { VersionsScreen } from "./Versions.js";

/**
 * Everything under #/surveys/:surveyId — one survey, one draft editor.
 *
 * The draft editor lives here rather than in the Edit page so that it
 * survives moving between Edit, Preview, Versions and Settings: unsaved edits
 * preview straight away, the Versions page compares against the working copy,
 * and a save in flight is not abandoned by a change of tab. Leaving the survey
 * with work not yet saved asks first.
 *
 * The platform owns the page-wide messages about the draft (a conflict, a
 * failed save, recovered work, a lost connection); the editor shows its own
 * compact save status.
 */

const TAB_LABELS: Record<SurveyTab, string> = { edit: "Edit", preview: "Preview", versions: "Versions", settings: "Settings" };

export function SurveyLayout({ surveyId, tab, q }: { surveyId: string; tab: SurveyTab; q: string | null }) {
  const session = useStudioSession();
  const survey = useSurvey(surveyId);
  const draft = useDraftSession(surveyId);
  const context = usePublishedContext(surveyId);
  const draftRef = useRef<DraftSession>(draft);
  draftRef.current = draft;

  useNavigationGuard(draft.editor.hasUnsavedChanges, {
    // Moving between this survey's own tabs keeps the editor, so only leaving it asks.
    blocks: (next) => !(next && next.name === "survey" && next.surveyId === surveyId),
    save: () => draftRef.current.flush(),
    cannotSave: () => draftRef.current.cannotSave,
  });

  const tabs: ShellTab[] = (Object.keys(TAB_LABELS) as SurveyTab[]).map((t) => ({
    label: TAB_LABELS[t],
    to: { name: "survey", surveyId, tab: t, q: t === "edit" || t === "preview" ? q : null },
    current: t === tab,
  }));

  // The editor's shortcuts, from the account menu (the "?" key opens them too).
  const menuItems = useMemo<MenuItem[] | undefined>(
    () =>
      tab === "edit"
        ? [{ label: "Keyboard shortcuts", icon: "keyboard", shortcut: "?", onSelect: () => window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT)) }]
        : undefined,
    [tab],
  );

  const title = survey.status === "ready" && survey.data ? survey.data.title : surveyId;
  const role: StudioRole = session.role ?? "viewer";
  const user = session.user!;

  if (survey.status === "ready" && survey.data === null) {
    return (
      <Shell crumb={surveyId}>
        <div className="stp-page">
          <EmptyState icon="search" title="There’s no survey with this ID" action={<Button onClick={() => navigate({ name: "surveys" })}>See all surveys</Button>}>
            <p>
              Nothing is stored as <code>{surveyId}</code>. Check the address, or pick the survey from the list.
            </p>
          </EmptyState>
        </div>
      </Shell>
    );
  }

  let content;
  if (survey.status === "error") {
    content = (
      <div className="stp-page">
        <LoadError error={survey.error} retry={survey.retry} />
      </div>
    );
  } else if (survey.status === "loading") {
    content = (
      <div className="stp-page">
        <Skeleton lines={5} label="Loading the survey" />
      </div>
    );
  } else if (tab === "edit") {
    content = <EditorPage surveyId={surveyId} survey={survey.data} editor={draft.editor} context={context} role={role} user={user} />;
  } else if (tab === "preview") {
    content = <PreviewPage surveyId={surveyId} draft={draft.editor.draft} startAt={q} />;
  } else if (tab === "versions") {
    content = <VersionsScreen surveyId={surveyId} survey={survey.data} editor={draft.editor} />;
  } else {
    content = <SettingsScreen surveyId={surveyId} survey={survey.data} editor={draft.editor} />;
  }

  return (
    <Shell
      crumb={<span title={title}>{title}</span>}
      tabs={tabs}
      wide={tab === "edit" || tab === "preview"}
      banner={<DraftBanners draft={draft} tab={tab} role={role} />}
      menuItems={menuItems}
    >
      {content}
    </Shell>
  );
}

function DraftBanners({ draft, tab, role }: { draft: DraftSession; tab: SurveyTab; role: StudioRole }) {
  const { editor } = draft;
  const save = editor.save;
  const banners = [];

  if (save.kind === "conflict") banners.push(<ConflictBanner key="conflict" editor={editor} theirs={save.theirs} />);
  if (save.kind === "error") {
    banners.push(
      <Banner
        key="error"
        tone="error"
        title="Your latest changes aren’t saved."
        action={
          <Button size="sm" variant="secondary" icon="restart" onClick={() => void editor.saveNow()}>
            Retry now
          </Button>
        }
      >
        {save.message} {save.retryAt ? `The Studio retries at ${formatTime(save.retryAt)}. ` : ""}They&rsquo;re kept in this tab until then.
      </Banner>,
    );
  }
  if (draft.listenerError) {
    banners.push(
      <Banner
        key="listener"
        tone="warn"
        title="Lost touch with the saved draft."
        action={
          <Button size="sm" variant="secondary" onClick={draft.reconnect}>
            Reconnect
          </Button>
        }
      >
        Other people&rsquo;s changes won&rsquo;t appear until it reconnects.{" "}
        <InfoTip label="the lost connection" text={draft.listenerError} />
      </Banner>,
    );
  }
  if (draft.recovery) {
    const at = formatTime(draft.recovery.savedAt);
    banners.push(
      draft.recovery.kind === "recoverable" ? (
        <Banner
          key="recovery"
          tone="accent"
          title="Unsaved changes from before the reload."
          action={
            <>
              <Button size="sm" variant="primary" onClick={draft.recover}>
                Recover them
              </Button>
              <Button size="sm" variant="ghost" onClick={draft.discardRecovery}>
                Discard
              </Button>
            </>
          }
        >
          This tab kept a copy at {at}, and nobody has saved since.
        </Banner>
      ) : (
        <Banner
          key="recovery"
          tone="warn"
          title="Unsaved changes from before the reload can’t be put back."
          action={
            <>
              <Button size="sm" variant="secondary" onClick={draft.downloadRecovery}>
                Download them
              </Button>
              <Button size="sm" variant="ghost" onClick={draft.discardRecovery}>
                Discard
              </Button>
            </>
          }
        >
          The copy from {at} would overwrite a later save.{" "}
          <InfoTip
            label="recovering changes"
            text={`This tab kept a copy at ${at}, but the draft has been saved since, and putting the copy back would overwrite that. Download it to keep a record of what you’d changed.`}
          />
        </Banner>
      ),
    );
  }
  if (tab === "edit" && editor.status === "ready" && !atLeast(role, "editor")) {
    banners.push(
      <Banner key="viewer" icon="eye" title="View only.">
        You&rsquo;re a {ROLE_NAMES[role]}: ask an admin if you need to edit.
      </Banner>,
    );
  }
  if (banners.length === 0) return null;
  return <div className="stp-banners">{banners}</div>;
}

function ConflictBanner({
  editor,
  theirs,
}: {
  editor: DraftEditor;
  theirs: { draft: StudioDraft; revision: number; by: string | null; at: Date | null };
}) {
  const [confirmKeep, setConfirmKeep] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const diffId = useId();
  const diff = useMemo(() => (editor.draft ? diffDrafts(theirs.draft, editor.draft) : null), [theirs.draft, editor.draft]);
  const who = theirs.by ?? "Someone else";
  return (
    <Banner
      tone="warn"
      role="alert"
      title={`${who} saved this draft while you were editing${theirs.at ? ` (${formatTime(theirs.at)})` : ""}.`}
      action={
        <>
          {diff ? (
            <Button size="sm" variant="ghost" aria-expanded={showDiff} aria-controls={diffId} onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? "Hide differences" : "Show differences"}
            </Button>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => editor.resolveConflict("take_theirs")}>
            Use their version
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setConfirmKeep(true)}>
            Keep mine
          </Button>
        </>
      }
      more={
        diff && showDiff ? (
          <div id={diffId}>
            <p className="stp-flush stp-gap">
              <strong>How yours differs from theirs:</strong> {changeHeadline(diff)}
            </p>
            <ChangeList summary={diff} empty="Your version and theirs are the same." />
          </div>
        ) : null
      }
    >
      Nothing is overwritten; the draft is read-only until you choose.{" "}
      <InfoTip
        label="the conflict"
        text="Their save and your unsaved changes both started from the same version. Choose which to keep; the other is set aside."
      />
      {confirmKeep ? (
        <ConfirmDialog
          title="Replace their changes with yours?"
          body={
            <>
              <p>
                Your version is saved on top of theirs and becomes the draft. Their changes will no longer be in it. The
                activity log still records that {who} edited the draft.
              </p>
              <p>If you&rsquo;re not sure, choose &ldquo;Use their version&rdquo; and make your changes again.</p>
            </>
          }
          confirmLabel="Keep mine"
          destructive
          onCancel={() => setConfirmKeep(false)}
          onConfirm={() => {
            setConfirmKeep(false);
            editor.resolveConflict("keep_mine");
          }}
        />
      ) : null}
    </Banner>
  );
}
