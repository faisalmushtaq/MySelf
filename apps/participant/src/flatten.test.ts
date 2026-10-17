import { describe, expect, it } from "vitest";
import { AnswerStore, Walker } from "@myself/engine";
import { releaseManifest } from "@myself/schema";
import rawManifest from "../../../releases/ybm_nd2026_standard_r7.0.0.manifest.json";
import r710 from "../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json";
import currentManifest from "../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json";
import candidateManifest from "../../../releases/candidates/ybm_nd2026_standard_r9.0.0.manifest.json";
import { flattenManifest, reminderOf } from "./lib/flatten.js";
import { resolveText } from "./lib/pipes.js";

const manifest = releaseManifest.parse(rawManifest);
const flattened = flattenManifest(manifest);

describe("placements that show part of a form (D-49)", () => {
  /**
   * r7.1.0 with the SDQ split in two: its first placement stays in "How you've
   * been feeling" but shows three questions in an order of its own, and the rest
   * move to a new section after it. Built by editing the composition only — the
   * flattening never looks at the hash, so there is none to keep right.
   */
  const split = (() => {
    const raw = JSON.parse(JSON.stringify(r710)) as {
      composition: { sections: { key: string; title: string; components: Record<string, unknown>[] }[] };
    };
    const sections = raw.composition.sections;
    const wellbeing = sections.findIndex((s) => s.key === "wellbeing");
    const sdq = sections[wellbeing]!.components.find(
      (c) => (c["ref"] as { instrument?: string } | undefined)?.instrument === "sdq25_s",
    )!;
    sdq["items"] = ["q3", "q1", "q2"];
    const rest = Array.from({ length: 22 }, (_, i) => `q${i + 4}`);
    sections.splice(wellbeing + 1, 0, {
      key: "more_feelings",
      title: "A few more",
      components: [{ ...sdq, items: rest }],
    });
    return flattenManifest(releaseManifest.parse(raw));
  })();

  const sdqUnits = split.units.filter((u) => u.instrument === "sdq25_s");

  it("shows the subset's questions in the subset's order, not the form's", () => {
    const first = sdqUnits.filter((u) => u.sectionKey === "wellbeing").map((u) => u.item.key);
    expect(first).toEqual(["__instructions_sdq25_s", "q3", "q1", "q2"]);
  });

  it("administers every question once across the two placements", () => {
    const questions = sdqUnits.map((u) => u.item.key).filter((k) => !k.startsWith("__"));
    expect(questions).toHaveLength(25);
    expect(new Set(questions).size).toBe(25);
    expect(sdqUnits.filter((u) => u.sectionKey === "more_feelings")[1]?.item.key).toBe("q4");
  });

  it("gives the second placement its own instructions key and keeps the first one's", () => {
    // The first keeps the key every earlier release used, so its timing and
    // events line up with theirs; the second is numbered, so no two units share one.
    const instructions = sdqUnits.filter((u) => u.item.key.startsWith("__instructions_"));
    expect(instructions.map((u) => [u.sectionKey, u.item.key])).toEqual([
      ["wellbeing", "__instructions_sdq25_s"],
      ["more_feelings", "__instructions_sdq25_s_2"],
    ]);
  });

  it("changes nothing for a release that uses no subsets", () => {
    const whole = flattenManifest(releaseManifest.parse(r710));
    expect(whole.units.filter((u) => u.instrument === "sdq25_s").map((u) => u.item.key)).toEqual([
      "__instructions_sdq25_s",
      ...Array.from({ length: 25 }, (_, i) => `q${i + 1}`),
    ]);
  });
});

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

  it("asks for the date of birth before anything that depends on it", () => {
    const at = (key: string) => flattened.units.findIndex((u) => u.item.key === key);
    // Name, then date of birth, then the code that is checked against it.
    expect(at("last_name")).toBeLessThan(at("dob"));
    expect(at("dob")).toBeLessThan(at("secret_code_intro"));
    expect(at("dob")).toBeLessThan(at("ps_birth_month"));
    // and before the age-limited questions much later in the survey
    expect(at("dob")).toBeLessThan(at("age_smartphone"));
    expect(at("dob")).toBeLessThan(at("age_sm"));
  });

  it("cross-checks the code's month against the recorded date of birth", () => {
    const month = flattened.units.find((u) => u.item.key === "ps_birth_month")?.item;
    const check = month?.crossChecks?.[0];
    expect(check?.kind).toBe("matches_month_of_date");
    expect(check?.against).toEqual({ instrument: "ybm_identity", item: "dob", revision: 1 });
    expect(check?.message).toBeTruthy();
    // the check is only meaningful if the options carry the month number
    const scale = manifest.scales["scale.month_12"] as { options: { value?: number }[] };
    expect(scale.options.map((o) => o.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("limits the age-of-first-device options to ages the participant has reached", () => {
    for (const key of ["age_smartphone", "age_sm"]) {
      const item = flattened.units.find((u) => u.item.key === key)?.item;
      expect(item?.responseType).toBe("single_choice");
      if (item?.responseType !== "single_choice") continue;
      expect(item.limitOptions).toEqual({
        kind: "at_most_age_now",
        from: { instrument: "ybm_identity", item: "dob", revision: 1 },
      });
      // every substantive option must declare the age it denotes, or the rule
      // would silently keep options it cannot evaluate
      const scale = manifest.scales[item.scale] as {
        options: { label: string; value?: number; kind: string }[];
      };
      for (const o of scale.options) {
        if (o.kind === "substantive") expect(o.value, `${item.scale} / ${o.label}`).toBeTypeOf("number");
      }
    }
  });

  it("scales the too-fast threshold instead of holding every screen to one clock", () => {
    const e = manifest.composition.effort;
    expect(e.tooFastSeconds).toBeLessThan(2); // a short item is not given two seconds
    expect(e.tooFastWordsPerSecond).toBeGreaterThan(4); // well above real reading speed
    expect(e.tooFastMaxSeconds).toBeGreaterThan(e.tooFastSeconds);
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


  it("confirms a 'no' to social media before dropping the whole section", () => {
    const at = (key: string) => flattened.units.findIndex((u) => u.item.key === key);
    // "No" is often a misunderstanding — people say it when they only watch,
    // or when they don't think YouTube or WhatsApp count.
    const confirm = flattened.units.find((u) => u.item.key === "sm_use_confirm");
    expect(confirm).toBeDefined();
    expect(confirm!.item.lede?.text).toMatch(/TikTok/);
    expect(at("sm_use")).toBeLessThan(at("sm_use_confirm"));
    // and it is only asked of people who said no
    expect(confirm!.item.displayIf).toMatchObject({ op: "selected", code: 2 });
  });

  it("asks nothing about apps when someone means their 'no'", () => {
    const store = new AnswerStore();
    const no = { status: "answered" as const, value: { kind: "choice" as const, code: 2 } };
    store.set({ instrument: "ybm_smartphone", item: "sm_use", revision: 1 }, no);
    store.set({ instrument: "ybm_smartphone", item: "sm_use_confirm", revision: 1 }, no);
    store.set({ instrument: "ybm_smartphone", item: "own", revision: 1 }, no);
    const visible = new Walker(flattened.units, store, true)
      .visibleUnits()
      .map((i) => flattened.units[i]!.instrument);
    expect(visible).not.toContain("ybm_social_media");
    expect(visible).not.toContain("ybm_screen_attitudes");
    expect(visible).not.toContain("doomscroll4");
  });

  it("asks about apps when the confirmation changes the answer", () => {
    const store = new AnswerStore();
    store.set(
      { instrument: "ybm_smartphone", item: "sm_use", revision: 1 },
      { status: "answered", value: { kind: "choice", code: 2 } }, // "no"
    );
    store.set(
      { instrument: "ybm_smartphone", item: "sm_use_confirm", revision: 1 },
      { status: "answered", value: { kind: "choice", code: 1 } }, // "…oh, those count"
    );
    const visible = new Walker(flattened.units, store, true)
      .visibleUnits()
      .map((i) => flattened.units[i]!.instrument);
    expect(visible).toContain("ybm_social_media");
    expect(visible).toContain("doomscroll4");
  });

  it("greets the participant by the name they gave at the start", () => {
    const finish = manifest.composition.screens["finish"];
    expect(finish?.title?.text).toContain("{first_name}");
    const pipe = finish?.title?.pipes?.["first_name"];
    expect(pipe?.item).toEqual({ instrument: "ybm_identity", item: "first_name", revision: 1 });
    // and reads naturally when there is no name to use
    expect(pipe?.fallback).toBeTruthy();

    const store = new AnswerStore();
    store.set(
      { instrument: "ybm_identity", item: "first_name", revision: 1 },
      { status: "answered", value: { kind: "text", value: "Faisal" } },
    );
    expect(resolveText(finish!.title!.text, finish!.title!.pipes, store, new Date())).toBe("Thank you, Faisal!");
    expect(resolveText(finish!.title!.text, finish!.title!.pipes, new AnswerStore(), new Date())).toBe(
      "Thank you, and well done!",
    );
  });

  it("waits longer before offering help on a longer question", () => {
    const e = manifest.composition.effort;
    expect(e.dwellWordsPerSecond).toBeGreaterThan(0);
    expect(e.dwellReadingMultiple).toBeGreaterThanOrEqual(2);
    expect(e.dwellMaxSeconds).toBeGreaterThan(e.dwellHintSeconds);
  });


  it("explains why accurate answers matter, once, before any question", () => {
    const at = (key: string) => flattened.units.findIndex((u) => u.item.key === key);
    const why = flattened.units.find((u) => u.item.key === "why_it_matters");
    expect(why?.item.responseType).toBe("info");
    expect(why?.item.lede?.text).toMatch(/no right or wrong answers/i);
    // after consent, before the first question that collects anything
    expect(at("consent")).toBeLessThan(at("why_it_matters"));
    expect(at("why_it_matters")).toBeLessThan(at("first_name"));
  });

  it("offers a review of every answer before the session is finished", () => {
    const review = manifest.composition.screens["review"];
    expect(review?.title?.text).toBeTruthy();
    expect(review?.body.text).toMatch(/change it/i);
  });

  it("does not promise a date format the operating system controls", () => {
    const dob = flattened.units.find((u) => u.item.key === "dob");
    expect(dob?.item.stem.text).not.toMatch(/dd\/mm|mm\/dd|yyyy/i);
  });


  it("no longer asks the two sleep-priority questions", () => {
    const keys = flattened.units.map((u) => `${u.instrument}.${u.item.key}`);
    expect(keys.some((k) => k.startsWith("ybm_sleep_priorities."))).toBe(false);
    for (const u of flattened.units) {
      expect(u.item.stem.text).not.toMatch(/most important to you for getting a good night/i);
      expect(u.item.stem.text).not.toMatch(/find out more about your own sleep/i);
    }
    // the sleep section still exists — the KSS is still asked
    expect(flattened.units.some((u) => u.instrument === "kss")).toBe(true);
  });

  it("offers the answer list from the finish screen rather than on the way to it", () => {
    const review = manifest.composition.screens["review"];
    expect(review?.title?.text).toBe("Change an answer");
    expect(review?.body.text).toMatch(/isn't right/i);
    // and the finish screen no longer tells them to hand over before they
    // have had the chance to change anything
    expect(manifest.composition.screens["finish"]?.body.text).not.toMatch(/hand the iPad back/i);
  });


  it("asks the handedness questions outright and centres nothing at the left", () => {
    const ehi = flattened.units.filter((u) => u.instrument === "ehi_sf" && u.item.responseType === "single_choice");
    expect(ehi).toHaveLength(4);
    for (const u of ehi) {
      // "Writing" named the task without asking anything; each now asks.
      expect(u.item.stem.text).toMatch(/^Which hand do you .+\?$/);
      expect(u.item.hint).toMatch(/Both equally/);
      if (u.item.responseType === "single_choice") expect(u.item.presentation).toBe("spectrum");
    }
    // the midpoint the participant needs to be able to see
    const scale = manifest.scales["scale.ehi_sf_5pt"] as { options: { label: string }[] };
    expect(scale.options.map((o) => o.label)).toContain("Both equally");
  });

  it("tells the participant their handedness score after all four items", () => {
    const at = (key: string) => flattened.units.findIndex((u) => u.item.key === key);
    const fb = flattened.units.find((u) => u.item.key === "lq_feedback");
    expect(fb?.item.responseType).toBe("info");
    // after every item it is computed from — feedback must not influence them
    for (const key of ["writing", "throwing", "toothbrush", "spoon"]) {
      expect(at(key)).toBeLessThan(at("lq_feedback"));
    }
    // The result leads; the number supports it.
    expect(fb?.item.stem.text).toBe("Your answers suggest you're {band}");
    const band = fb?.item.stem.pipes?.["band"];
    expect(band?.kind).toBe("score");
    expect(band?.scoringKey).toBe("score.ehi_sf");
    expect(band?.output).toBe("lq_band");
    expect(band?.fallback).toBeTruthy(); // never shows a raw placeholder
    expect(fb?.item.lede?.pipes?.["lq"]?.output).toBe("lq");
    // and the release actually carries the scoring it refers to
    expect(manifest.scoring["score.ehi_sf"]).toBeDefined();
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

describe("the SDQ form by age, in the release participants run (D-51)", () => {
  const current = releaseManifest.parse(currentManifest);
  const units = flattenManifest(current).units;
  const dob = { instrument: "ybm_identity", item: "dob", revision: 1 };
  const started = new Date("2026-09-29T09:10:00Z");
  const sdqShown = (iso: string | null, at: Date | null = started) => {
    const store = new AnswerStore();
    if (iso) store.set(dob, { status: "answered", value: { kind: "date", iso } });
    const visible = new Walker(units, store, true, at ?? undefined).visibleUnits().map((i) => units[i]!);
    return [...new Set(visible.filter((u) => u.instrument.startsWith("sdq") && u.item.responseType !== "info").map((u) => u.instrument))];
  };

  it("gives a 15-year-old the 11–17 form, word for word", () => {
    expect(sdqShown("2011-03-14")).toEqual(["sdq25_s"]);
    const q20 = units.find((u) => u.instrument === "sdq25_s" && u.item.key === "q20")!.item;
    expect(q20.stem.text).toBe("I often volunteer to help others (parents, teachers, children)");
  });

  it("gives someone 18 or over on the day of the sitting the 18+ form", () => {
    expect(sdqShown("2008-09-29")).toEqual(["sdq25_s18"]); // 18th birthday today
    expect(sdqShown("2008-09-30")).toEqual(["sdq25_s"]); // 18 tomorrow
    expect(sdqShown("1999-06-01")).toEqual(["sdq25_s18"]);
  });

  it("falls back to the 11–17 form without a date of birth or a sitting date", () => {
    expect(sdqShown(null)).toEqual(["sdq25_s"]);
    expect(sdqShown("1999-06-01", null)).toEqual(["sdq25_s"]);
  });
});

describe("the home address (D-52)", () => {
  const current = releaseManifest.parse(currentManifest);
  const units = flattenManifest(current).units;

  it("asks for the address instead of a secret code, on one screen", () => {
    const identity = units.filter((u) => u.instrument === "ybm_identity").map((u) => u.item.key);
    expect(identity).toEqual(["first_name", "last_name", "dob", "home_address"]);
    const address = units.find((u) => u.item.key === "home_address")!.item;
    expect(address.responseType).toBe("form_fields");
    if (address.responseType !== "form_fields") return;
    expect(address.fields.map((f) => f.key)).toEqual(["postcode", "house", "street"]);
    // every part optional: a participant gives what they know
    expect(address.fields.every((f) => !f.required)).toBe(true);
    expect(address.identifying).toBe(true);
  });

  it("checks postcodes against exactly the list the release pins", async () => {
    const { createHash } = await import("node:crypto");
    const { POSTCODE_LISTS, postcodeList } = await import("./lib/postcodes.js");
    for (const [asset, pinned] of Object.entries(current.assets).filter(([k]) => k.startsWith("postcodes_"))) {
      const text = POSTCODE_LISTS[asset];
      expect(text, asset).toBeDefined();
      expect(`sha256:${createHash("sha256").update(text!, "utf8").digest("hex")}`, asset).toBe(pinned.sha256);
    }
    const list = postcodeList("postcodes_west_yorkshire")!;
    expect(list.lookup("ls2 9jt")).toEqual({ ward: "Little London & Woodhouse", district: "Leeds" });
    expect(list.lookup("HG1 1AA")).toBeNull();
    expect(postcodeList("no_such_list")).toBeNull();
  });
});

describe("shorter consent, sleep quality and sanity checks (D-53, in the r9.0.0 candidate)", () => {
  const current = releaseManifest.parse(candidateManifest);
  const units = flattenManifest(current).units;
  const find = (instrument: string, key: string) => units.find((u) => u.instrument === instrument && u.item.key === key)!.item;

  it("searches streets against exactly the list the release pins", async () => {
    const { createHash } = await import("node:crypto");
    const { STREET_LISTS, streetList } = await import("./lib/streets.js");
    const pinned = current.assets["streets_west_yorkshire"]!;
    const text = await STREET_LISTS["streets_west_yorkshire"]!();
    expect(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`).toBe(pinned.sha256);
    const list = (await streetList("streets_west_yorkshire"))!;
    expect(list.search("hyde park rd")[0]?.street).toBe("Hyde Park Road");
    expect(await streetList("no_such_list")).toBeNull();
  });

  it("walks consent, which includes record linkage, then 'why it matters'", () => {
    const keys = units.filter((u) => u.instrument === "ybm_intro_consent").map((u) => u.item.key);
    expect(keys).toEqual(["intro", "consent", "why_it_matters"]);
    expect(find("ybm_intro_consent", "consent")).toMatchObject({ autoAdvance: true });
    expect(find("ybm_intro_consent", "why_it_matters")).toMatchObject({ advanceLabel: "I understand" });
  });

  it("asks sleep quality just before sleepiness", () => {
    const at = (inst: string) => units.findIndex((u) => u.instrument === inst && u.item.responseType !== "info");
    expect(at("sqs")).toBeGreaterThan(-1);
    expect(at("sqs")).toBeLessThan(at("kss"));
    expect(find("sqs", "q1")).toMatchObject({ responseType: "single_choice", presentation: "numbered" });
  });

  it("asks how family manage social media only after a yes, and what else only after 'something else'", () => {
    const store = new AnswerStore();
    for (const item of ["own", "sm_use"]) {
      store.set({ instrument: "ybm_smartphone", item, revision: 1 }, { status: "answered", value: { kind: "choice", code: 1 } });
    }
    const shown = () => {
      const walker = new Walker(units, store, true);
      return walker.visibleUnits().map((i) => units[i]!.item.key);
    };
    const control = { instrument: "ybm_social_media", item: "family_control", revision: 1 };
    store.set(control, { status: "answered", value: { kind: "choice", code: 2 } });
    expect(shown()).not.toContain("family_control_how");
    store.set(control, { status: "answered", value: { kind: "choice", code: 1 } });
    expect(shown()).toContain("family_control_how");
    expect(shown()).not.toContain("family_control_other");
    store.set({ instrument: "ybm_social_media", item: "family_control_how", revision: 1 }, { status: "answered", value: { kind: "multi", codes: [1, 8] } });
    expect(shown()).toContain("family_control_other");
  });

  it("stops asking about Polish once 'another language' goes back to No", () => {
    // The live repro: Yes, tick Polish, answer the Polish questions, go back, No.
    const at = (item: string) => ({ instrument: "ybm_demographics", item, revision: 1 });
    const store = new AnswerStore();
    store.set(at("speaks_other_language"), { status: "answered", value: { kind: "choice", code: 1 } });
    store.set(at("other_languages"), { status: "answered", value: { kind: "multi", codes: [3] } });
    store.set(at("understand_polish"), { status: "answered", value: { kind: "choice", code: 4 } });
    const walker = new Walker(units, store, true);
    const polish = () => walker.visibleUnits().map((i) => units[i]!.item.key).filter((k) => /polish|other_languages/.test(k));
    expect(polish()).toEqual(["other_languages", "understand_polish", "speak_polish"]);
    store.set(at("speaks_other_language"), { status: "answered", value: { kind: "choice", code: 2 } });
    expect(polish()).toEqual([]);
    const from = units.findIndex((u) => u.item.key === "speaks_other_language");
    expect(units[walker.next(from)!]!.item.key).not.toMatch(/polish|language/);
  });
});
