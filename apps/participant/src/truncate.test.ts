import { describe, expect, it } from "vitest";
import { truncateText, wellFormed } from "./lib/text.js";

/**
 * Typed text cut to a limit (lib/text.ts). The server counts UTF-16 code
 * units and refuses a sitting holding half a surrogate pair, so a cut must
 * fit the limit AND leave every character whole.
 */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("cutting typed text to its limit", () => {
  it("leaves text within the limit alone", () => {
    expect(truncateText("hello", 5)).toBe("hello");
    expect(truncateText("hi 🎉", 5)).toBe("hi 🎉");
  });

  it("never splits an emoji, which slice(0, n) did", () => {
    const typed = "abcd🎉"; // 6 code units; the emoji straddles a limit of 5
    expect(loneSurrogate.test(typed.slice(0, 5))).toBe(true); // the old bug
    const cut = truncateText(typed, 5);
    expect(cut).toBe("abcd");
    expect(loneSurrogate.test(cut)).toBe(false);
    expect(cut.length).toBeLessThanOrEqual(5);
  });

  it("keeps a grapheme of several code points whole, or drops it whole", () => {
    expect(truncateText("ok👍🏽", 4)).toBe("ok"); // thumbs up + skin tone is four code units
    expect(truncateText("ok👍🏽", 6)).toBe("ok👍🏽");
    expect(truncateText("go🇬🇧", 4)).toBe("go");
  });

  it("always fits the limit as the server counts it, whatever is typed", () => {
    const samples = ["🎉🎉🎉🎉", "a🎉b🎉c", "👨‍👩‍👧‍👦 family", "plain text", "é́ combining"];
    for (const sample of samples) {
      for (let max = 1; max <= sample.length + 1; max += 1) {
        const cut = truncateText(sample, max);
        expect(cut.length).toBeLessThanOrEqual(max);
        expect(loneSurrogate.test(cut)).toBe(false);
        expect(sample.startsWith(cut)).toBe(true);
      }
    }
  });

  it("repairs a lone surrogate already in the text", () => {
    expect(wellFormed("a\uD83Cb")).toBe("a�b");
    expect(wellFormed("a\uDF89")).toBe("a�");
    expect(wellFormed("🎉")).toBe("🎉");
    expect(loneSurrogate.test(truncateText("x\uD83C", 10))).toBe(false);
  });
});
