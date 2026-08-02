import { z } from "zod";
import { dottedKey, semver, slug } from "./identifiers.js";

/**
 * Narrative protocol schema — generalisation of the KCL Micro-narratives app
 * (Skeggs et al., CHI 2025; see docs/08). The MVP ships np.micro_narrative
 * (decision D-15): guided collect -> extraction -> persona scenarios ->
 * select -> rate -> adapt -> confirm.
 */

export const promptTemplate = z.object({
  key: dottedKey, // e.g. "pt.micro_narrative.interviewer"
  version: semver,
  role: z.enum(["interviewer", "extractor", "scenario", "adaptation", "custom"]),
  template: z.string().min(1),
  /** Placeholders that MAY appear; resolution fails on anything undeclared. */
  variables: z.array(slug),
  notes: z.string().optional(),
});

export const modelConfig = z.object({
  key: dottedKey,
  provider: z.enum(["openai", "anthropic", "mock"]),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  topP: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
  /** Provider data-governance flags, recorded per config (docs/08 §6). */
  dataRetention: z.object({
    providerRetains: z.boolean(),
    usedForTraining: z.boolean(),
    region: z.string().optional(),
  }),
});

export const safeguardingRule = z.object({
  key: slug,
  description: z.string().min(1),
  tier: z.enum(["data_quality_flag", "team_notification", "safeguarding_review", "emergency_procedure"]),
  method: z.enum(["lexicon", "classifier", "manual"]),
  config: z.record(z.string(), z.unknown()).optional(),
  reviewers: z.array(z.string()).optional(),
  participantDisclosure: z.string().min(1), // wording shown/approved; must not imply real-time monitoring
});

export const offlineBehaviour = z.enum([
  "queue_authorised",
  "continue_without_model",
  "predefined_fallback",
  "pause_module",
]);

export const narrativeProtocol = z.object({
  key: dottedKey, // "np.micro_narrative"
  version: semver,
  name: z.string().min(1),
  construct: z.string().min(1),
  intendedUse: z.string().min(1),
  ageRange: z.object({ min: z.number().int(), max: z.number().int() }),
  language: z.string().min(2),
  readingLevel: z.enum(["standard", "simplified", "early_reader"]),

  /** Participant-facing content. */
  introduction: z.string().min(1),
  /** Guided interview questions asked one at a time by the interviewer stage. */
  questions: z.array(z.string().min(1)).min(1),
  example: z.string().optional(),
  practiceRequest: z.string().optional(),
  minResponseChars: z.number().int().min(0).default(0),
  maxResponseChars: z.number().int().positive().default(5000),
  responseModes: z.array(z.enum(["text", "audio"])).min(1).default(["text"]),
  transitions: z.record(z.string(), z.string()).optional(), // researcher-authored between-stage text
  debrief: z.string().optional(),

  /** Model stages. */
  interviewerPersona: z.string().min(1),
  languageStyle: z.string().min(1),
  topicRestriction: z.string().min(1),
  extractionKeys: z.record(slug, z.string().min(1)), // key -> question, CHI-2025 style
  scenarioPersonas: z.array(z.object({ key: slug, description: z.string().min(1) })).min(1),
  oneShot: z.object({ conversation: z.string().min(1), scenario: z.string().min(1) }).optional(),
  prompts: z.array(z.object({ role: z.string(), key: dottedKey, version: semver })).min(1),
  systemInstructions: z.string().min(1),
  modelConfigKey: dottedKey,
  /** JSON Schema (as object) each model stage's output must validate against. */
  outputSchemas: z.record(z.string(), z.record(z.string(), z.unknown())),

  /** Participant control stages. */
  selectionRequired: z.boolean().default(true),
  ratingScale: z.object({ min: z.number().int(), max: z.number().int() }).default({ min: 0, max: 10 }),
  adaptationEnabled: z.boolean().default(true),
  confirmationRequired: z.boolean().default(true),

  /** Quality control (typing-trace design carried over; docs/08 §8.2). */
  qualityControl: z
    .object({
      enabled: z.boolean().default(false),
      pasteRatioThreshold: z.number().min(0).max(1).default(0.3),
      typingSpeedThreshold: z.number().positive().default(15),
      longMessageChars: z.number().int().positive().default(250),
    })
    .optional(),

  safeguarding: z.array(safeguardingRule),
  connectivity: z.enum(["online_required", "offline_capable_with_queue"]),
  offlineBehaviour,
  fallbackText: z.string().optional(), // required when offlineBehaviour = predefined_fallback

  estimatedSeconds: z.number().positive(),
  consentRequirements: z.string().min(1),
  dataGovernanceNote: z.string().min(1),
  owner: z.string().min(1),
  approvalStatus: z.enum(["draft", "in_review", "approved", "retired"]).default("draft"),
  changelog: z.string().min(1),
});

export type NarrativeProtocol = z.infer<typeof narrativeProtocol>;
export type PromptTemplate = z.infer<typeof promptTemplate>;
export type ModelConfig = z.infer<typeof modelConfig>;
