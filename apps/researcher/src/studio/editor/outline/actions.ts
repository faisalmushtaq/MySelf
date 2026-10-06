import {
  editTier,
  findQuestion,
  identityRoleOf,
  instrumentDef,
  instrumentName,
  isUnlocked,
  protectedModule,
  restoreQuestion,
  splitItemKey,
  type EditTier,
  type Outline,
  type StudioDraft,
} from "@myself/studio";
import type { IconName } from "../../ui/icons.js";
import { applyMove, keyboardBlockMove, keyboardQuestionMove, keyboardSectionMove, type ComponentCounts, type MoveOp } from "./dnd.js";
import type { TreeNode } from "./model.js";

/**
 * What each row's "…" menu offers, and why anything is greyed out.
 *
 * The rule is the one the model's operations enforce (ops.ts), asked through
 * the same functions (`editTier`, `identityRoleOf`, the published set), so the
 * menu never offers something the operation would then refuse. Where an
 * action is not available the item stays in the menu, disabled, with the
 * reason — a missing "Delete" leaves a researcher wondering whether they have
 * missed it; a disabled one that says "Published — archive it instead" does not.
 */

export type ActionId =
  | "rename"
  | "add-question"
  | "add-question-after"
  | "add-from-library"
  | "add-section-after"
  | "duplicate"
  | "move-up"
  | "move-down"
  | "move-to-section"
  | "archive"
  | "delete"
  | "remove-section"
  | "remove-block"
  | "save-to-library"
  | "restore"
  | "restore-into"
  | "delete-archived";

export interface ActionSpec {
  id: ActionId;
  label: string;
  icon: IconName;
  /** Why the action is not available; absent when it is. */
  disabled?: string;
  danger?: boolean;
}

export interface ActionFacts {
  draft: StudioDraft;
  outline: Outline;
  counts: ComponentCounts;
  /** Question IDs any version has published. */
  published: ReadonlySet<string>;
}

/**
 * The model's own refusal of an operation, or undefined when it goes through.
 *
 * REVIEW FIX: the tier checks below are the common reasons, but not the only
 * ones. Moving anything in front of the ethics-protected consent
 * (ops `keepConsentFirst`) is refused too — "Move section up" on the section
 * just after "Welcome", or "Move up" on a question added to the Welcome
 * section — and restoring can be refused (a clashing variable, a section that
 * has gone). The menu offered those and the click ended in an error toast.
 * Moves and restores are now tried on a copy (the operations never change the
 * draft they are given) and disabled with the model's own words when refused.
 */
function refusalOf(attempt: () => unknown): string | undefined {
  try {
    attempt();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function moveRefusal(draft: StudioDraft, move: MoveOp | null, atEnd: string): string | undefined {
  return move ? refusalOf(() => applyMove(draft, move)) : atEnd;
}

/** Why a question of a non-editable instrument can't be changed this way, in a sentence. */
function tierReason(draft: StudioDraft, instrument: string, tier: EditTier, what: "move" | "copy" | "archive" | "delete"): string {
  // Short: a menu may show several of these at once, one under each item.
  if (tier === "locked") {
    switch (what) {
      case "move":
        return "A licensed questionnaire’s questions stay in their validated order. Move the whole block instead.";
      case "copy":
        return "Nothing can be added to a licensed questionnaire.";
      default:
        return "A licensed questionnaire is only valid asked whole. Remove the whole block instead.";
    }
  }
  return `“${instrumentName(draft, instrument)}” is protected. Select its block and unlock it first.`;
}

export function questionActions(itemKey: string, facts: ActionFacts): ActionSpec[] {
  const { draft, outline } = facts;
  const found = findQuestion(draft, itemKey);
  if (!found) return [];
  const tier = editTier(draft, found.instrument);
  const role = identityRoleOf(itemKey, found.item);
  const published = facts.published.has(itemKey);
  const moveReason = tier === "editable" ? undefined : tierReason(draft, found.instrument, tier, "move");
  const up = keyboardQuestionMove(outline, itemKey, -1);
  const down = keyboardQuestionMove(outline, itemKey, 1);
  const linkage =
    role === "linkage" ? "One of the four questions the participant code is built from: ingest finds it by this ID, so it stays." : undefined;

  const archive: ActionSpec = { id: "archive", label: "Archive…", icon: "archive" };
  if (tier !== "editable") archive.disabled = tierReason(draft, found.instrument, tier, "archive");
  else if (linkage) archive.disabled = linkage;

  const del: ActionSpec = { id: "delete", label: "Delete…", icon: "trash", danger: true };
  // REVIEW FIX: "Archive instead" was given first, even for a licensed or
  // participant-code question whose Archive item (just above) is disabled
  // too — advice the menu itself refuses. It is given only where archiving
  // is actually open.
  if (tier !== "editable") del.disabled = tierReason(draft, found.instrument, tier, "delete");
  else if (linkage) del.disabled = linkage;
  else if (published) {
    del.disabled = "Archive instead: it has been published, so answers may already be recorded against it. Archiving keeps them readable.";
  }

  return [
    {
      id: "add-question-after",
      // REVIEW FIX: after a licensed or protected question the new one goes after the whole block (addQuestion).
      label: tier === "editable" ? "Add a question after this" : "Add a question after this block",
      icon: "plus",
    },
    {
      id: "duplicate",
      label: "Duplicate",
      icon: "copy",
      ...(tier === "editable" ? {} : { disabled: tierReason(draft, found.instrument, tier, "copy") }),
    },
    { id: "move-up", label: "Move up", icon: "arrow-up", ...disabledIf(moveReason ?? moveRefusal(draft, up, "Already the first question in the survey.")) },
    { id: "move-down", label: "Move down", icon: "arrow-down", ...disabledIf(moveReason ?? moveRefusal(draft, down, "Already the last question in the survey.")) },
    { id: "move-to-section", label: "Move to section…", icon: "section", ...disabledIf(moveReason) },
    archive,
    del,
  ];
}

function disabledIf(reason: string | undefined): { disabled?: string } {
  return reason ? { disabled: reason } : {};
}

/** The protected module in a section, if any: a section holding one keeps its place (ops `moveSection`). */
function protectedIn(draft: StudioDraft, sectionKey: string): string | null {
  const section = draft.composition.sections.find((s) => s.key === sectionKey);
  for (const c of section?.components ?? []) {
    if ((c.kind === "instrument" || c.kind === "module") && editTier(draft, c.ref.instrument) === "protected") return c.ref.instrument;
  }
  return null;
}

export function sectionActions(sectionKey: string, facts: ActionFacts): ActionSpec[] {
  const { draft, outline } = facts;
  const section = draft.composition.sections.find((s) => s.key === sectionKey);
  if (!section) return [];
  const guarded = protectedIn(draft, sectionKey);
  const fixed = guarded
    ? `It holds “${instrumentName(draft, guarded)}”, which is protected, so its place is fixed until that is unlocked.`
    : undefined;
  const remove: ActionSpec = { id: "remove-section", label: "Delete section…", icon: "trash", danger: true };
  if (section.components.length > 0) remove.disabled = "Only an empty section can be deleted. Move its questions elsewhere or archive them first.";
  else if (draft.composition.sections.length === 1) remove.disabled = "A survey needs at least one section.";
  return [
    { id: "rename", label: "Rename", icon: "section" },
    { id: "add-question", label: "Add a question here", icon: "plus" },
    { id: "add-from-library", label: "Add from library…", icon: "library" },
    { id: "add-section-after", label: "Add a section after this", icon: "plus" },
    {
      id: "move-up",
      label: "Move section up",
      icon: "arrow-up",
      ...disabledIf(fixed ?? moveRefusal(draft, keyboardSectionMove(outline, sectionKey, -1), "Already the first section.")),
    },
    {
      id: "move-down",
      label: "Move section down",
      icon: "arrow-down",
      ...disabledIf(fixed ?? moveRefusal(draft, keyboardSectionMove(outline, sectionKey, 1), "Already the last section.")),
    },
    remove,
  ];
}

export function blockActions(sectionKey: string, componentIndex: number, facts: ActionFacts): ActionSpec[] {
  const { draft, outline, counts } = facts;
  const block = outline.sections.find((s) => s.key === sectionKey)?.blocks.find((b) => b.componentIndex === componentIndex);
  if (!block) return [];
  const tier = editTier(draft, block.instrument);
  const fixed = tier === "protected" ? `“${block.name}” is protected. Unlock it first (select the block) to move or remove it.` : undefined;
  const remove: ActionSpec = { id: "remove-block", label: "Remove block…", icon: "archive", danger: true };
  if (fixed) remove.disabled = fixed;
  else if (block.questions.some((q) => identityRoleOf(q.itemKey, { variable: "" }) === "linkage")) {
    remove.disabled = "It holds the questions the participant code is built from, so it stays.";
  }
  return [
    { id: "add-question-after", label: "Add a question after this block", icon: "plus", ...disabledIf(block.questions.length === 0 ? "This block has no questions to add after." : undefined) },
    { id: "save-to-library", label: "Save to library…", icon: "library", ...disabledIf(saveRefusal(draft, block.instrument, tier, block.questions.length)) },
    {
      id: "move-up",
      label: "Move block up",
      icon: "arrow-up",
      ...disabledIf(fixed ?? moveRefusal(draft, keyboardBlockMove(outline, counts, sectionKey, componentIndex, -1), "Already at the start of the survey.")),
    },
    {
      id: "move-down",
      label: "Move block down",
      icon: "arrow-down",
      ...disabledIf(fixed ?? moveRefusal(draft, keyboardBlockMove(outline, counts, sectionKey, componentIndex, 1), "Already at the end of the survey.")),
    },
    { id: "move-to-section", label: "Move block to section…", icon: "section", ...disabledIf(fixed) },
    remove,
  ];
}

/**
 * Why a block can't be saved to the library (docs/16 §12.6): only editable
 * content can. A validated questionnaire is a shelf of its own already, and
 * the consent and identity modules belong to their study, unlocked or not.
 */
export function saveRefusal(draft: StudioDraft, instrument: string, tier: EditTier, questionCount: number): string | undefined {
  if (protectedModule(instrument)) return `“${instrumentName(draft, instrument)}” belongs to this study’s ethics approval, so it isn’t saved to the library.`;
  if (tier === "locked") return "A validated questionnaire is in the library already, exactly as licensed.";
  if (questionCount === 0) return "This block has no questions to save.";
  return undefined;
}

/**
 * The tier an archived question's instrument has — its live definition's if
 * the draft still has one, otherwise the definition archived with it (mirrors
 * ops.ts `archivedTier`, which is not exported).
 */
export function archivedTierOf(draft: StudioDraft, itemKey: string): EditTier {
  const record = draft.archived.find((a) => a.itemKey === itemKey);
  const { instrument } = splitItemKey(itemKey);
  if (instrumentDef(draft, instrument)) return editTier(draft, instrument);
  const shell = record?.instrumentShell ?? draft.archived.find((a) => a.refKey === record?.refKey && a.instrumentShell)?.instrumentShell;
  if (shell && shell.licence.modifiable !== "yes") return "locked";
  return protectedModule(instrument) && !isUnlocked(draft, instrument) ? "protected" : "editable";
}

export function archivedActions(itemKey: string, facts: ActionFacts): ActionSpec[] {
  const { draft } = facts;
  const tier = archivedTierOf(draft, itemKey);
  const { instrument } = splitItemKey(itemKey);
  const del: ActionSpec = { id: "delete-archived", label: "Delete permanently…", icon: "trash", danger: true };
  if (facts.published.has(itemKey)) {
    del.disabled = "It has been published, so it stays archived: its ID stays reserved and its answers stay readable.";
  } else if (tier === "locked") {
    del.disabled = "Part of a licensed questionnaire, which comes back whole when restored, so none of it can be deleted.";
  } else if (tier === "protected") {
    del.disabled = `“${instrumentName(draft, instrument)}” is protected. Unlock it first.`;
  }
  const restoreBlocked = tier === "protected" ? `“${instrumentName(draft, instrument)}” is protected. Unlock it first.` : undefined;
  return [
    {
      id: "restore",
      label: tier === "locked" ? "Restore (brings back the whole questionnaire)" : "Restore",
      icon: "restore",
      ...disabledIf(restoreBlocked ?? refusalOf(() => restoreQuestion(draft, itemKey))),
    },
    { id: "restore-into", label: "Restore into section…", icon: "section", ...disabledIf(restoreBlocked) },
    del,
  ];
}

/** The menu for any row; empty for rows with no actions (add rows, the archive group). */
export function actionsFor(node: TreeNode, facts: ActionFacts): ActionSpec[] {
  switch (node.kind) {
    case "question":
      return node.question ? questionActions(node.question.itemKey, facts) : [];
    case "section":
      return node.section ? sectionActions(node.section.key, facts) : [];
    case "block":
      return node.block ? blockActions(node.block.sectionKey, node.block.componentIndex, facts) : [];
    case "archived":
      return node.archived ? archivedActions(node.archived.itemKey, facts) : [];
    default:
      return [];
  }
}
