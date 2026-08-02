import { z } from "zod";
import { dottedKey, instrumentRef, semver, sha256, slug, ulid } from "./identifiers.js";
import { logicExpr } from "./logic.js";

/**
 * Draft assessment composition -> immutable release manifest.
 * Drafts are editable with an audit trail; publishing freezes everything and
 * produces a content hash. Nothing about a release is ever edited (docs/06 §3).
 */

export const sectionComponent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("instrument"),
    ref: instrumentRef,
    displayIf: logicExpr.optional(),
    /** Per-component overrides constrained by the instrument's fidelity flags. */
    overrides: z
      .object({
        required: z.enum(["hard", "soft", "optional"]).optional(),
        allowDecline: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("module"),
    ref: instrumentRef, // modules share the instrument reference shape
    displayIf: logicExpr.optional(),
  }),
  z.object({
    kind: z.literal("narrative"),
    protocol: dottedKey,
    protocolVersion: semver,
    displayIf: logicExpr.optional(),
  }),
  z.object({
    kind: z.literal("screen"), // consent / information / transition screens
    screen: slug,
    displayIf: logicExpr.optional(),
  }),
]);

export const section = z.object({
  key: slug,
  title: z.string().min(1),
  /** Participant-facing transition text (age-appropriate, researcher-set). */
  transition: z.string().optional(),
  displayIf: logicExpr.optional(),
  components: z.array(sectionComponent).min(1),
  randomiseComponents: z.boolean().default(false),
});

export const assessmentDraft = z.object({
  key: slug, // "ybm_nd2026_standard"
  study: slug,
  title: z.string().min(1),
  language: z.string().min(2),
  readingLevel: z.enum(["standard", "simplified", "early_reader"]),
  ageBand: z.enum(["8-10", "11-13", "14-16", "17-18", "adult"]),
  allowBackNavigation: z.boolean().default(true),
  resumption: z.enum(["resume_same_device", "restart", "disabled"]).default("resume_same_device"),
  progressIndicator: z.enum(["sections", "none"]).default("sections"),
  /** Format the participant code must match, with a plain-language hint. */
  participantCode: z
    .object({ pattern: z.string(), hint: z.string() })
    .optional(),
  /**
   * Response-effort safeguards. Skipping stays possible — these add
   * deliberation, not obstruction (docs/11 §3).
   */
  effort: z
    .object({
      /** Ask for confirmation before an unanswered item is skipped. */
      confirmSkip: z.boolean().default(true),
      /** Consecutive skips after which a check-in screen is shown. */
      skipRunCheckIn: z.number().int().min(2).default(3),
      /** Seconds on one item before help is quietly offered. */
      dwellHintSeconds: z.number().int().min(5).default(30),
    })
    .default({ confirmSkip: true, skipRunCheckIn: 3, dwellHintSeconds: 30 }),
  offline: z.object({
    surveyOfflineCapable: z.literal(true), // conventional content MUST work offline
    narrativeConnectivity: z.enum(["online_required", "offline_capable_with_queue"]).optional(),
  }),
  sections: z.array(section).min(1),
  screens: z.record(
    slug,
    z.object({
      kind: z.enum(["consent", "assent", "information", "transition", "finish"]),
      body: z.string().min(1),
    }),
  ),
  notes: z.string().optional(),
});

/** Frozen, hashed release manifest. Content-complete: everything a participant
 * can experience is either embedded or content-addressed here. */
export const releaseManifest = z.object({
  manifestVersion: z.literal(1),
  release: z.object({
    key: slug,
    version: semver,
    assessment: slug,
    study: slug,
    publishedAt: z.string().datetime(),
    publishedBy: z.string().min(1),
    engineVersion: z.string().min(1),
    decisionRefs: z.array(z.string()).optional(), // e.g. ["D-01", "D-05"]
  }),
  composition: assessmentDraft,
  /** Embedded frozen definitions, keyed by reference string. */
  instruments: z.record(z.string(), z.unknown()),
  scales: z.record(z.string(), z.unknown()),
  scoring: z.record(z.string(), z.unknown()),
  narrativeProtocols: z.record(z.string(), z.unknown()),
  prompts: z.record(z.string(), z.unknown()),
  modelConfigs: z.record(z.string(), z.unknown()),
  assets: z.record(slug, z.object({ path: z.string(), sha256, bytes: z.number().int() })),
  hash: sha256.optional(), // computed over the JCS form with `hash` absent
});

export const sessionState = z.enum([
  "not_started",
  "in_progress",
  "completed_locally",
  "awaiting_sync",
  "syncing",
  "synced_verified",
  "sync_failed",
  "quarantined",
]);

/** Exclusive response-status taxonomy (docs/06 §4). */
export const responseStatus = z.enum([
  "answered",
  "skipped",
  "declined",
  "not_presented_branching",
  "not_reached_ended",
  "invalid",
  "lost_technical",
  "pending_sync",
]);

export const responseEvent = z.object({
  eventId: ulid,
  sessionId: ulid,
  seq: z.number().int().min(0),
  type: z.enum([
    "item.presented",
    "response.recorded",
    "response.changed",
    "item.skipped",
    "item.declined",
    "navigation.back",
    "section.completed",
    "session.started",
    "session.completed",
    "narrative.stage",
    "hint.shown",
    "skip.confirmed",
    "skip.abandoned",
    "effort.checkin_shown",
    "effort.checkin_returned",
  ]),
  itemRef: z
    .object({ instrument: slug, item: slug, revision: z.number().int().positive() })
    .optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  tWall: z.string().datetime(),
  tMono: z.number(), // monotonic ms since session start
});

export type AssessmentDraft = z.infer<typeof assessmentDraft>;
export type ReleaseManifest = z.infer<typeof releaseManifest>;
export type ResponseEvent = z.infer<typeof responseEvent>;
export type SessionState = z.infer<typeof sessionState>;
export type ResponseStatus = z.infer<typeof responseStatus>;
