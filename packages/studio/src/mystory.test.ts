import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { microNarrative, narrativeProtocol, phoneWellbeing, type NarrativeProtocol } from "@myself/narrative";
import { buildRelease } from "@myself/release";
import { canonicalJson } from "@myself/schema";
import type { StudioDraft } from "./contract.js";
import { diffDrafts } from "./diff.js";
import { compileDraft, extractDraft, parseDraft, previewRelease, serialiseDraft } from "./draft.js";
import { publishedProtocols } from "./history.js";
import { CONSENT_MODULES, outline, StudioOpError } from "./model.js";
import {
  myStoryMisplaced,
  myStoryOf,
  nextProtocolVersion,
  protocolClash,
  protocolToml,
  readProtocolText,
  withProtocolVersion,
} from "./mystory.js";
import * as ops from "./ops.js";
import { validateDraft } from "./validate.js";

const r800 = JSON.parse(readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json"), "utf8"));

/** The live survey, deep-frozen, so an operation that wrote to its input would throw. */
function live(): StudioDraft {
  return deepFreeze(extractDraft(r800));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A built-in protocol as a research team would field it: approved, so a new version. */
const approved: NarrativeProtocol = { ...phoneWellbeing, approvalStatus: "approved", version: "0.1.1" };
const id = `${approved.key}@${approved.version}`;

function withMyStory(protocol: NarrativeProtocol = approved): StudioDraft {
  return deepFreeze(ops.setMyStory(live(), protocol).draft);
}

function refusal(run: () => unknown): StudioOpError {
  try {
    run();
  } catch (error) {
    if (error instanceof StudioOpError) return error;
    throw error;
  }
  throw new Error("expected the operation to be refused");
}

/** A section with nothing protected or licensed in it, which may be moved freely. */
function editableSection(draft: StudioDraft): string {
  // Not the consent section: nothing may move ahead of it, which is a different refusal.
  const found = outline(draft).sections.find(
    (s) => s.blocks.length > 0 && s.blocks.every((b) => b.tier === "editable" && !CONSENT_MODULES.includes(b.instrument)),
  );
  if (!found) throw new Error("no editable section");
  return found.key;
}

const errors = (draft: StudioDraft, ctx = {}) => validateDraft(draft, ctx).filter((i) => i.severity === "error");
const codes = (draft: StudioDraft, ctx = {}) => errors(draft, ctx).map((i) => i.code);

describe("switching MyStory on and off", () => {
  it("puts MyStory last, alone in its own section, with the protocol frozen into the draft", () => {
    const before = live();
    const d = withMyStory();
    const sections = d.composition.sections;
    expect(sections).toHaveLength(before.composition.sections.length + 1);
    expect(sections[sections.length - 1]).toEqual({
      key: "mystory",
      title: "MyStory",
      components: [{ kind: "narrative", protocol: approved.key, protocolVersion: approved.version }],
    });
    // The whole definition, as the schema reads it: what the release will freeze.
    expect(d.narrativeProtocols).toEqual({ [id]: narrativeProtocol.parse(approved) });
    // Its model stages need the network, and nothing said otherwise.
    expect(d.composition.offline.narrativeConnectivity).toBe("online_required");
    expect(myStoryMisplaced(d)).toBeNull();
  });

  it("keeps a connectivity setting that was already made", () => {
    const d = structuredClone(live());
    d.composition.offline = { surveyOfflineCapable: true, narrativeConnectivity: "offline_capable_with_queue" };
    expect(ops.setMyStory(d, approved).draft.composition.offline.narrativeConnectivity).toBe("offline_capable_with_queue");
  });

  it("choosing another protocol replaces it where it is, keeping its section", () => {
    const d = structuredClone(withMyStory());
    d.composition.sections[d.composition.sections.length - 1]!.title = "Your story";
    const other: NarrativeProtocol = { ...approved, version: "0.1.2", name: "Phones and wellbeing, second wave" };
    const next = ops.setMyStory(d, other).draft;
    const last = next.composition.sections[next.composition.sections.length - 1]!;
    expect(last.key).toBe("mystory");
    expect(last.title).toBe("Your story");
    expect(last.components).toEqual([{ kind: "narrative", protocol: other.key, protocolVersion: "0.1.2" }]);
    expect(Object.keys(next.narrativeProtocols ?? {})).toEqual([`${other.key}@0.1.2`]);
    expect(next.composition.sections).toHaveLength(d.composition.sections.length);
  });

  it("switching it off takes out its section, its protocol and its connectivity setting, and nothing else", () => {
    const off = ops.setMyStory(withMyStory(), null).draft;
    expect(canonicalJson(off)).toBe(canonicalJson(live()));
    expect(off.narrativeProtocols).toBeUndefined();
    expect(myStoryOf(off)).toBeNull();
  });

  it("refuses a protocol that would not run, and says why", () => {
    expect(refusal(() => ops.setMyStory(live(), { ...approved, stages: "none" } as never)).message).toMatch(/isn't in the protocol format \(stages:/);
    const silent = { ...approved, stages: approved.stages.filter((s) => s.kind !== "collect") };
    expect(refusal(() => ops.setMyStory(live(), silent)).message).toMatch(/can't be used: .*no elicitation stage/);
    expect(refusal(() => ops.setMyStory(live(), { ...approved, version: "1.0" })).message).toMatch(/version “1\.0” must be three numbers/);
  });

  it("accepts a protocol still being approved, which validation then holds back from publishing", () => {
    const d = ops.setMyStory(live(), phoneWellbeing).draft;
    expect(myStoryOf(d)?.id).toBe("np.phone_wellbeing@0.1.0");
    expect(codes(d)).toContain("mystory.not_approved");
  });
});

describe("MyStory stays last", () => {
  it("a new section goes in before MyStory", () => {
    const { draft, sectionKey } = ops.addSection(withMyStory(), { title: "Sleep" });
    const keys = draft.composition.sections.map((s) => s.key);
    expect(keys.slice(-2)).toEqual([sectionKey, "mystory"]);
  });

  it("refuses a section placed after it, and moving a section below it", () => {
    const d = withMyStory();
    const n = d.composition.sections.length;
    expect(refusal(() => ops.addSection(d, { title: "After", index: n })).message).toMatch(/MyStory is the last part of the survey/);
    const movable = editableSection(d);
    expect(refusal(() => ops.moveSection(d, movable, n - 1)).message).toMatch(/nothing can come after it/);
    expect(refusal(() => ops.moveSection(d, "mystory", 1)).message).toMatch(/nothing can come after it/);
  });

  it("refuses questions and blocks moved into its section", () => {
    const d = withMyStory();
    const sectionKey = editableSection(d);
    const q = outline(d).sections.find((s) => s.key === sectionKey)!.blocks[0]!.questions[0]!.itemKey;
    expect(refusal(() => ops.moveQuestion(d, q, { sectionKey: "mystory", index: 0 })).message).toMatch(/holds only the MyStory conversation/);
    expect(refusal(() => ops.moveBlock(d, { sectionKey, componentIndex: 0 }, { sectionKey: "mystory", index: 0 })).message).toMatch(
      /holds only the MyStory conversation/,
    );
    expect(refusal(() => ops.addQuestion(d, { typeId: "short_text", text: "Anything else?", sectionKey: "mystory" })).message).toMatch(
      /holds only the MyStory conversation/,
    );
  });

  it("its section is removed by switching MyStory off, not by deleting the section", () => {
    expect(refusal(() => ops.removeSection(withMyStory(), "mystory")).message).toMatch(/switch it off instead/);
  });
});

describe("a survey with MyStory, published", () => {
  it("freezes MyStory last with its protocol, prompts and model, on engine 0.4.0", () => {
    const d = withMyStory();
    const preview = previewRelease(d);
    expect(preview.error).toBeNull();
    expect(preview.failures).toEqual([]);
    const manifest = preview.manifest!;
    expect(manifest.release.engineVersion).toBe("0.4.0");
    expect(manifest.composition.sections.at(-1)!.components).toEqual([{ kind: "narrative", protocol: approved.key, protocolVersion: "0.1.1" }]);
    expect(manifest.narrativeProtocols[id]).toEqual(narrativeProtocol.parse(approved));
    expect(Object.keys(manifest.modelConfigs)).toEqual(approved.models.map((m) => m.key));
    expect(Object.keys(manifest.prompts).length).toBeGreaterThan(0);
    expect(errors(d)).toEqual([]);
  });

  it("opens back up as the same draft, and republishes to the same hash", () => {
    const meta = { version: "9.0.0", publishedAt: "2026-10-02T12:00:00.000Z", publishedBy: "studio:test", engineVersion: "0.4.0" };
    const { composition, registries } = compileDraft(withMyStory());
    const first = buildRelease(composition, registries, meta);
    const reopened = parseDraft(serialiseDraft(extractDraft(first)));
    expect(myStoryOf(reopened)?.id).toBe(id);
    expect(reopened.narrativeProtocols).toEqual(first.narrativeProtocols);
    const again = compileDraft(reopened);
    expect(buildRelease(again.composition, again.registries, meta).hash).toBe(first.hash);
  });
});

describe("validating MyStory", () => {
  it("refuses a key@version that a published version froze with other content, and accepts the same content", () => {
    const d = withMyStory();
    const same = new Map<string, unknown>([[id, approved]]);
    expect(codes(d, { publishedProtocols: same })).not.toContain("mystory.version_published");
    const other = new Map<string, unknown>([[id, { ...approved, name: "Something else" }]]);
    const issue = errors(d, { publishedProtocols: other }).find((i) => i.code === "mystory.version_published");
    expect(issue?.message).toBe(`${id} was published with different content`);
    expect(issue?.hint).toMatch(/such as 0\.1\.2/);
    expect(issue?.location).toEqual({ kind: "mystory", sectionKey: "mystory", field: "protocol" });
  });

  it("refuses a built-in protocol's key@version with other content", () => {
    // Approving a built-in protocol changes it, so it needs a version of its own.
    const d = ops.setMyStory(live(), { ...phoneWellbeing, approvalStatus: "approved" }).draft;
    const issue = errors(d).find((i) => i.code === "mystory.version_built_in");
    expect(issue?.message).toBe("np.phone_wellbeing@0.1.0 is a built-in protocol, and this one differs from it");
    expect(issue?.hint).toMatch(/such as 0\.1\.1/);
  });

  it("holds a protocol not yet approved back, and locates the gate's refusal at MyStory", () => {
    const d = ops.setMyStory(live(), phoneWellbeing).draft;
    const found = errors(d).filter((i) => i.code === "mystory.not_approved" || i.code === "gate.narrative");
    expect(found.map((i) => i.code).sort()).toEqual(["gate.narrative", "mystory.not_approved"]);
    for (const i of found) expect(i.location.kind).toBe("mystory");
  });

  it("reports a MyStory that is not last, not alone, or not one", () => {
    const after = structuredClone(withMyStory());
    after.composition.sections.push(structuredClone(after.composition.sections[1]!));
    after.composition.sections.splice(1, 1);
    expect(codes(after)).toContain("mystory.not_last");

    const crowded = structuredClone(withMyStory());
    const last = crowded.composition.sections[crowded.composition.sections.length - 1]!;
    const first = crowded.composition.sections[1]!;
    last.components.push(first.components.shift()!);
    expect(codes(crowded)).toContain("mystory.not_alone");

    const twice = structuredClone(withMyStory());
    twice.composition.sections.splice(1, 0, structuredClone(twice.composition.sections.at(-1)!));
    twice.composition.sections[1]!.key = "mystory_2";
    expect(codes(twice)).toContain("mystory.more_than_one");
  });

  it("reports a protocol the draft names but does not carry, or carries broken", () => {
    const missing = structuredClone(withMyStory()) as StudioDraft;
    delete missing.narrativeProtocols;
    expect(codes(missing)).toEqual(expect.arrayContaining(["mystory.protocol_missing", "gate.narrative_unresolved"]));

    const broken = structuredClone(withMyStory()) as StudioDraft;
    broken.narrativeProtocols![id]!.character.about = ["Hello."];
    const issue = errors(broken).find((i) => i.code === "mystory.protocol_check");
    expect(issue?.message).toMatch(/^The character 'Sam' never says it is an AI/);
  });
});

describe("the version a MyStory change needs", () => {
  it("adding MyStory is MAJOR, said in its own words, and not as a new section or a settings change", () => {
    const summary = diffDrafts(live(), withMyStory());
    expect(summary.bump).toBe("major");
    expect(summary.entries).toEqual([
      { kind: "mystory.added", bump: "major", breaking: false, message: `MyStory added (${id}).`, sectionKey: "mystory" },
    ]);
  });

  it("removing it, or changing its protocol, is MAJOR too", () => {
    const removed = diffDrafts(withMyStory(), live());
    expect(removed.entries.map((e) => [e.kind, e.bump, e.message])).toEqual([["mystory.removed", "major", `MyStory removed (${id}).`]]);

    const next = ops.setMyStory(withMyStory(), { ...approved, version: "0.2.0" }).draft;
    const changed = diffDrafts(withMyStory(), next);
    expect(changed.bump).toBe("major");
    expect(changed.entries.map((e) => e.message)).toEqual([`MyStory protocol changed from ${id} to ${approved.key}@0.2.0.`]);
  });

  it("notices a protocol whose content changed under the same version", () => {
    const edited = structuredClone(withMyStory()) as StudioDraft;
    edited.narrativeProtocols![id]!.name = "Renamed";
    expect(diffDrafts(withMyStory(), edited).entries.map((e) => e.message)).toEqual([`MyStory protocol ${id} changed, keeping its version.`]);
  });
});

describe("the outline", () => {
  it("lists MyStory on its own, not among the sections", () => {
    const o = outline(withMyStory());
    expect(o.sections.map((s) => s.key)).not.toContain("mystory");
    expect(o.mystory).toMatchObject({ sectionKey: "mystory", id, name: approved.name, approvalStatus: "approved" });
    expect(outline(live()).mystory).toBeNull();
  });
});

describe("protocol files", () => {
  it("reads a protocol back from its TOML exactly", () => {
    const toml = protocolToml(approved)!;
    expect(readProtocolText(toml)).toEqual({ protocol: narrativeProtocol.parse(approved), problems: [] });
  });

  it("says what is wrong with a file, in words", () => {
    expect(readProtocolText("   ").problems).toEqual(["The protocol file is empty."]);
    expect(readProtocolText("[myself\nkey = 1").protocol).toBeNull();
    expect(readProtocolText("[myself]\nkey = \"np.x\"").problems.length).toBeGreaterThan(0);
    const typo = protocolToml(approved)!.replace(/^intro = .*$/m, 'intro = "Tell me about {topik}."');
    expect(readProtocolText(typo).problems).toEqual(["stage 'intro' shows {topik}, which is not a permitted variable"]);
  });

  it("offers the shorter protocols as they are, since a file cannot express them", () => {
    expect(protocolToml(microNarrative)).toBeNull();
  });

  it("finds the next free version, and writes it into the file", () => {
    expect(nextProtocolVersion(phoneWellbeing)).toBe("0.1.1");
    expect(nextProtocolVersion(phoneWellbeing, new Map([["np.phone_wellbeing@0.1.1", approved]]))).toBe("0.1.2");
    const toml = protocolToml(phoneWellbeing)!;
    expect(readProtocolText(withProtocolVersion(toml, "0.1.7")).protocol?.version).toBe("0.1.7");
    expect(withProtocolVersion("[collection]\nintro = \"x\"\n", "1.0.1")).toBe('[collection]\nintro = "x"\n\n[myself]\nversion = "1.0.1"\n');
    expect(withProtocolVersion('[myself]\nkey = "np.x"\n', "2.0.0")).toBe('[myself]\nversion = "2.0.0"\nkey = "np.x"\n');
  });

  it("knows a key@version for good: published content decides, then the built-in", () => {
    expect(protocolClash(phoneWellbeing)).toBeNull();
    expect(protocolClash({ ...phoneWellbeing, name: "Other" })).toBe("built_in");
    expect(protocolClash({ ...phoneWellbeing, name: "Other" }, new Map([["np.phone_wellbeing@0.1.0", { ...phoneWellbeing, name: "Other" }]]))).toBeNull();
    expect(protocolClash(approved, new Map([[id, phoneWellbeing]]))).toBe("published");
  });

  it("collects what published versions froze, the later winning", () => {
    const early = { release: { version: "9.0.0" }, narrativeProtocols: { [id]: { name: "early" } } };
    const later = { release: { version: "10.0.0" }, narrativeProtocols: { [id]: { name: "later" } } };
    expect(publishedProtocols([later, early, null, 3]).get(id)).toEqual({ name: "later" });
  });
});
