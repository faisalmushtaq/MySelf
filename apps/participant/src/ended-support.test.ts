import { describe, expect, it } from "vitest";
import { supportFrom } from "./screens/EndedScreen.js";

describe("support on a sitting a researcher ended (D-82)", () => {
  it("is the finish screen's text after its thanks", () => {
    const body = "That's everything — thanks.\n\nIf any of the questions brought up difficult feelings, talk to someone.\n• Childline: 0800 1111\n\nIn danger, call 999.";
    expect(supportFrom(body)).toBe("If any of the questions brought up difficult feelings, talk to someone.\n• Childline: 0800 1111\n\nIn danger, call 999.");
  });
  it("is nothing when the finish screen only says thanks", () => {
    expect(supportFrom("That's everything — thanks.")).toBeNull();
    expect(supportFrom(undefined)).toBeNull();
  });
});
