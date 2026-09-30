import { useEffect, useMemo, useState } from "react";
import { useMemoryDraftEditor, useStudioSession, type Loadable, type PublishedContext, type StudioUser } from "../data/index.js";
import { EditorPage } from "../editor/EditorPage.js";
import { SHORTCUTS_MENU_ITEM } from "../editor/Toolbar.js";
import { PlaygroundMode } from "../mode.js";
import { PreviewPage } from "../preview/PreviewPage.js";
import { loadPlayground, PLAYGROUND_VERSION, type PlaygroundData } from "../playground-data.js";
import { Banner, Shell, type ShellTab } from "../shell/Shell.js";
import { Notice, Skeleton, type MenuItem } from "../ui/kit.js";
import { useToast } from "../ui/toast.js";

/**
 * #/playground — the live survey in the real editor and preview, held only in
 * this tab's memory. Nothing is saved or sent anywhere, and it works in a build
 * with no Firebase project at all, which makes it the place to try the editor,
 * to demonstrate it, and to test it.
 */

const GUEST: StudioUser = { uid: "playground", email: null, displayName: "Playground", photoURL: null };
/** The editor's shortcuts in the account menu, as on a real survey (when there is an account menu). */
const PLAYGROUND_MENU: MenuItem[] = [SHORTCUTS_MENU_ITEM];

export function PlaygroundScreen({ tab, q }: { tab: "edit" | "preview"; q: string | null }) {
  const [data, setData] = useState<Loadable<PlaygroundData>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setData({ status: "loading" });
    loadPlayground()
      .then((d) => live && setData({ status: "ready", data: d }))
      .catch(
        (e: unknown) =>
          live &&
          setData({
            status: "error",
            error: e instanceof Error ? e.message : "The live survey couldn’t be opened.",
            retry: () => setAttempt((a) => a + 1),
          }),
      );
    return () => {
      live = false;
    };
  }, [attempt]);

  const tabs: ShellTab[] = [
    { label: "Edit", to: { name: "playground", tab: "edit", q }, current: tab === "edit" },
    { label: "Preview", to: { name: "playground", tab: "preview", q }, current: tab === "preview" },
  ];
  const banner = (
    <Banner role="note" icon="play" title="Playground · nothing is saved.">
      The live survey (r{PLAYGROUND_VERSION}) in this tab only. Change anything; reloading puts it back.
    </Banner>
  );

  return (
    <PlaygroundMode.Provider value={true}>
      <Shell crumb="Playground" tabs={tabs} banner={banner} wide menuItems={tab === "edit" && data.status === "ready" ? PLAYGROUND_MENU : undefined}>
        {data.status === "loading" ? (
          <div className="stp-page">
            <Skeleton lines={6} label="Opening the live survey" />
          </div>
        ) : data.status === "error" ? (
          <div className="stp-page">
            <Notice tone="error">{data.error}</Notice>
          </div>
        ) : (
          <PlaygroundBody data={data.data} tab={tab} q={q} />
        )}
      </Shell>
    </PlaygroundMode.Provider>
  );
}

function PlaygroundBody({ data, tab, q }: { data: PlaygroundData; tab: "edit" | "preview"; q: string | null }) {
  const session = useStudioSession();
  const toast = useToast();
  const editor = useMemoryDraftEditor(data.draft);
  const context = useMemo<Loadable<PublishedContext>>(() => ({ status: "ready", data: data.context }), [data.context]);

  // The same shortcut as the real editor, answered honestly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        toast.info("Nothing is saved in the playground", "Changes here stay in this tab until you reload it.");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast]);

  const surveyId = data.draft.surveyId;
  if (tab === "preview") return <PreviewPage surveyId={surveyId} draft={editor.draft} startAt={q} />;
  // Always "editor", whoever is signed in: publishing is not something the
  // playground can do, and nothing in it should offer to.
  return <EditorPage surveyId={surveyId} survey={null} editor={editor} context={context} role="editor" user={session.user ?? GUEST} />;
}
