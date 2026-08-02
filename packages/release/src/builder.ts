import {
  assessmentDraft,
  instrumentVersion,
  moduleDefinition,
  releaseManifest,
  responseScale,
  scoringDefinition,
  type ReleaseManifest,
} from "@myself/schema";
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

  const failures: string[] = [];
  const frozenInstruments: Record<string, unknown> = {};
  const frozenScales: Record<string, unknown> = {};
  const frozenScoring: Record<string, unknown> = {};
  const scaleByKey = new Map(scales.map((s) => [s.key, s]));
  const scoringByKey = new Map(scoring.map((s) => [s.key, s]));
  const seenVariables = new Map<string, string>();

  for (const section of draft.sections) {
    for (const component of section.components) {
      if (component.kind === "narrative") {
        failures.push(`narrative components not yet supported by this builder (section '${section.key}')`);
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
        else frozenScoring[def.scoringKey] = sd;
      }
    }
  }

  const sectionKeys = draft.sections.map((s) => s.key);
  if (new Set(sectionKeys).size !== sectionKeys.length) failures.push("duplicate section keys");

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
    narrativeProtocols: {},
    prompts: {},
    modelConfigs: {},
    assets: {},
  };

  const hash = contentHash(manifestBody);
  return releaseManifest.parse({ ...manifestBody, hash });
}

export function verifyManifestHash(manifest: ReleaseManifest): boolean {
  const { hash, ...body } = manifest;
  return hash !== undefined && contentHash(body) === hash;
}

export { canonicalJson, contentHash };
