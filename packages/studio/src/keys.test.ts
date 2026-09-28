import { describe, expect, it } from "vitest";
import {
  generateItemKey,
  generateScaleKey,
  generateSectionKey,
  generateVariable,
  MAX_KEY_LENGTH,
  MAX_VARIABLE_LENGTH,
  slugify,
  SLUG_PATTERN,
} from "./keys.js";

describe("slugify", () => {
  it("makes lowercase snake_case from any text", () => {
    expect(slugify("Sleep & rest")).toBe("sleep_rest");
    expect(slugify("  How you've been feeling  ")).toBe("how_youve_been_feeling");
    expect(slugify("Café au lait")).toBe("cafe_au_lait");
    expect(slugify("Hours of {game_1} per week")).toBe("hours_of_per_week");
    expect(slugify("!!!")).toBe("");
  });
});

describe("generateItemKey", () => {
  it("makes a key from the meaningful words of the question", () => {
    expect(generateItemKey("Do you have your own smartphone?", new Set())).toBe("have_own_smartphone");
    expect(generateItemKey("How many hours do you sleep on a school night?", new Set())).toBe("many_hours_sleep_school_night");
  });

  it("keeps within 40 characters, cutting at a word", () => {
    const key = generateItemKey(
      "Roughly how much of the time you spend gaming per week is spent playing with others?",
      new Set(),
    );
    expect(key.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
    expect(key).toMatch(SLUG_PATTERN);
    expect(key.endsWith("_")).toBe(false);
  });

  it("falls back to q when the text gives nothing usable, and prefixes q_ before a digit", () => {
    expect(generateItemKey("", new Set())).toBe("q");
    expect(generateItemKey("?!", new Set())).toBe("q");
    expect(generateItemKey("5 a day?", new Set())).toBe("q_5_day");
  });

  it("adds a number until the key is free, counting reserved keys as taken", () => {
    const taken = new Set(["have_own_smartphone", "have_own_smartphone_2"]);
    expect(generateItemKey("Do you have your own smartphone?", taken)).toBe("have_own_smartphone_3");
    expect(generateItemKey("", new Set(["q"]))).toBe("q_2");
  });

  it("stays within the limit when a suffix is added", () => {
    const long = "abcdefghij klmnopqrst uvwxyzabcd efghijklmn";
    const first = generateItemKey(long, new Set());
    const second = generateItemKey(long, new Set([first]));
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
    expect(second).toMatch(/_2$/);
  });
});

describe("generateVariable", () => {
  it("makes a unique variable name within 32 characters", () => {
    expect(generateVariable("have_own_smartphone", new Set())).toBe("have_own_smartphone");
    expect(generateVariable("have_own_smartphone", new Set(["have_own_smartphone"]))).toBe("have_own_smartphone_2");
    const long = generateVariable("a_very_long_variable_name_that_goes_on_and_on", new Set());
    expect(long.length).toBeLessThanOrEqual(MAX_VARIABLE_LENGTH);
    expect(long).toMatch(SLUG_PATTERN);
    expect(generateVariable("9lives", new Set())).toBe("v_9lives");
  });
});

describe("generateScaleKey and generateSectionKey", () => {
  it("names a question's own option list after it, uniquely", () => {
    expect(generateScaleKey("ybm_studio", "pets", new Set())).toBe("scale.ybm_studio_pets");
    expect(generateScaleKey("ybm_studio", "pets", new Set(["scale.ybm_studio_pets"]))).toBe("scale.ybm_studio_pets_2");
  });

  it("names a section after its title, uniquely", () => {
    expect(generateSectionKey("Your pets", new Set())).toBe("your_pets");
    expect(generateSectionKey("Your pets", new Set(["your_pets"]))).toBe("your_pets_2");
    expect(generateSectionKey("", new Set())).toBe("section");
    expect(generateSectionKey("2027 follow-up", new Set())).toBe("s_2027_follow_up");
  });
});
