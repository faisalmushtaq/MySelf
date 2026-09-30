import { describe, expect, it } from "vitest";
import { AnswerStore, Walker } from "@myself/engine";
import { releaseManifest, type ReleaseManifest } from "@myself/schema";
import r9 from "../../../releases/ybm_nd2026_standard_r9.0.0.manifest.json";
import { flattenManifest } from "./lib/flatten.js";
import { runnable } from "./lib/versions.js";

/**
 * Where MyStory sits when a version ends with it (D-54).
 *
 * A version either ends with MyStory or does not. When it does, the order is
 * the survey, then MyStory, then the finish screen, then the handover to the
 * researcher, so the device is only handed back once MyStory is done or left.
 *
 * The finish screen and the handover are not positions in the walk: App shows
 * the finish screen when the walker has nothing after the current position,
 * and the handover is the finish screen's own button. So the order holds when
 * the narrative is the last unit and nothing visible follows it, which is what
 * this checks, whatever the participant answered on the way.
 */

const PROTOCOL = "np.phone_wellbeing";
const VERSION = "1.0.0";

/** r9.0.0 with a final MyStory section, the shape the dashboard's editor publishes. */
function withMyStory(where: "last" | "middle"): ReleaseManifest {
  const draft = structuredClone(r9) as unknown as {
    composition: { sections: unknown[] };
    narrativeProtocols: Record<string, unknown>;
  };
  const section = {
    key: "mystory",
    title: "MyStory",
    components: [{ kind: "narrative", protocol: PROTOCOL, protocolVersion: VERSION }],
  };
  if (where === "last") draft.composition.sections.push(section);
  else draft.composition.sections.splice(1, 0, section);
  draft.narrativeProtocols[`${PROTOCOL}@${VERSION}`] = { key: PROTOCOL, version: VERSION };
  return releaseManifest.parse(draft);
}

describe("a version that ends with MyStory", () => {
  const manifest = withMyStory("last");
  const { units } = flattenManifest(manifest);
  const narrative = units.length - 1;

  it("is one the device will run", () => {
    expect(runnable(manifest)).toBeNull();
  });

  it("puts MyStory after every question", () => {
    expect(units[narrative]!.narrative).toEqual({ protocol: PROTOCOL, version: VERSION });
    expect(units.filter((u) => u.narrative)).toHaveLength(1);
  });

  it("has nothing after MyStory, so the finish screen and then the handover follow it", () => {
    // Walked for two different participants: one who answers nothing, and
    // one whose answers open the branched sections.
    const quiet = new AnswerStore();
    const busy = new AnswerStore();
    for (const item of ["own", "sm_use"]) {
      busy.set({ instrument: "ybm_smartphone", item, revision: 1 }, { status: "answered", value: { kind: "choice", code: 1 } });
    }
    for (const store of [quiet, busy]) {
      const walker = new Walker(units, store, true);
      const visible = walker.visibleUnits();
      expect(visible[visible.length - 1]).toBe(narrative);
      expect(walker.next(narrative)).toBeNull();

      // And the walk, step by step, reaches it last.
      let at = walker.first();
      let last = at;
      let steps = 0;
      while (at !== null && steps < units.length) {
        last = at;
        at = walker.next(at);
        steps += 1;
      }
      expect(last).toBe(narrative);
    }
  });

  it("lets a participant go back from MyStory to the last question, as from any position", () => {
    const walker = new Walker(units, new AnswerStore(), true);
    const back = walker.back(narrative);
    expect(back).not.toBeNull();
    expect(units[back!]!.narrative).toBeUndefined();
  });
});

describe("a version with MyStory placed elsewhere", () => {
  it("carries on with the survey after it, which is why the screen's words depend on it", () => {
    const { units } = flattenManifest(withMyStory("middle"));
    const at = units.findIndex((u) => u.narrative);
    expect(at).toBeGreaterThan(0);
    expect(new Walker(units, new AnswerStore(), true).next(at)).not.toBeNull();
  });
});
