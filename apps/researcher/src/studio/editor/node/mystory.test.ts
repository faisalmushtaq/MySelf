import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { microNarrative, phoneWellbeing, type NarrativeProtocol } from "@myself/narrative";
import { extractDraft, myStoryOf, outline, protocolToml, setMyStory, validateDraft, type Issue } from "@myself/studio";
import { buildTree, indexIssues } from "../outline/model.js";
import { decodeSelection, encodeSelection } from "../selection.js";
import { groupIssues, selectionFor } from "../validation/select.js";
import { approvalWords, checkProtocolAsIs, checkProtocolFile, protocolChoices, protocolFilename, SURVEY_PROTOCOL } from "./mystory.js";

const r800 = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json"), "utf8"));
const approved: NarrativeProtocol = { ...phoneWellbeing, approvalStatus: "approved", version: "0.1.1" };
const withStory = setMyStory(extractDraft(r800), approved).draft;

describe("the protocols MyStory can start from", () => {
  it("lists the survey's own first, then every built-in protocol, each with its file when it has one", () => {
    const choices = protocolChoices(myStoryOf(withStory));
    expect(choices[0]).toMatchObject({ value: SURVEY_PROTOCOL, label: "This survey's: Phones and wellbeing (placeholder) (np.phone_wellbeing@0.1.1)" });
    expect(choices.slice(1).map((c) => c.value)).toEqual([
      "np.phone_wellbeing@0.1.0",
      "np.micro_narrative_full@1.0.0",
      "np.micro_narrative@1.0.0",
      "np.future_self@1.0.0",
    ]);
    expect(choices.find((c) => c.value === "np.micro_narrative@1.0.0")!.toml).toBeNull();
    expect(protocolChoices(null)[0]!.value).toBe("np.phone_wellbeing@0.1.0");
  });
});

describe("checking a protocol file as it is typed", () => {
  it("says a file that does not read, or does not pass its checks, can't be used, and why", () => {
    expect(checkProtocolFile("")).toMatchObject({ protocol: null, problems: ["The protocol file is empty."], clash: null });
    const typo = protocolToml(approved)!.replace(/^intro = .*$/m, 'intro = "About {topik}."');
    const check = checkProtocolFile(typo);
    expect(check.protocol).not.toBeNull();
    expect(check.problems).toEqual(["stage 'intro' shows {topik}, which is not a permitted variable"]);
  });

  it("offers the next version when the key and version already name other content", () => {
    const toml = protocolToml(phoneWellbeing)!.replace('approval_status = "draft"', 'approval_status = "approved"');
    const check = checkProtocolFile(toml);
    expect(check).toMatchObject({ problems: [], approved: true, clash: { where: "built_in", next: "0.1.1" } });
    const published = new Map<string, unknown>([["np.phone_wellbeing@0.1.1", { ...approved, name: "Other" }]]);
    expect(checkProtocolFile(protocolToml(approved)!, published).clash).toEqual({ where: "published", next: "0.1.2" });
  });

  it("accepts a built-in protocol as it is, which still needs approving before it can be published", () => {
    expect(checkProtocolFile(protocolToml(phoneWellbeing)!)).toMatchObject({ problems: [], clash: null, approved: false });
    expect(checkProtocolAsIs(microNarrative)).toMatchObject({ problems: [], clash: null, approved: false });
  });

  it("names things in words", () => {
    expect(approvalWords("draft")).toBe("Draft, not yet approved");
    expect(approvalWords("approved")).toBe("Approved");
    expect(protocolFilename(approved)).toBe("phone_wellbeing-0.1.1.toml");
  });
});

describe("MyStory in the editor's outline and checks", () => {
  const o = outline(withStory);
  const issues: Issue[] = validateDraft(setMyStory(extractDraft(r800), phoneWellbeing).draft);
  const index = indexIssues(issues);

  it("is one row between the sections and the completion screen, with its section kept out of the list", () => {
    const tree = buildTree(o, index, { query: "", withProblems: false, withConditions: false, expanded: new Map(), canEdit: true });
    const ids = tree.roots.map((n) => n.id);
    expect(ids).not.toContain("section:mystory");
    expect(ids.slice(-3)).toEqual(["mystory", "completion", "settings"]);
    expect(tree.byId.get("mystory")).toMatchObject({ label: "MyStory", selection: { kind: "mystory" } });
  });

  it("counts its problems on its row, and “Go to” opens it", () => {
    const own = issues.filter((i) => i.location.kind === "mystory");
    expect(own.length).toBeGreaterThan(0);
    expect(index.mystory.errors).toBe(own.filter((i) => i.severity === "error").length);
    for (const i of own) expect(selectionFor(i, o)).toEqual({ kind: "mystory" });
    // Its section's own checks open MyStory too.
    expect(selectionFor({ severity: "error", code: "x", message: "x", location: { kind: "section", sectionKey: "mystory", field: "title" } }, o)).toEqual({
      kind: "mystory",
    });
    expect(groupIssues(own, o).errors.map((g) => g.label)).toEqual(["MyStory"]);
  });

  it("has an address of its own", () => {
    expect(encodeSelection({ kind: "mystory" })).toBe("mystory");
    expect(decodeSelection("mystory")).toEqual({ kind: "mystory" });
  });
});
