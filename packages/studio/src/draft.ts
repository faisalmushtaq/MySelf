import { freezeRelease, refKeyOf, requiredEngineVersion, type Registries } from "@myself/release/gate";
import { releaseManifest, type ItemDefinition, type ReleaseManifest } from "@myself/schema";
import {
  DRAFT_FORMAT,
  DRAFT_FORMAT_VERSION,
  type CompositionInput,
  type InstrumentOrModule,
  type ModuleInput,
  type ScaleInput,
  type ScoringInput,
  type StudioDraft,
} from "./contract.js";

/**
 * Moving between a release and a draft.
 *
 * A draft is what `buildRelease` takes; a release is what it gives back. The
 * two functions here are the only bridge, and they have one property that
 * everything else rests on: `compileDraft(extractDraft(r))`, frozen with r's own
 * metadata, hashes to r's hash. So a researcher who opens the live survey in the
 * Studio and publishes it untouched gets the live survey — not a lookalike
 * whose instruments were silently normalised on the way through.
 */

/** The draft a published release would be edited from. */
export function extractDraft(raw: unknown): StudioDraft {
  const manifest = releaseManifest.parse(raw);
  return {
    format: DRAFT_FORMAT,
    formatVersion: DRAFT_FORMAT_VERSION,
    surveyId: manifest.composition.key,
    composition: structuredClone(manifest.composition),
    instruments: structuredClone(manifest.instruments) as Record<string, InstrumentOrModule>,
    scales: structuredClone(manifest.scales) as Record<string, ScaleInput>,
    scoring: structuredClone(manifest.scoring) as Record<string, ScoringInput>,
    archived: [],
    retiredCodes: {},
    unlocked: {},
    notes: {},
    ...(Object.keys(manifest.assets).length > 0 ? { assets: structuredClone(manifest.assets) } : {}),
  };
}

/**
 * The composition and registries a draft publishes as.
 *
 * Deliberately a straight projection. It does not drop unplaced questions or
 * tidy anything up: a question the editor forgot to place is a validation
 * error the researcher is shown, not something a compiler quietly fixes by
 * leaving it out of the release.
 */
export function compileDraft(draft: StudioDraft): { composition: CompositionInput; registries: Registries } {
  const instruments: Registries["instruments"] = [];
  const modules: Registries["modules"] = [];
  for (const def of Object.values(draft.instruments)) {
    if ((def as { kind?: string }).kind === "module") modules.push(def as ModuleInput);
    else instruments.push(def);
  }
  return {
    composition: draft.composition,
    registries: {
      instruments,
      modules,
      scales: Object.values(draft.scales),
      scoring: Object.values(draft.scoring),
      ...(draft.assets ? { assets: draft.assets } : {}),
    },
  };
}

/**
 * Placeholder metadata for a release that is only being looked at. It is never
 * hashed or stored: the preview renders it and validation reads its gate
 * failures, and the real metadata is stamped on the server at publish time.
 */
export const PREVIEW_META = {
  version: "0.0.0",
  publishedAt: "2000-01-01T00:00:00.000Z",
  publishedBy: "studio-preview",
} as const;

export interface PreviewRelease {
  /** The frozen release, unhashed — exactly what the participant app renders. */
  manifest: ReleaseManifest | null;
  /** Publish-gate refusals, verbatim. */
  failures: string[];
  /** Set when the draft does not even match the schema (what zod said, per field). */
  error: string | null;
}

/** Freeze a draft the way the server would, without hashing it. Never throws. */
export function previewRelease(draft: StudioDraft): PreviewRelease {
  try {
    const { composition, registries } = compileDraft(draft);
    const { body, failures } = freezeRelease(composition, registries, {
      ...PREVIEW_META,
      engineVersion: requiredEngineVersion(composition as { sections: { components: { kind: string }[] }[] }, registries),
    });
    return { manifest: releaseManifest.parse(body), failures, error: null };
  } catch (error) {
    return { manifest: null, failures: [], error: describeError(error) };
  }
}

/** A zod error as "path: message" lines; anything else as its message. */
export function describeError(error: unknown): string {
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] })?.issues;
  if (Array.isArray(issues)) {
    return issues
      .slice(0, 12)
      .map((i) => `${i.path.join(".") || "(draft)"}: ${i.message}`)
      .join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

export class DraftFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftFormatError";
  }
}

/** Read a stored draft, refusing anything that is not one rather than guessing. */
export function parseDraft(json: string): StudioDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new DraftFormatError("The stored draft is not valid JSON.");
  }
  const d = raw as Partial<StudioDraft> | null;
  if (!d || typeof d !== "object" || d.format !== DRAFT_FORMAT) {
    throw new DraftFormatError("The stored document is not a MySelf Studio draft.");
  }
  if (d.formatVersion !== DRAFT_FORMAT_VERSION) {
    throw new DraftFormatError(
      `This draft was saved in format ${String(d.formatVersion)}, which this version of the Studio cannot open.`,
    );
  }
  if (!d.composition || !d.instruments || !d.scales || !d.scoring || typeof d.surveyId !== "string") {
    throw new DraftFormatError("The stored draft is missing part of the survey.");
  }
  return {
    format: DRAFT_FORMAT,
    formatVersion: DRAFT_FORMAT_VERSION,
    surveyId: d.surveyId,
    composition: d.composition,
    instruments: d.instruments,
    scales: d.scales,
    scoring: d.scoring,
    archived: d.archived ?? [],
    retiredCodes: d.retiredCodes ?? {},
    unlocked: d.unlocked ?? {},
    notes: d.notes ?? {},
    ...(d.assets ? { assets: d.assets } : {}),
  };
}

export function serialiseDraft(draft: StudioDraft): string {
  return JSON.stringify(draft);
}

/** The instrument key new Studio questions are written into. */
export function studioModuleKey(study: string): string {
  return `${study}_studio`;
}

/**
 * The survey's own module, for questions written in the Studio.
 *
 * One per survey rather than one per section: a question's ID is
 * `<instrument>.<key>`, so if each section had its own module, moving a question
 * between sections would make it a different question in every export. With one
 * module placed into each section by subset (D-49), a move is only a change of
 * placement and the ID never changes.
 */
export function studioModule(options: {
  study: string;
  language: string;
  ageBand: NonNullable<CompositionInput["ageBand"]>;
  items: ItemDefinition[];
}): ModuleInput {
  return {
    kind: "module",
    study: options.study,
    instrument: studioModuleKey(options.study),
    version: "1.0",
    name: "Study questions",
    construct: "Study-specific questions written in MySelf Studio",
    licence: { status: "open", modifiable: "yes" },
    forms: [
      {
        language: options.language,
        readingLevel: "standard",
        informant: "self",
        label: "Study questions",
        items: options.items,
      },
    ],
    timeEstimates: [{ ageBand: options.ageBand, medianSeconds: 10, provenance: "estimated-heuristic" }],
    changelog: "Written in MySelf Studio.",
    owner: "MySelf Studio",
  };
}

/** The reference a Studio module placement uses. */
export function studioModuleRef(study: string, language: string) {
  return {
    instrument: studioModuleKey(study),
    version: "1.0",
    language,
    informant: "self" as const,
    readingLevel: "standard" as const,
  };
}

/**
 * A new, blank survey: a welcome message, a code to start with, and a thank-you
 * at the end. It validates without errors, so the first thing a researcher sees
 * is a survey that works rather than a list of problems.
 */
export function emptyDraft(options: {
  surveyId: string;
  study: string;
  title: string;
  language?: string;
  ageBand?: NonNullable<CompositionInput["ageBand"]>;
}): StudioDraft {
  const language = options.language ?? "en-GB";
  const ageBand = options.ageBand ?? "adult";
  const ref = studioModuleRef(options.study, language);
  const welcome: ItemDefinition = {
    key: "welcome",
    revision: 1,
    variable: "welcome",
    responseType: "info",
    stem: { text: "Welcome, and thank you for taking part." },
    required: "optional",
    allowDecline: false,
    identifying: false,
  };
  return {
    format: DRAFT_FORMAT,
    formatVersion: DRAFT_FORMAT_VERSION,
    surveyId: options.surveyId,
    composition: {
      key: options.surveyId,
      study: options.study,
      title: options.title,
      language,
      readingLevel: "standard",
      ageBand,
      allowBackNavigation: true,
      participantCode: {
        pattern: "^[A-Za-z0-9]{3,16}$",
        hint: "Letters and numbers, between 3 and 16 characters",
        label: "Your participant code",
        instructions: "Type in the code the research team gave you to begin.",
      },
      offline: { surveyOfflineCapable: true },
      sections: [{ key: "welcome", title: "Welcome", components: [{ kind: "module", ref, items: ["welcome"] }] }],
      screens: {
        finish: {
          kind: "finish",
          title: { text: "Thank you" },
          body: { text: "You've finished — thank you for taking part." },
        },
      },
    },
    instruments: { [refKeyOf(ref)]: studioModule({ study: options.study, language, ageBand, items: [welcome] }) },
    scales: {},
    scoring: {},
    archived: [],
    retiredCodes: {},
    unlocked: {},
    notes: {},
  };
}
