import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { dismissModuleUpdate, pendingModuleUpdates, type LibraryModuleSummary, type PendingModuleUpdate } from "@myself/studio";
import { useLibraryModules } from "../../data/library.js";
import { plural } from "../../format.js";
import { useToast } from "../../ui/toast.js";
import { useEditor } from "../context.js";
import type { BlockRef } from "../node/BlockEditor.js";
import { InsertResultDialog } from "./InsertDialogs.js";
import { LibraryDrawer, type Added } from "./LibraryDrawer.js";
import { needsReading, type TargetChoice } from "./model.js";
import { ModuleUpdateDialog } from "./ModuleUpdate.js";
import { SaveModuleDialog } from "./SaveModuleDialog.js";
import "./library.css";

/**
 * The item library inside the editor (D-57, docs/16 §12): the drawer pieces
 * are added from, saving a block to the library, and the update notices for
 * blocks copied from a saved module.
 *
 * The toolbar, the outline's menus, the centre editor and the settings panel
 * all open the same drawer and dialogs, so they live here, once, beside the
 * editor context. Every change they make goes through `ctx.run` as one edit,
 * like any other: it can be undone, it is saved by the same engine, and a
 * conflict stops it in the same way.
 */

export interface LibraryUi {
  /** Open the drawer, with where the piece goes chosen already (a section's "Add from library…") or not. */
  openDrawer: (target?: TargetChoice | null) => void;
  /** "Save to library…" for an editable block. */
  openSave: (block: BlockRef) => void;
  /** The saved modules on the shelf, by ID, once known (for titles and notices). */
  modules: ReadonlyMap<string, LibraryModuleSummary>;
  /** Module copies in this draft with a newer version not yet taken or put off. */
  updates: readonly PendingModuleUpdate[];
  review: (update: PendingModuleUpdate) => void;
  /** "Not now": this version is put off; a later one notifies again. */
  dismiss: (update: PendingModuleUpdate) => void;
}

const LibraryContext = createContext<LibraryUi | null>(null);

export function useLibraryUi(): LibraryUi {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useLibraryUi outside LibraryProvider");
  return value;
}

const NO_UPDATES: readonly PendingModuleUpdate[] = [];

export function LibraryProvider({ children }: { children: ReactNode }) {
  const ctx = useEditor();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const toast = useToast();
  const [drawer, setDrawer] = useState<{ target: TargetChoice | null } | null>(null);
  const [saving, setSaving] = useState<BlockRef | null>(null);
  const [reviewing, setReviewing] = useState<PendingModuleUpdate | null>(null);
  const [result, setResult] = useState<Added | null>(null);

  // The module list is asked for only when something needs it: a draft with
  // module copies (for its notices), or an open drawer or dialog.
  const imports = ctx.draft.imports;
  const usesModules = useMemo(() => (imports ?? []).some((r) => r.origin.kind === "module"), [imports]);
  const list = useLibraryModules(false, usesModules || drawer !== null || saving !== null);
  const modules = useMemo(
    () => new Map<string, LibraryModuleSummary>(list.status === "ready" ? list.data.map((m) => [m.moduleId, m]) : []),
    [list],
  );

  const draft = ctx.draft;
  const updates = useMemo(() => {
    if (!usesModules || modules.size === 0) return NO_UPDATES;
    const latest: Record<string, number> = {};
    for (const m of modules.values()) latest[m.moduleId] = m.latestVersion;
    try {
      return pendingModuleUpdates(draft, latest);
    } catch {
      return NO_UPDATES;
    }
  }, [draft, modules, usesModules]);

  const openDrawer = useCallback((target?: TargetChoice | null) => setDrawer({ target: target ?? null }), []);
  const openSave = useCallback(
    (block: BlockRef) => {
      const c = ctxRef.current;
      if (!c.canEdit) {
        toast.info("This draft can’t be changed", c.readOnlyReason ?? undefined);
        return;
      }
      setSaving(block);
    },
    [toast],
  );
  const review = useCallback((update: PendingModuleUpdate) => setReviewing(update), []);

  /**
   * After a piece is added: the drawer closes, the first question added is
   * opened, and the outcome is said — in a toast when there is nothing to
   * read closely, in a dialog when anything was renamed or dropped.
   */
  const added = useCallback(
    (done: Added) => {
      const c = ctxRef.current;
      setDrawer(null);
      const { outcome } = done;
      const first = outcome.added[0];
      if (first) c.select({ kind: "question", itemKey: first });
      if (outcome.added.length === 0) {
        toast.info("Nothing was added", done.summary.join(" ") || "This survey already has these questions, unchanged.");
        return;
      }
      c.announce(`Added ${plural(outcome.added.length, "question")} from the library.`);
      if (needsReading(outcome)) setResult(done);
      else toast.success("Added from the library", done.summary.join(" ") || `Added ${plural(outcome.added.length, "question")}.`);
    },
    [toast],
  );
  const dismiss = useCallback(
    (update: PendingModuleUpdate) => {
      const c = ctxRef.current;
      const title = modules.get(update.moduleId)?.title ?? update.moduleId;
      const ok = c.run(`Not now: “${title}” v${update.to}`, (d) => dismissModuleUpdate(d, update.importId, update.to).draft);
      if (ok) c.announce(`Version ${update.to} of “${title}” put off. A later version will be offered again.`);
    },
    [modules],
  );

  const value = useMemo<LibraryUi>(
    () => ({ openDrawer, openSave, modules, updates, review, dismiss }),
    [openDrawer, openSave, modules, updates, review, dismiss],
  );

  return (
    <LibraryContext.Provider value={value}>
      {children}
      {drawer ? <LibraryDrawer initialTarget={drawer.target} onClose={() => setDrawer(null)} onAdded={added} /> : null}
      {result ? <InsertResultDialog outcome={result.outcome} summary={result.summary} onClose={() => setResult(null)} /> : null}
      {saving ? <SaveModuleDialog block={saving} onClose={() => setSaving(null)} /> : null}
      {reviewing ? (
        <ModuleUpdateDialog update={reviewing} title={modules.get(reviewing.moduleId)?.title ?? reviewing.moduleId} onClose={() => setReviewing(null)} />
      ) : null}
    </LibraryContext.Provider>
  );
}
