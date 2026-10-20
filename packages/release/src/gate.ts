import {
  assessmentDraft,
  instrumentVersion,
  moduleDefinition,
  responseScale,
  scoringDefinition,
  type AssessmentDraft,
  type InstrumentForm,
  type InstrumentRef,
  type InstrumentVersion,
  type ItemDefinition,
} from "@myself/schema";
import {
  ADAPT_SYSTEM,
  checkProtocol,
  collectionComplete,
  EXTRACTION_SYSTEM,
  INTERVIEWER_SYSTEM,
  keyQuestions,
  keysString,
  narrativeProtocol,
  numberedQuestions,
  oneShot,
  SCENARIO_SYSTEM,
  type NarrativeProtocol,
} from "@myself/narrative";
import { scoringReferenceProblems } from "@myself/scoring";
import type { z } from "zod";

/**
 * The publish gate, and the freeze that follows it — everything about making a
 * release except hashing it.
 *
 * SPLIT FROM builder.ts SO A BROWSER CAN RUN IT. The hash needs node:crypto
 * (synchronously; see canonical.ts), and a module that imports node:crypto
 * cannot be loaded by the Studio. The Studio runs this gate on every edit, so a
 * researcher sees exactly the refusals the server will give before pressing
 * Publish, and the preview renders the frozen body this produces — the same
 * body the server hashes. Nothing here has a side effect or reads a clock.
 */

export interface Registries {
  instruments: z.input<typeof instrumentVersion>[];
  modules: z.input<typeof moduleDefinition>[];
  scales: z.input<typeof responseScale>[];
  scoring: z.input<typeof scoringDefinition>[];
  /**
   * Narrative protocols available for placement. Optional: most releases do
   * not carry one, and a composition that references a protocol without
   * supplying it fails the gate rather than publishing a release that cannot
   * be run.
   */
  narrativeProtocols?: NarrativeProtocol[];
  /**
   * Files items refer to — the postcode list an address question checks
   * against (D-52) — with their content hashes. Only the ones the composition
   * uses are frozen into the release.
   */
  assets?: Record<string, { path: string; sha256: string; bytes: number }>;
}

export interface PublishMeta {
  version: string; // release semver
  publishedAt: string;
  publishedBy: string;
  engineVersion: string;
  decisionRefs?: string[];
}

export class PublishGateError extends Error {
  constructor(public readonly failures: string[]) {
    super(`Publish gate failed with ${failures.length} error(s):\n- ${failures.join("\n- ")}`);
    this.name = "PublishGateError";
  }
}

/**
 * The renderer capability a composition needs (D-49).
 *
 * 0.1.0 is every release up to r7.1.0. 0.2.0 adds component `items` subsets,
 * `age_gte` conditions (D-51) and postcode-checked address fields (D-52). 0.3.0
 * adds what D-53 needs: a street search beside the postcode check, numbered
 * rows with bands, consent that moves on by itself, an "I understand" label on
 * an information screen, and a confirmation for a number above a threshold.
 * 0.4.0 adds MyStory run from the protocol frozen into the release: the survey
 * sends the module that exact protocol (docs/16 §10.1). A build before it would
 * open the module with only a protocol key, and the module would run its own
 * bundled copy of that protocol — or nothing, for one edited in the Studio.
 * 0.5.0 adds the time grid: minutes for each option chosen at an earlier
 * question, on one screen. A build before it has no control for the type and
 * would show the question with nothing to answer it with.
 * The participant app refuses a release that needs more than it can render and
 * keeps running the one it has, so a feature can never reach a device that
 * would show it as a blank screen.
 */
export const ENGINE_VERSIONS = ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"] as const;

export function requiredEngineVersion(
  composition: { sections: { components: { kind: string; items?: unknown }[] }[] },
  registries?: { instruments?: unknown; modules?: unknown; assets?: Record<string, unknown> },
): string {
  // Only definitions the composition places: a library handed in whole holds
  // grids that no release of this composition would ever show.
  const placed = new Set(
    composition.sections.flatMap((s) => s.components.map((c) => (c as { ref?: { instrument?: string } }).ref?.instrument)),
  );
  const usesTimeGrid = [...defsOf(registries?.instruments), ...defsOf(registries?.modules)]
    .filter((def) => placed.has((def as { instrument?: string } | null)?.instrument))
    .flatMap((def) => itemsOf([def]))
    .some((item) => item["responseType"] === "time_grid");
  if (usesTimeGrid) return "0.5.0";
  if (composition.sections.some((s) => s.components.some((c) => c.kind === "narrative"))) return "0.4.0";
  const usesSubsets = composition.sections.some((s) =>
    s.components.some((c) => (c.kind === "instrument" || c.kind === "module") && Array.isArray(c.items)),
  );
  const definitions = JSON.stringify([composition, registries?.instruments ?? null, registries?.modules ?? null]);
  if (itemsOf(registries?.instruments).some(needsD53) || itemsOf(registries?.modules).some(needsD53)) return "0.3.0";
  const usesAge = definitions.includes('"op":"age_gte"');
  const usesPostcodes = Object.keys(registries?.assets ?? {}).length > 0 || definitions.includes('"postcodeCheck":');
  return usesSubsets || usesAge || usesPostcodes ? "0.2.0" : "0.1.0";
}

/** The definitions in a registry, given as a list or keyed by reference. */
function defsOf(defs: unknown): unknown[] {
  return Array.isArray(defs) ? defs : defs && typeof defs === "object" ? Object.values(defs) : [];
}

/** Every question in a registry of definitions, given as a list or keyed by reference. */
function itemsOf(defs: unknown): Record<string, unknown>[] {
  const list = defsOf(defs);
  return list.flatMap((def) =>
    ((def as { forms?: { items?: unknown[] }[] } | null)?.forms ?? []).flatMap((form) =>
      (form.items ?? []).filter((item): item is Record<string, unknown> => !!item && typeof item === "object"),
    ),
  );
}

/**
 * A question using what engine 0.3.0 added (D-53). By type: `autoAdvance` on a
 * single choice is older than D-53; on a checkbox list it is new.
 */
function needsD53(item: Record<string, unknown>): boolean {
  switch (item["responseType"]) {
    case "form_fields":
      return item["streetCheck"] !== undefined;
    case "single_choice":
      return item["presentation"] === "numbered";
    case "checkbox_set":
      return item["autoAdvance"] !== undefined;
    case "info":
      return item["advanceLabel"] !== undefined;
    case "numeric":
      return item["confirmAbove"] !== undefined;
    default:
      return false;
  }
}

/** -1 / 0 / 1, numerically by MAJOR.MINOR.PATCH. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The string a frozen instrument is keyed by in `manifest.instruments`. */
export function refKeyOf(ref: {
  instrument: string;
  version: string;
  variant?: string | undefined;
  language: string;
  informant?: string | undefined;
  readingLevel?: string | undefined;
}): string {
  const informant = ref.informant ?? "self";
  const readingLevel = ref.readingLevel ?? "standard";
  return `${ref.instrument}@${ref.version}${ref.variant ? `+${ref.variant}` : ""}/${ref.language}/${informant}/${readingLevel}`;
}

/** The form a reference resolves to, by the same rule the builder has always used. */
export function formFor(def: { forms: InstrumentForm[] }, ref: InstrumentRef): InstrumentForm | undefined {
  return def.forms.find(
    (f) =>
      f.language === ref.language &&
      (f.variant ?? undefined) === (ref.variant ?? undefined) &&
      f.readingLevel === ref.readingLevel &&
      f.informant === ref.informant,
  );
}

/**
 * The questions a placement shows, in the order it shows them: the component's
 * `items` subset if it has one, the whole form otherwise. Keys the form does not
 * have are reported through `missing` rather than dropped silently.
 */
export function administeredItems(
  form: InstrumentForm,
  items: string[] | undefined,
): { items: ItemDefinition[]; missing: string[]; repeated: string[] } {
  if (!items) return { items: form.items, missing: [], repeated: [] };
  const byKey = new Map(form.items.map((i) => [i.key, i]));
  const seen = new Set<string>();
  const out: ItemDefinition[] = [];
  const missing: string[] = [];
  const repeated: string[] = [];
  for (const key of items) {
    if (seen.has(key)) {
      repeated.push(key);
      continue;
    }
    seen.add(key);
    const item = byKey.get(key);
    if (item) out.push(item);
    else missing.push(key);
  }
  return { items: out, missing, repeated };
}

/** Every item reference a logic expression depends on. */
function logicTargets(expr: unknown, out: string[] = []): string[] {
  if (!expr || typeof expr !== "object") return out;
  const e = expr as Record<string, unknown>;
  if (Array.isArray(e["args"])) for (const a of e["args"]) logicTargets(a, out);
  if (e["arg"]) logicTargets(e["arg"], out);
  const target = e["target"] as { item?: { instrument: string; item: string } } | undefined;
  if (target?.item) out.push(`${target.item.instrument}.${target.item.item}`);
  return out;
}

/**
 * Dependency audit.
 *
 * A question that branches on an answer given later can never fire — the
 * condition is evaluated against an empty answer, so the item silently
 * disappears from every session and nobody notices until the data comes back
 * short. The same goes for a cross-check against a question asked afterwards,
 * or an age limit derived from a date of birth collected later.
 *
 * All of these are structural mistakes in the composition, not runtime
 * problems, so they belong here: a release that contains one cannot be
 * published at all.
 *
 * The order audited is the ADMINISTERED order — placements' `items` subsets
 * included — because that is the order a participant meets the questions in.
 */
function auditDependencies(
  draft: AssessmentDraft,
  instruments: InstrumentVersion[],
  modules: InstrumentVersion[],
): string[] {
  const failures: string[] = [];
  /** Item key -> position in the administered order. */
  const position = new Map<string, number>();
  /** Every dependency, with where it was declared and what it needs. */
  const deps: { at: number; owner: string; needs: string; why: string }[] = [];
  let n = 0;

  for (const section of draft.sections) {
    for (const component of section.components) {
      if (component.kind === "narrative" || component.kind === "screen") continue;
      const defs = component.kind === "instrument" ? instruments : modules;
      const def = defs.find((d) => d.instrument === component.ref.instrument && d.version === component.ref.version);
      const form = def ? formFor(def, component.ref) : undefined;
      if (!form) continue; // already reported by the resolution checks

      for (const item of administeredItems(form, component.items).items) {
        const key = `${component.ref.instrument}.${item.key}`;
        position.set(key, n);
        // A section- or component-level condition binds at the position of the
        // first item it governs, which is where it is first evaluated.
        for (const target of logicTargets(section.displayIf)) {
          deps.push({ at: n, owner: key, needs: target, why: `section '${section.key}' condition` });
        }
        for (const target of logicTargets(component.displayIf)) {
          deps.push({ at: n, owner: key, needs: target, why: "component condition" });
        }
        for (const target of logicTargets(item.displayIf)) {
          deps.push({ at: n, owner: key, needs: target, why: "display condition" });
        }
        for (const check of item.crossChecks ?? []) {
          deps.push({
            at: n,
            owner: key,
            needs: `${check.against.instrument}.${check.against.item}`,
            why: `cross-check '${check.kind}'`,
          });
        }
        if (item.responseType === "time_grid") {
          deps.push({
            at: n,
            owner: key,
            needs: `${item.rowsFrom.instrument}.${item.rowsFrom.item}`,
            why: "time grid rows",
          });
        }
        if (item.responseType === "single_choice" && item.limitOptions) {
          deps.push({
            at: n,
            owner: key,
            needs: `${item.limitOptions.from.instrument}.${item.limitOptions.from.item}`,
            why: `option limit '${item.limitOptions.kind}'`,
          });
        }
        n += 1;
      }
    }
  }

  for (const dep of deps) {
    const target = position.get(dep.needs);
    if (target === undefined) {
      failures.push(`${dep.owner}: ${dep.why} refers to '${dep.needs}', which is not in this release`);
    } else if (target >= dep.at) {
      failures.push(
        `${dep.owner}: ${dep.why} depends on '${dep.needs}', which is asked later (position ${target} vs ${dep.at})`,
      );
    }
  }
  return failures;
}

/** Longest export variable name (Stata's limit), as `variableName` enforces. */
const MAX_VARIABLE_LENGTH = 32;

/**
 * Time grids. Where the rows come from has to be a question that can give
 * them — a sorting question and one of its groups, or a multiple choice — and
 * every row's variable (`<variable>_<code>`) has to be a usable, unique name.
 * Whether the source is asked before the grid is the dependency audit's.
 */
function auditTimeGrids(
  draft: AssessmentDraft,
  instruments: InstrumentVersion[],
  modules: InstrumentVersion[],
  scales: Map<string, { options: { code: number; kind: string }[] }>,
): string[] {
  const failures: string[] = [];
  const placed = new Map<string, ItemDefinition>();
  const variables = new Set<string>();
  for (const section of draft.sections) {
    for (const component of section.components) {
      if (component.kind === "narrative" || component.kind === "screen") continue;
      const defs = component.kind === "instrument" ? instruments : modules;
      const def = defs.find((d) => d.instrument === component.ref.instrument && d.version === component.ref.version);
      const form = def ? formFor(def, component.ref) : undefined;
      for (const item of form?.items ?? []) {
        placed.set(`${component.ref.instrument}.${item.key}`, item);
        variables.add(item.variable);
      }
    }
  }
  for (const [key, item] of placed) {
    if (item.responseType !== "time_grid") continue;
    const from = item.rowsFrom;
    const source = placed.get(`${from.instrument}.${from.item}`);
    if (!source) continue; // reported by the dependency audit
    if (source.revision !== from.revision) {
      failures.push(`${key}: rows come from revision ${from.revision} of '${from.instrument}.${from.item}', but this release has revision ${source.revision}`);
    }
    if (source.responseType === "rank_group") {
      if (!from.group) failures.push(`${key}: rows from a sorting question need the group whose options become rows`);
      else if (!source.groups.some((g) => g.key === from.group)) {
        failures.push(`${key}: rows come from group '${from.group}', which '${from.instrument}.${from.item}' does not have`);
      }
    } else if (source.responseType === "multi_choice") {
      if (from.group) failures.push(`${key}: a multiple-choice question has no groups, so the rows cannot come from '${from.group}'`);
    } else {
      failures.push(`${key}: rows must come from a sorting or multiple-choice question; '${from.instrument}.${from.item}' is ${source.responseType}`);
      continue;
    }
    const scale = scales.get(source.scale);
    if (!scale) continue; // reported as an unresolved scale
    const rows = scale.options.filter((o) => o.kind === "substantive" || o.kind === "other_specify");
    if (rows.length === 0) failures.push(`${key}: '${from.instrument}.${from.item}' has no options that could be a row`);
    for (const o of rows) {
      const name = `${item.variable}_${o.code}`;
      if (name.length > MAX_VARIABLE_LENGTH) {
        failures.push(`${key}: row variable '${name}' is longer than ${MAX_VARIABLE_LENGTH} characters; shorten '${item.variable}'`);
      }
      if (variables.has(name)) failures.push(`${key}: row variable '${name}' is already another question's variable`);
    }
  }
  return failures;
}

/**
 * The prompts a protocol will actually send, assembled at publish time.
 *
 * The protocol carries the researcher's configuration and the module carries
 * the templates; neither on its own is what went to the provider. Assembling
 * them here means the release answers "what was this child's interviewer told
 * to do?" directly, instead of requiring someone to re-derive it years later
 * from a template and a config that have both moved on.
 *
 * Session variables — `{topic}`, `{participant_words}` — are deliberately left
 * standing. They are resolved per participant, and a release that pretended to
 * know their values would be lying about what is fixed.
 */
function freezePrompts(protocol: NarrativeProtocol): Record<string, unknown> {
  const frozen: Record<string, unknown> = {};
  const at = (key: string, system: string, notes?: Record<string, unknown>) => {
    frozen[`${key}@${protocol.version}`] = {
      key,
      version: protocol.version,
      protocol: protocol.key,
      system,
      ...(notes ?? {}),
    };
  };

  if (protocol.interview) {
    at(
      "pt.interviewer",
      INTERVIEWER_SYSTEM.replace("{persona}", protocol.interview.persona)
        .replace("{language_style}", protocol.interview.languageStyle)
        .replace("{topic_restriction}", protocol.interview.topicRestriction)
        .replace("{questions}", numberedQuestions(protocol.interview.questions))
        .replace("{collection_complete}", collectionComplete(protocol.interview.questions.length)),
      { maxTurns: protocol.interview.maxTurns },
    );
  }
  if (protocol.extraction) {
    const keys = protocol.extraction.keys;
    at(
      "pt.extraction",
      EXTRACTION_SYSTEM.replace("{keys_string}", keysString(Object.keys(keys))).replace("{questions}", keyQuestions(keys)),
      { keys },
    );
  }
  if (protocol.scenario) {
    // One per persona, keyed by name: three personas are three different
    // instructions, and which one produced a given retelling is part of the
    // record. An index would stop meaning anything if a wave reordered them.
    protocol.scenario.personas.forEach((persona, index) => {
      at(
        `pt.scenario.${persona.key}`,
        SCENARIO_SYSTEM.replace("{persona}", persona.text).replace("{one_shot}", oneShot(protocol)),
        { persona: persona.key, index },
      );
    });
    at("pt.adapt", ADAPT_SYSTEM);
  }

  // The open stages carry their own templates rather than the method's.
  for (const stage of protocol.stages) {
    if (stage.prompt) {
      frozen[`${stage.prompt.key}@${stage.prompt.version}`] = {
        ...stage.prompt,
        protocol: protocol.key,
        stage: stage.key,
        ...(stage.outputSchema ? { outputSchema: stage.outputSchema } : {}),
      };
    }
  }
  return frozen;
}

/** A release before it is hashed: exactly what `contentHash` is computed over. */
export interface ManifestBody {
  manifestVersion: 1;
  release: {
    key: string;
    version: string;
    assessment: string;
    study: string;
    publishedAt: string;
    publishedBy: string;
    engineVersion: string;
    decisionRefs?: string[];
  };
  composition: AssessmentDraft;
  instruments: Record<string, unknown>;
  scales: Record<string, unknown>;
  scoring: Record<string, unknown>;
  narrativeProtocols: Record<string, unknown>;
  prompts: Record<string, unknown>;
  modelConfigs: Record<string, unknown>;
  assets: Record<string, { path: string; sha256: string; bytes: number }>;
}

/**
 * Run the publish gate and freeze the release body.
 *
 * Returns the failures instead of throwing, so the Studio can list every
 * problem at once; `buildRelease` throws them as a `PublishGateError`. The
 * body is only meaningful when `failures` is empty.
 *
 * Throws only when the inputs do not match the schema at all (a zod error),
 * which the Studio's own validation reports field by field before this runs.
 */
export function freezeRelease(
  draftInput: z.input<typeof assessmentDraft>,
  registries: Registries,
  meta: PublishMeta,
): { body: ManifestBody; failures: string[] } {
  const draft = assessmentDraft.parse(draftInput);
  const instruments = registries.instruments.map((i) => instrumentVersion.parse(i));
  const modules = registries.modules.map((m) => moduleDefinition.parse(m));
  const scales = registries.scales.map((s) => responseScale.parse(s));
  const scoring = registries.scoring.map((s) => scoringDefinition.parse(s));

  const protocolRegistry = registries.narrativeProtocols ?? [];

  const failures: string[] = [];
  const frozenInstruments: Record<string, unknown> = {};
  const frozenScales: Record<string, unknown> = {};
  const frozenScoring: Record<string, unknown> = {};
  const frozenProtocols: Record<string, unknown> = {};
  const frozenPrompts: Record<string, unknown> = {};
  const frozenModelConfigs: Record<string, unknown> = {};
  const scaleByKey = new Map(scales.map((s) => [s.key, s]));
  const scoringByKey = new Map(scoring.map((s) => [s.key, s]));
  const seenVariables = new Map<string, string>();
  const frozenAssets: Record<string, { path: string; sha256: string; bytes: number }> = {};
  /** Question ID -> the section that first administers it. */
  const administered = new Map<string, string>();

  for (const section of draft.sections) {
    for (const component of section.components) {
      if (component.kind === "narrative") {
        const supplied = protocolRegistry.find(
          (p) => p.key === component.protocol && p.version === component.protocolVersion,
        );
        if (!supplied) {
          failures.push(
            `unresolved narrative protocol '${component.protocol}@${component.protocolVersion}' in section '${section.key}'`,
          );
          continue;
        }
        // Checked against the schema first, and frozen as the schema reads it.
        // A protocol edited in the Studio arrives as data, not as one of the
        // module's own constants, and a malformed one must be a refusal here —
        // not an exception from deep inside the checks below. The module parses
        // what it is sent with the same schema, so the release holds exactly
        // what will run, every default spelled out.
        const parsed = narrativeProtocol.safeParse(supplied);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          failures.push(
            `narrative protocol '${component.protocol}@${component.protocolVersion}' does not match the protocol format (${issue?.path.join(".") || "protocol"}: ${issue?.message ?? "invalid"})`,
          );
          continue;
        }
        const protocol = parsed.data;
        // The protocol's own publish gate, run here rather than trusted: a
        // release is the last point at which a prompt that leaks a name, or a
        // stage that would show a child a blank screen, can still be stopped.
        for (const problem of checkProtocol(protocol)) {
          failures.push(`narrative protocol '${protocol.key}': ${problem}`);
        }
        if (protocol.approvalStatus !== "approved") {
          failures.push(
            `narrative protocol '${protocol.key}' is '${protocol.approvalStatus}' — only an approved protocol can be fielded`,
          );
        }
        // Model stages need the network. A composition that promises the whole
        // survey works offline, and then places a protocol that cannot fall
        // back, has promised something it cannot do.
        if (
          draft.offline.narrativeConnectivity === "offline_capable_with_queue" &&
          protocol.offlineFallback === "pause_module"
        ) {
          failures.push(
            `narrative protocol '${protocol.key}' pauses when offline, but section '${section.key}' is composed as offline-capable`,
          );
        }
        frozenProtocols[`${protocol.key}@${protocol.version}`] = protocol;
        Object.assign(frozenPrompts, freezePrompts(protocol));
        for (const model of protocol.models) frozenModelConfigs[model.key] = model;
        continue;
      }
      if (component.kind === "screen") continue;

      const ref = component.ref;
      const defs = component.kind === "instrument" ? instruments : modules;
      const def = defs.find((d) => d.instrument === ref.instrument && d.version === ref.version);
      if (!def) {
        failures.push(`unresolved ${component.kind} reference '${ref.instrument}@${ref.version}' in section '${section.key}'`);
        continue;
      }
      const form = formFor(def, ref);
      if (!form) {
        failures.push(
          `no form of '${ref.instrument}@${ref.version}' matches language=${ref.language} variant=${ref.variant ?? "none"} readingLevel=${ref.readingLevel}`,
        );
        continue;
      }

      // Which questions this placement administers. A subset that names a
      // question the form lacks, or names one twice, is a composition mistake;
      // so is a question administered in two places, which would put two
      // answers in one export cell with the later silently winning.
      const placed = administeredItems(form, component.items);
      for (const key of placed.missing) {
        failures.push(`section '${section.key}' places '${ref.instrument}.${key}', which is not a question of '${ref.instrument}'`);
      }
      for (const key of placed.repeated) {
        failures.push(`section '${section.key}' lists '${ref.instrument}.${key}' twice in one placement`);
      }
      for (const item of placed.items) {
        const id = `${ref.instrument}.${item.key}`;
        const first = administered.get(id);
        if (first !== undefined) {
          failures.push(`'${id}' is administered more than once (sections '${first}' and '${section.key}')`);
        } else {
          administered.set(id, section.key);
        }
      }

      for (const item of form.items) {
        const owner = seenVariables.get(item.variable);
        if (owner && owner !== ref.instrument) {
          failures.push(`duplicate variable '${item.variable}' (in '${owner}' and '${ref.instrument}')`);
        }
        seenVariables.set(item.variable, ref.instrument);

        if ("scale" in item) {
          const scale = scaleByKey.get(item.scale);
          if (!scale) {
            failures.push(`unresolved scale '${item.scale}' on ${ref.instrument}/${item.key}`);
          } else {
            frozenScales[item.scale] = scale;
            // Bands drawn under a numbered row must each cover real options and
            // not overlap, or the picture would group numbers that don't exist.
            const codes = new Set(scale.options.map((o) => o.code));
            const banded = new Set<number>();
            for (const band of scale.bands ?? []) {
              for (let c = band.from; c <= band.to; c += 1) {
                if (!codes.has(c)) failures.push(`${item.scale}: band '${band.label}' covers ${c}, which is not an option`);
                if (banded.has(c)) failures.push(`${item.scale}: ${c} is in more than one band`);
                banded.add(c);
              }
            }
            if (item.responseType === "single_choice" && item.presentation === "numbered" && !scale.bands?.length) {
              failures.push(`${ref.instrument}/${item.key}: a numbered row needs its scale's bands`);
            }
          }
        }
        if (item.responseType === "form_fields" && item.postcodeCheck) {
          const check = item.postcodeCheck;
          const asset = registries.assets?.[check.asset];
          if (!asset) failures.push(`${ref.instrument}/${item.key}: postcode list '${check.asset}' is not among the release's assets`);
          else frozenAssets[check.asset] = asset;
          if (!item.fields.some((f) => f.key === check.field)) {
            failures.push(`${ref.instrument}/${item.key}: postcode check names field '${check.field}', which the item does not have`);
          }
        }
        if (item.responseType === "form_fields" && item.streetCheck) {
          const check = item.streetCheck;
          const asset = registries.assets?.[check.asset];
          if (!asset) failures.push(`${ref.instrument}/${item.key}: street list '${check.asset}' is not among the release's assets`);
          else frozenAssets[check.asset] = asset;
          if (!item.fields.some((f) => f.key === check.field)) {
            failures.push(`${ref.instrument}/${item.key}: street check names field '${check.field}', which the item does not have`);
          }
          // Offered to someone who says they don't know their postcode, so it
          // only makes sense beside a postcode check (D-53).
          if (!item.postcodeCheck) failures.push(`${ref.instrument}/${item.key}: a street check needs a postcode check beside it`);
          for (const k of [check.areaKey, check.districtKey]) {
            if (item.fields.some((f) => f.key === k)) {
              failures.push(`${ref.instrument}/${item.key}: street check records '${k}', which is already a field`);
            }
          }
          if (check.areaKey === check.districtKey) failures.push(`${ref.instrument}/${item.key}: street check records area and district under one key`);
        }
        if (item.responseType === "numeric" && item.confirmAbove !== undefined) {
          const { confirmAbove: above, min, max } = item;
          if ((min !== undefined && above < min) || (max !== undefined && above >= max)) {
            failures.push(`${ref.instrument}/${item.key}: confirmAbove ${above} is outside the item's range`);
          }
        }
        const pipes = item.stem.pipes ?? {};
        for (const [name, pipe] of Object.entries(pipes)) {
          if (!item.stem.text.includes(`{${name}}`)) {
            failures.push(`pipe '${name}' declared but placeholder absent on ${ref.instrument}/${item.key}`);
          }
          if (pipe.kind === "item_text_entry" && !pipe.item) {
            failures.push(`pipe '${name}' on ${ref.instrument}/${item.key} lacks an item reference`);
          }
        }
        for (const match of item.stem.text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
          if (!(match[1]! in pipes)) {
            failures.push(`unresolved placeholder '{${match[1]}}' on ${ref.instrument}/${item.key}`);
          }
        }
      }

      frozenInstruments[refKeyOf(ref)] = { ...def, forms: [form] }; // freeze only the administered form

      if (def.scoringKey) {
        const sd = scoringByKey.get(def.scoringKey);
        if (!sd) failures.push(`scoring definition '${def.scoringKey}' for '${ref.instrument}' not found`);
        else {
          frozenScoring[def.scoringKey] = sd;
          // A definition that names an item the form does not have scores nothing,
          // silently, for every sitting (D-49): refuse it here instead.
          if (sd.instrument !== ref.instrument) {
            failures.push(`scoring definition '${sd.key}' is for '${sd.instrument}', not '${ref.instrument}'`);
          }
          for (const problem of scoringReferenceProblems(sd, form.items)) {
            failures.push(`scoring definition '${sd.key}': ${problem}`);
          }
        }
      }
    }
  }

  const sectionKeys = draft.sections.map((s) => s.key);
  if (new Set(sectionKeys).size !== sectionKeys.length) failures.push("duplicate section keys");

  failures.push(...auditDependencies(draft, instruments, modules));
  failures.push(...auditTimeGrids(draft, instruments, modules, scaleByKey));

  // A release must say what it needs to be rendered, and must not claim less:
  // a device that believed it could render a subset-using release would show
  // every question of the instrument in every placement.
  const needed = requiredEngineVersion(draft, { instruments: frozenInstruments, assets: frozenAssets });
  if (compareVersions(meta.engineVersion, needed) < 0) {
    failures.push(`this composition needs engine ${needed}, but the release declares engine ${meta.engineVersion}`);
  }

  const body: ManifestBody = {
    manifestVersion: 1 as const,
    release: {
      key: `${draft.key}_r${meta.version.replaceAll(".", "_")}`,
      version: meta.version,
      assessment: draft.key,
      study: draft.study,
      publishedAt: meta.publishedAt,
      publishedBy: meta.publishedBy,
      engineVersion: meta.engineVersion,
      ...(meta.decisionRefs ? { decisionRefs: meta.decisionRefs } : {}),
    },
    composition: draft,
    instruments: frozenInstruments,
    scales: frozenScales,
    scoring: frozenScoring,
    narrativeProtocols: frozenProtocols,
    prompts: frozenPrompts,
    modelConfigs: frozenModelConfigs,
    assets: frozenAssets,
  };
  return { body, failures };
}
