import {
  assessmentDraft,
  instrumentVersion,
  moduleDefinition,
  releaseManifest,
  responseScale,
  scoringDefinition,
  type ReleaseManifest,
} from "@myself/schema";
import {
  ADAPT_SYSTEM,
  checkProtocol,
  collectionComplete,
  EXTRACTION_SYSTEM,
  INTERVIEWER_SYSTEM,
  keyQuestions,
  keysString,
  numberedQuestions,
  oneShot,
  SCENARIO_SYSTEM,
  type NarrativeProtocol,
} from "@myself/narrative";
import { scoringReferenceProblems } from "@myself/scoring";
import type { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";

/**
 * Release builder + publish gate. Resolves a draft composition against the
 * library registries, runs the gate checks, and freezes everything into a
 * content-hashed manifest. Publishing NEVER mutates inputs; a manifest is
 * immutable once hashed (docs/06 §3).
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

const BLOCKED_LICENCES = new Set(["permission_required", "blocked"]);

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
 */
function auditDependencies(
  draft: z.infer<typeof assessmentDraft>,
  instruments: Registries["instruments"],
  modules: Registries["modules"],
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
      const form = def?.forms.find(
        (f) =>
          f.language === component.ref.language &&
          (f.variant ?? undefined) === (component.ref.variant ?? undefined) &&
          f.readingLevel === component.ref.readingLevel &&
          f.informant === component.ref.informant,
      );
      if (!form) continue; // already reported by the resolution checks above

      for (const item of form.items) {
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

export function buildRelease(
  draftInput: z.input<typeof assessmentDraft>,
  registries: Registries,
  meta: PublishMeta,
): ReleaseManifest {
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

  for (const section of draft.sections) {
    for (const component of section.components) {
      if (component.kind === "narrative") {
        const protocol = protocolRegistry.find(
          (p) => p.key === component.protocol && p.version === component.protocolVersion,
        );
        if (!protocol) {
          failures.push(
            `unresolved narrative protocol '${component.protocol}@${component.protocolVersion}' in section '${section.key}'`,
          );
          continue;
        }
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
      if (BLOCKED_LICENCES.has(def.licence.status)) {
        failures.push(`licence gate: '${ref.instrument}' has status '${def.licence.status}'`);
      }
      const form = def.forms.find(
        (f) =>
          f.language === ref.language &&
          (f.variant ?? undefined) === (ref.variant ?? undefined) &&
          f.readingLevel === ref.readingLevel &&
          f.informant === ref.informant,
      );
      if (!form) {
        failures.push(
          `no form of '${ref.instrument}@${ref.version}' matches language=${ref.language} variant=${ref.variant ?? "none"} readingLevel=${ref.readingLevel}`,
        );
        continue;
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

      const refKey = `${ref.instrument}@${ref.version}${ref.variant ? `+${ref.variant}` : ""}/${ref.language}/${ref.informant}/${ref.readingLevel}`;
      frozenInstruments[refKey] = { ...def, forms: [form] }; // freeze only the administered form

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

  if (failures.length > 0) throw new PublishGateError(failures);

  const manifestBody = {
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

  const hash = contentHash(manifestBody);
  return releaseManifest.parse({ ...manifestBody, hash });
}

export function verifyManifestHash(manifest: ReleaseManifest): boolean {
  const { hash, ...body } = manifest;
  return hash !== undefined && contentHash(body) === hash;
}

export { canonicalJson, contentHash };
