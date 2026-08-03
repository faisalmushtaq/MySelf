import { z } from "zod";
import { dottedKey, itemRef, slug } from "./identifiers.js";

/**
 * Branching / display logic as a small, total, side-effect-free expression AST.
 * No arbitrary code (this is what replaces Qualtrics display logic and the
 * flow branch). Evaluation is implemented once in @myself/engine and reused
 * verbatim on device and server.
 */

const answerTarget = z.object({
  /** The item whose current answer is tested. */
  item: itemRef,
  /** For multi-part items: option code, form-field key, or group name. */
  part: z.union([z.number().int(), z.string()]).optional(),
});

export type LogicExpr =
  | { op: "all"; args: LogicExpr[] }
  | { op: "any"; args: LogicExpr[] }
  | { op: "not"; arg: LogicExpr }
  | { op: "answered"; target: z.infer<typeof answerTarget> }
  | { op: "not_empty"; target: z.infer<typeof answerTarget> }
  | { op: "selected"; target: z.infer<typeof answerTarget>; code: number }
  | { op: "not_selected"; target: z.infer<typeof answerTarget>; code: number }
  | { op: "in_group"; target: z.infer<typeof answerTarget>; group: string; code: number }
  | { op: "eq"; target: z.infer<typeof answerTarget>; value: number | string }
  | { op: "ne"; target: z.infer<typeof answerTarget>; value: number | string }
  | { op: "gt"; target: z.infer<typeof answerTarget>; value: number }
  | { op: "gte"; target: z.infer<typeof answerTarget>; value: number }
  | { op: "lt"; target: z.infer<typeof answerTarget>; value: number }
  | { op: "lte"; target: z.infer<typeof answerTarget>; value: number };

export const logicExpr: z.ZodType<LogicExpr> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("all"), args: z.array(logicExpr).min(1) }),
    z.object({ op: z.literal("any"), args: z.array(logicExpr).min(1) }),
    z.object({ op: z.literal("not"), arg: logicExpr }),
    z.object({ op: z.literal("answered"), target: answerTarget }),
    z.object({ op: z.literal("not_empty"), target: answerTarget }),
    z.object({ op: z.literal("selected"), target: answerTarget, code: z.number().int() }),
    z.object({ op: z.literal("not_selected"), target: answerTarget, code: z.number().int() }),
    z.object({
      op: z.literal("in_group"),
      target: answerTarget,
      group: z.string().min(1),
      code: z.number().int(),
    }),
    z.object({ op: z.literal("eq"), target: answerTarget, value: z.union([z.number(), z.string()]) }),
    z.object({ op: z.literal("ne"), target: answerTarget, value: z.union([z.number(), z.string()]) }),
    z.object({ op: z.literal("gt"), target: answerTarget, value: z.number() }),
    z.object({ op: z.literal("gte"), target: answerTarget, value: z.number() }),
    z.object({ op: z.literal("lt"), target: answerTarget, value: z.number() }),
    z.object({ op: z.literal("lte"), target: answerTarget, value: z.number() }),
  ]),
) as z.ZodType<LogicExpr>;

/** Piped-text reference: only validated identifiers, never raw strings. */
export const pipeRef = z.object({
  /**
   * `score` resolves a scoring output for the current session — the value or
   * its band label — so a participant can be told something about what they
   * just answered. The scorer runs over the answers already given; nothing is
   * stored differently and the raw responses are untouched (D-33).
   */
  kind: z.enum(["item_answer", "item_text_entry", "session_field", "date_offset", "score"]),
  /** For `score`: the scoring definition, e.g. "score.ehi_sf". */
  scoringKey: dottedKey.optional(),
  /** For `score`: which output of it, e.g. "lq" or "lq_band". */
  output: slug.optional(),
  /** For a numeric score output: decimal places to show. */
  decimals: z.number().int().min(0).max(3).optional(),
  item: itemRef.optional(),
  part: z.union([z.number().int(), z.string()]).optional(),
  /** e.g. session start date + N days (YBM consent withdrawal deadline). */
  offsetDays: z.number().int().optional(),
  field: z.enum(["session_start_date", "participant_code", "study_name"]).optional(),
  /**
   * Text to use when the pipe cannot be resolved — the answer was skipped,
   * lost, or not reached. Without one, a participant sees the raw placeholder,
   * which is worse than saying nothing. Write the surrounding sentence so it
   * reads naturally with the fallback in place.
   */
  fallback: z.string().optional(),
});

export type PipeRef = z.infer<typeof pipeRef>;
