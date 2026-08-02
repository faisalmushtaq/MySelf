import { describe, expect, it } from "vitest";
import { AnswerStore, Walker } from "@myself/engine";
import { releaseManifest } from "@myself/schema";
import rawManifest from "../../../releases/ybm_nd2026_standard_r4.0.0.manifest.json";
import { flattenManifest, reminderOf } from "./lib/flatten.js";
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

  it("carries the entry-validation rules the app enforces", () => {
    // These rules are what stop implausible identifiers and dates of birth
    // reaching the raw data. If a release ever ships without them the app
    // would silently accept anything, so the manifest is asserted directly.
    const code = manifest.composition.participantCode;
    expect(code?.pattern).toBe("^[A-Za-z]{3}[0-9]{4}$"); // three letters, four digits
    expect(code?.variable).toBe("val_id"); // captured once, never re-asked
    expect(code?.instructions).toMatch(/research team/i);

    const find = (key: string) => flattened.units.find((u) => u.item.key === key)?.item;

    // The secret code is built one component per screen, each constrained.
    for (const [key, pattern] of [
      ["ps_mother_initials", "^[A-Za-z]{2}$"],
      ["ps_house_digit", "^[0-9]$"],
      ["ps_postcode_letters", "^[A-Za-z]{2}$"],
    ] as const) {
      const item = find(key);
      expect(item?.responseType).toBe("text_short");
      if (item?.responseType === "text_short") {
        expect(item.pattern).toBe(pattern);
        expect(item.patternHint).toBeTruthy();
        expect(item.required).toBe("hard");
      }
    }

    // Month is chosen, not typed, so it cannot be mistyped at all.
    const month = find("ps_birth_month");
    expect(month?.responseType).toBe("single_choice");
    if (month?.responseType === "single_choice") {
      expect(month.presentation).toBe("compact");
      expect(manifest.scales[month.scale]).toBeDefined();
    }

    // The explainer comes before any of it is collected.
    const intro = flattened.units.findIndex((u) => u.item.key === "secret_code_intro");
    const first = flattened.units.findIndex((u) => u.item.key === "ps_mother_initials");
    expect(intro).toBeGreaterThan(-1);
    expect(intro).toBeLessThan(first);

    // The in-flow validation-ID question is gone: it is the opening screen now.
    expect(find("val_id")).toBeUndefined();

    const dob = find("dob");
    expect(dob?.responseType).toBe("date");
    if (dob?.responseType === "date") {
      expect(dob.minAgeYears).toBe(4); // nobody younger than 4 completes this
      expect(dob.maxAgeYears).toBe(100);
    }
  });

  it("puts each ladder on one screen with its explanation, and no page of narration first", () => {
    const ladders = flattened.units.filter((u) => u.item.responseType === "ladder");
    expect(ladders).toHaveLength(2);
    for (const l of ladders) {
      expect(l.item.lede?.text).toMatch(/^This ladder stands for/);
      expect(l.item.lede?.text).not.toMatch(/below/i);
      expect(l.item.stem.text).not.toMatch(/below/i);
    }
    // the two click-through pages that used to precede each ladder are gone
    const keys = flattened.units.map((u) => u.item.key);
    for (const gone of ["society_intro", "society_desc", "school_intro", "school_desc"]) {
      expect(keys).not.toContain(gone);
    }
  });

  it("never tells a participant to read something that is not on the screen", () => {
    // "below are some statements" was written for a paper form. Here every
    // statement arrives on its own screen, so the words were simply untrue.
    for (const u of flattened.units) {
      const text = `${u.item.stem.text} ${u.item.lede?.text ?? ""}`;
      expect(text).not.toMatch(/\b(are|is|shown|given|listed|presented)\s+(below|above)\b/i);
    }
  });

  it("shortens instrument instructions to the part that still helps mid-battery", () => {
    // The opening sentence describes what is coming; by the time someone asks
    // for a reminder it has already come. The last sentence says how to answer.
    expect(reminderOf("The next few screens each show a statement. For each one, say how much you agree.")).toBe(
      "For each one, say how much you agree.",
    );
    for (const text of flattened.context.values()) {
      expect(text).not.toMatch(/next few screens/i);
    }
  });

  it("offers data-handling detail on the first screen without imposing it", () => {
    const intro = flattened.units.find((u) => u.item.key === "intro");
    expect(intro?.item.moreInfo?.label).toBeTruthy();
    expect(intro?.item.moreInfo?.body.text).toMatch(/WHERE IT IS KEPT/);
    // A title, then the body — not one undifferentiated block of prose.
    expect(intro?.item.stem.text).toBe("Yorkshire Brain Map School Workshop");
    expect(intro?.item.lede?.text).toMatch(/Thank you for taking part/);
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
