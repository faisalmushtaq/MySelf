import {
  checkProtocol,
  narrativeProtocol,
  parseProtocolFile,
  protocols as builtInProtocols,
  protocolToToml,
  type NarrativeProtocol,
} from "@myself/narrative";
import { canonicalJson, dottedKey, semver } from "@myself/schema";
import type { CompositionInput, StudioDraft } from "./contract.js";

/**
 * MyStory in a survey (docs/16 §10.1): whether it is on, which protocol it
 * runs, and where it sits.
 *
 * It is one setting for the whole survey. On, the survey's last section is
 * MyStory's own, holding exactly one narrative component, and the draft carries
 * that protocol's whole definition. So a participant meets the survey, then
 * MyStory, then the finish screen, and the device goes back to the researcher
 * only after that. The outline, the operations, validation and the diff all ask
 * here whether MyStory is on and where it is, so they can never disagree.
 *
 * Read-only: `setMyStory` (ops.ts) is the one operation that switches it.
 */

/** The key MyStory's section is given, unless another section already has it. */
export const MYSTORY_SECTION_KEY = "mystory";
/** What participants see as the section's title in the progress bar. */
export const MYSTORY_TITLE = "MyStory";

/** `key@version`: the one name a protocol has, for good. */
export function protocolId(p: { key: string; version: string }): string {
  return `${p.key}@${p.version}`;
}

type Section = CompositionInput["sections"][number];

export interface MyStoryPlacement {
  sectionIndex: number;
  sectionKey: string;
  componentIndex: number;
  /** The protocol's key, e.g. "np.phone_wellbeing". */
  protocol: string;
  version: string;
  /** `key@version`. */
  id: string;
  /** The definition the draft carries for it, or null when it carries none. */
  definition: NarrativeProtocol | null;
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Whether a section is MyStory's own: it holds a conversation and nothing else. */
export function isMyStorySection(section: Section | undefined | null): boolean {
  const components = list<{ kind?: unknown }>(section?.components);
  return components.length > 0 && components.every((c) => c?.kind === "narrative");
}

/** The definition a draft carries under an id (own properties only). */
export function draftProtocol(draft: StudioDraft, id: string): NarrativeProtocol | null {
  const registry = draft.narrativeProtocols;
  return registry && Object.prototype.hasOwnProperty.call(registry, id) ? registry[id]! : null;
}

/** Every narrative component in the draft, in order. A well-formed draft has none or one. */
export function narrativePlacements(draft: StudioDraft): MyStoryPlacement[] {
  const out: MyStoryPlacement[] = [];
  list<Section>(draft.composition?.sections).forEach((section, sectionIndex) => {
    list<Section["components"][number]>(section?.components).forEach((component, componentIndex) => {
      if (component?.kind !== "narrative") return;
      const id = protocolId({ key: component.protocol, version: component.protocolVersion });
      out.push({
        sectionIndex,
        sectionKey: section.key,
        componentIndex,
        protocol: component.protocol,
        version: component.protocolVersion,
        id,
        definition: draftProtocol(draft, id),
      });
    });
  });
  return out;
}

/** MyStory as the survey has it, or null when it is off. */
export function myStoryOf(draft: StudioDraft): MyStoryPlacement | null {
  return narrativePlacements(draft)[0] ?? null;
}

export type MyStoryMisplacement = "more_than_one" | "not_alone" | "not_last";

/**
 * What is wrong with where MyStory is, or null when it is where it belongs: in
 * the last section, on its own, once. Null too when it is off.
 */
export function myStoryMisplaced(draft: StudioDraft): MyStoryMisplacement | null {
  const placed = narrativePlacements(draft);
  if (placed.length === 0) return null;
  if (placed.length > 1) return "more_than_one";
  const sections = list<Section>(draft.composition.sections);
  const at = placed[0]!;
  if (!isMyStorySection(sections[at.sectionIndex])) return "not_alone";
  if (at.sectionIndex !== sections.length - 1) return "not_last";
  return null;
}

// ---------------------------------------------------------------------------
// Reading and checking a protocol
// ---------------------------------------------------------------------------

/**
 * What stops a protocol that reads being MyStory's: its own publish checks
 * (`checkProtocol`, the same the release gate runs), and a key and version a
 * survey can name. Approval is not here: a protocol still being approved can
 * be tried in a draft and previewed, and only publishing refuses it.
 */
export function protocolProblems(protocol: NarrativeProtocol): string[] {
  const problems = [...checkProtocol(protocol)];
  if (!dottedKey.safeParse(protocol.key).success) {
    problems.push(`its key “${protocol.key}” can't name a protocol in a survey: use lowercase letters, numbers and underscores, as in np.my_study`);
  }
  if (!semver.safeParse(protocol.version).success) {
    problems.push(`its version “${protocol.version}” must be three numbers, such as 1.0.0 (version in [myself])`);
  }
  return problems;
}

export interface ProtocolReading {
  /** The protocol, when the text reads as one. */
  protocol: NarrativeProtocol | null;
  /**
   * Why it can't be used, in words: the file does not read as a protocol, or
   * it does and its checks fail. Empty when it can be used.
   */
  problems: string[];
}

/** What a thrown parse error says, one problem per line. */
function errorLines(error: unknown): string[] {
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] } | null)?.issues;
  if (Array.isArray(issues)) {
    return issues.slice(0, 12).map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));
  }
  return [error instanceof Error ? error.message : String(error)];
}

/**
 * A protocol file (TOML, the format the MyStory lab and the protocol editor
 * read and write), read and checked the way the editor shows it as it is typed.
 */
export function readProtocolText(text: string): ProtocolReading {
  if (!text.trim()) return { protocol: null, problems: ["The protocol file is empty."] };
  let protocol: NarrativeProtocol;
  try {
    protocol = parseProtocolFile(text, "protocol.toml");
  } catch (error) {
    return { protocol: null, problems: errorLines(error) };
  }
  return { protocol, problems: protocolProblems(protocol) };
}

/**
 * A protocol as its TOML file, or null for one the file format cannot express:
 * the shorter protocols have stages it has no field for, and writing one
 * anyway would produce a file that quietly ran a different study. Those are
 * used as they are.
 */
export function protocolToml(protocol: NarrativeProtocol): string | null {
  try {
    return protocolToToml(protocol);
  } catch {
    return null;
  }
}

/** The protocols MySelf ships with (`@myself/narrative`). */
export const BUILT_IN_PROTOCOLS: readonly NarrativeProtocol[] = builtInProtocols;

/** A protocol in the one form its content is compared in: as the schema reads it. */
function contentOf(protocol: unknown): string {
  const parsed = narrativeProtocol.safeParse(protocol);
  return canonicalJson(parsed.success ? parsed.data : (protocol ?? null));
}

/** Whether two protocol definitions say the same thing, defaults spelled out or not. */
export function sameProtocol(a: unknown, b: unknown): boolean {
  return contentOf(a) === contentOf(b);
}

/**
 * Whether a protocol's `key@version` already names a different protocol:
 * "published" when a published version of this survey froze other content
 * under it, "built_in" when a protocol MySelf ships has it with other content.
 *
 * A key and version name one protocol for good. Analyses years later read a
 * MyStory run through the `key@version` it was recorded under; two contents
 * under one name would make that name mean whichever was looked up first. An
 * edited protocol therefore needs a new version. What a published version
 * froze decides, when there is one: republishing exactly that is never a clash.
 */
export function protocolClash(protocol: unknown, published?: ReadonlyMap<string, unknown>): "published" | "built_in" | null {
  const parsed = narrativeProtocol.safeParse(protocol);
  if (!parsed.success) return null;
  const id = protocolId(parsed.data);
  const mine = canonicalJson(parsed.data);
  if (published?.has(id)) return contentOf(published.get(id)) === mine ? null : "published";
  const builtIn = BUILT_IN_PROTOCOLS.find((p) => protocolId(p) === id);
  return builtIn && contentOf(builtIn) !== mine ? "built_in" : null;
}

/**
 * The next version of a protocol that names nothing yet: the patch number up
 * from `version` until no built-in protocol, published version or `taken` id
 * has it. "0.1.0" becomes "0.1.1".
 */
export function nextProtocolVersion(
  protocol: { key: string; version: string },
  published?: ReadonlyMap<string, unknown>,
  taken: Iterable<string> = [],
): string {
  const used = new Set<string>([...BUILT_IN_PROTOCOLS.map(protocolId), ...(published?.keys() ?? []), ...taken]);
  const [major = 0, minor = 0, patch = 0] = protocol.version.split(".").map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
  for (let p = patch + 1; ; p++) {
    const version = `${major}.${minor}.${p}`;
    if (!used.has(protocolId({ key: protocol.key, version }))) return version;
  }
}

/**
 * A protocol file with its version changed, everything else as it was typed:
 * the `version` line in `[myself]` is rewritten, or added when there is none.
 */
export function withProtocolVersion(text: string, version: string): string {
  const lines = text.split("\n");
  const header = lines.findIndex((l) => /^\s*\[myself\]\s*(#.*)?$/.test(l));
  const line = `version = "${version}"`;
  if (header < 0) return `${text.replace(/\n*$/, "")}\n\n[myself]\n${line}\n`;
  for (let i = header + 1; i < lines.length && !/^\s*\[/.test(lines[i]!); i++) {
    const match = /^(\s*)version\s*=/.exec(lines[i]!);
    if (match) {
      lines[i] = `${match[1]}${line}`;
      return lines.join("\n");
    }
  }
  lines.splice(header + 1, 0, line);
  return lines.join("\n");
}
