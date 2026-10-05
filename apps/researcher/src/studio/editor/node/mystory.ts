import type { NarrativeProtocol } from "@myself/narrative";
import {
  BUILT_IN_PROTOCOLS,
  nextProtocolVersion,
  protocolClash,
  protocolId,
  protocolProblems,
  protocolToml,
  readProtocolText,
  type MyStoryPlacement,
} from "@myself/studio";

/**
 * What the MyStory editor shows about a protocol, worked out without React so
 * it can be tested: which protocols there are to start from, and whether the
 * one on screen can be used — said in words, as it is typed (docs/16 §10.1).
 */

/** The choice that is the survey's own protocol, as opposed to a built-in one. */
export const SURVEY_PROTOCOL = "survey";

export interface ProtocolChoice {
  value: string;
  label: string;
  protocol: NarrativeProtocol;
  /** The protocol as its file, or null for one a file cannot express (used as it is). */
  toml: string | null;
}

/** The survey's own protocol first, when it has one, then every built-in protocol. */
export function protocolChoices(story: MyStoryPlacement | null): ProtocolChoice[] {
  const out: ProtocolChoice[] = [];
  if (story?.definition) {
    out.push({
      value: SURVEY_PROTOCOL,
      label: `This survey's: ${story.definition.name} (${story.id})`,
      protocol: story.definition,
      toml: protocolToml(story.definition),
    });
  }
  for (const p of BUILT_IN_PROTOCOLS) {
    out.push({ value: protocolId(p), label: `Built in: ${p.name} (${protocolId(p)})`, protocol: p, toml: protocolToml(p) });
  }
  return out;
}

export interface ProtocolCheck {
  /** The protocol, when what is on screen reads as one. */
  protocol: NarrativeProtocol | null;
  /** Why it can't be used, in words. Empty when it can. */
  problems: string[];
  /**
   * Its `key@version` already names a different protocol — published, or
   * built in — and the version to give it instead.
   */
  clash: { where: "published" | "built_in"; next: string } | null;
  approved: boolean;
}

function assess(protocol: NarrativeProtocol | null, problems: string[], published?: ReadonlyMap<string, unknown>): ProtocolCheck {
  const where = protocol && problems.length === 0 ? protocolClash(protocol, published) : null;
  return {
    protocol,
    problems,
    clash: protocol && where ? { where, next: nextProtocolVersion(protocol, published) } : null,
    approved: protocol?.approvalStatus === "approved",
  };
}

/** A protocol file, as typed, checked against what has been published. */
export function checkProtocolFile(text: string, published?: ReadonlyMap<string, unknown>): ProtocolCheck {
  const reading = readProtocolText(text);
  return assess(reading.protocol, reading.problems, published);
}

/** A protocol used as it is (one a file cannot express), checked the same way. */
export function checkProtocolAsIs(protocol: NarrativeProtocol, published?: ReadonlyMap<string, unknown>): ProtocolCheck {
  return assess(protocol, protocolProblems(protocol), published);
}

/** Plain words for a protocol's approval status. */
export function approvalWords(status: NarrativeProtocol["approvalStatus"] | null | undefined): string {
  if (status === "approved") return "Approved";
  if (status === "in_review") return "In review, not yet approved";
  if (status === "draft") return "Draft, not yet approved";
  return "Unknown";
}

/** The name a protocol file is saved under. */
export function protocolFilename(protocol: Pick<NarrativeProtocol, "key" | "version"> | null): string {
  return protocol ? `${protocol.key.replace(/^np\./, "")}-${protocol.version}.toml` : "protocol.toml";
}
