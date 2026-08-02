import { describe, expect, it } from "vitest";
import { AnswerStore, Walker } from "@myself/engine";
import { releaseManifest } from "@myself/schema";
import rawManifest from "../../../releases/ybm_nd2026_standard_r1.0.0.manifest.json";
import { flattenManifest } from "./lib/flatten.js";
import { resolveText } from "./lib/pipes.js";

const manifest = releaseManifest.parse(rawManifest);
const flattened = flattenManifest(manifest);

describe("manifest flattening", () => {
  it("produces the full YBM unit list with instruction cards", () => {
    // 19 components' items + instruction info cards for instruments that carry instructions
    expect(flattened.units.length).toBeGreaterThan(100);
    const keys = flattened.units.map((u) => `${u.instrument}.${u.item.key}`);
    expect(keys).toContain("ybm_intro_consent.consent");
    expect(keys).toContain("sdq25_s.q25");
    expect(keys).toContain("rcads25.q18");
    expect(keys).toContain("ybm_future_self.message");
  });

  it("social-media units inherit the section branch condition", () => {
    const doom = flattened.units.find((u) => u.instrument === "doomscroll4");
    expect(doom?.displayIf).toBeDefined();
  });

  it("a non-social-media, non-gaming participant sees no branched items", () => {
    const store = new AnswerStore();
    store.set({ instrument: "ybm_smartphone", item: "sm_use", revision: 1 }, { status: "answered", value: { kind: "choice", code: 2 } });
    store.set({ instrument: "ybm_smartphone", item: "own", revision: 1 }, { status: "answered", value: { kind: "choice", code: 2 } });
    store.set({ instrument: "ybm_gaming", item: "hours_week", revision: 1 }, { status: "answered", value: { kind: "choice", code: 1 } });
    const walker = new Walker(flattened.units, store, true);
    const visible = walker.visibleUnits().map((i) => flattened.units[i]!.instrument);
    expect(visible).not.toContain("ybm_social_media");
    expect(visible).not.toContain("ybm_screen_attitudes");
    expect(visible).not.toContain("doomscroll4");
    expect(visible.filter((v) => v === "ybm_gaming")).toHaveLength(1); // only hours_week
    // Everyone still gets STAI + BIS/BAS + future self (QSF flow finding)
    expect(visible).toContain("stai5_s");
    expect(visible).toContain("bisbas12_ybm");
    expect(visible).toContain("ybm_future_self");
  });

  it("resolves the consent withdrawal-date pipe from the session start", () => {
    const store = new AnswerStore();
    const text = resolveText(
      "up until {withdrawal_date}",
      { withdrawal_date: { kind: "date_offset", offsetDays: 2 } },
      store,
      new Date("2026-08-02T09:00:00Z"),
    );
    expect(text).toBe("up until 4 August 2026");
  });

  it("resolves game-name pipes from earlier form-field answers", () => {
    const store = new AnswerStore();
    store.set(
      { instrument: "ybm_gaming", item: "top_games", revision: 1 },
      { status: "answered", value: { kind: "fields", values: { game_1: "Minecraft" } } },
    );
    const text = resolveText(
      "Roughly how many hours do you play {game_1} in a typical week?",
      { game_1: { kind: "item_text_entry", item: { instrument: "ybm_gaming", item: "top_games", revision: 1 }, part: "game_1" } },
      store,
      new Date(),
    );
    expect(text).toContain("Minecraft");
  });
});
