import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "./hash.js";

/**
 * The prompt hash has to be the same number in a Cloud Function, in a test and
 * in a browser, or two records of the same call stop matching. Checked against
 * the published vectors and against Node's own implementation.
 */
describe("sha256", () => {
  it("matches the published test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("agrees with Node on the things this actually hashes", () => {
    const prompts = [
      "system: You are helping a research study.\nuser: Tell me about school.",
      "a".repeat(1000),
      "unicode: café — naïve … 🙂",
      "x".repeat(64),
      "y".repeat(119),
      "z".repeat(120),
    ];
    for (const prompt of prompts) {
      expect(sha256Hex(prompt), prompt.slice(0, 20)).toBe(createHash("sha256").update(prompt).digest("hex"));
    }
  });

  it("agrees on lengths either side of every block boundary", () => {
    // Padding is where a hand-written implementation goes wrong.
    for (let n = 0; n < 200; n += 1) {
      const text = "m".repeat(n);
      expect(sha256Hex(text), `length ${n}`).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });
});
