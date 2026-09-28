import {
  ALLOWED_FIELDS_BY_TIER,
  editTier,
  fieldAllowed,
  identityRoleOf,
  instrumentDef,
  isUnlocked,
  protectedModule,
  type EditTier,
  type ItemField,
  type ProtectedModule,
  type StudioDraft,
  type Unlock,
} from "@myself/studio";
import type { ItemDefinition } from "@myself/schema";

/**
 * Why part of a survey can't be changed, said before anyone tries.
 *
 * Every lock the Studio enforces is shown where it applies — a banner on the
 * question or block saying what it is, why it is fixed and what can still
 * change — and every control the model would refuse is shown read-only, never
 * as an input that fails. The words here are the banner's.
 */

/** Plain names for the question fields a locked questionnaire may still change. */
const FIELD_WORDS: Partial<Record<ItemField, string>> = {
  required: "required",
  allowDecline: "‘Prefer not to say’",
  hint: "help text",
  presentation: "presentation",
  a11yNote: "notes",
  researcherNote: "notes",
  reportingCategory: "reporting category",
};

/** "required, ‘Prefer not to say’, help text, presentation, notes and reporting category". */
export function allowedWords(tier: "locked" | "protected"): string {
  const words: string[] = [];
  for (const field of ALLOWED_FIELDS_BY_TIER[tier]) {
    const word = FIELD_WORDS[field];
    if (word && !words.includes(word)) words.push(word);
  }
  // Coding notes are the Studio's own and never part of a release, so they can always change.
  if (!words.includes("notes")) words.push("notes");
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? "");
}

export interface QuestionLock {
  tier: EditTier;
  instrument: string;
  /** The instrument's short name ("SDQ"), else its name. */
  shortName: string;
  name: string;
  /** The protected module's reason, whether or not it is unlocked now. */
  protection: ProtectedModule | null;
  unlocked: Unlock | null;
  /** "linkage": makes the participant code; "identity": separated from research data by its variable. */
  identityRole: "linkage" | "identity" | null;
  published: boolean;
}

export function questionLock(draft: StudioDraft, itemKey: string, item: ItemDefinition, published: ReadonlySet<string>): QuestionLock {
  const instrument = itemKey.slice(0, itemKey.indexOf("."));
  const def = instrumentDef(draft, instrument)?.def;
  return {
    tier: editTier(draft, instrument),
    instrument,
    name: def?.name ?? instrument,
    shortName: def?.abbreviation ?? def?.name ?? instrument,
    protection: protectedModule(instrument),
    unlocked: isUnlocked(draft, instrument) ? (draft.unlocked[instrument] ?? null) : null,
    identityRole: identityRoleOf(itemKey, item),
    published: published.has(itemKey),
  };
}

/** Whether a question field can be changed at all, under the tier alone. */
export function tierAllows(lock: Pick<QuestionLock, "tier">, field: string): boolean {
  return fieldAllowed(lock.tier, field);
}

export interface BannerText {
  title: string;
  body: string;
}

/** The banner for a licensed questionnaire's question. */
export function lockedBanner(lock: QuestionLock): BannerText {
  return {
    title: `From the ${lock.shortName}, a licensed questionnaire`,
    body: `Its wording, options and order can't be changed: they are fixed by its licence and by the evidence it was validated on. You can change: ${allowedWords("locked")}.`,
  };
}

/** The banner for a protected module, before it is unlocked. */
export function protectedBanner(protection: ProtectedModule): BannerText {
  return protection.reason === "ethics"
    ? {
        title: "Part of the ethics-approved consent",
        body: "To edit it you must confirm the change is covered by the ethics approval. The confirmation is kept with the survey's history.",
      }
    : {
        title: "Part of the participant identifiers",
        body: "These questions link one person's sittings together and keep names and dates of birth out of the research data. To edit them you must confirm the change is safe for participant linkage.",
      };
}

/** What an identity question keeps fixed, whatever the module's lock. */
export function identityText(role: "linkage" | "identity", variable: string): string {
  return role === "linkage"
    ? "Makes up the participant code — its key, type, options and variable can never change."
    : `Its answer is kept apart from the research data by its reporting label, “${variable}” — its ID, type and reporting label can never change.`;
}

/** Why a question's ID or reporting label can't change, or null when it can. */
export function identifierLock(lock: QuestionLock, what: "ID" | "reporting label"): string | null {
  if (lock.identityRole === "linkage") return `The participant code is found by this question's ${what}, so it can never change.`;
  if (lock.identityRole === "identity") return `Identity capture finds this question by its ${what}, so it can never change.`;
  if (lock.published) {
    return `Published: answers are already stored under this ${what}, so it can't change. To ask something different, replace the question with a new one.`;
  }
  if (lock.tier === "locked") return `Part of a licensed questionnaire: its ${what}s are fixed.`;
  if (lock.tier === "protected") return `Part of a protected module. Unlock it to change this.`;
  return null;
}

/** Why a question's type can't change, or null when it can (a published question is offered a replacement instead). */
export function typeLock(lock: QuestionLock): string | null {
  if (lock.tier === "locked") return "Part of a licensed questionnaire: its question types are fixed.";
  if (lock.tier === "protected") return "Part of a protected module. Unlock it to change this question's type.";
  if (lock.identityRole === "linkage") return "The participant code is built from this answer, so its type can never change.";
  if (lock.identityRole === "identity") return "Identity capture reads this answer as it is, so its type can never change.";
  return null;
}
