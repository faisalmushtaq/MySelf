import { describe, expect, it } from "vitest";
import { itemDefinition, responseScale } from "@myself/schema";
import { NOT_YET_SUPPORTED, QUESTION_TYPES, questionType, templateFor } from "./catalogue.js";
import { StudioOpError, studioTypeOf } from "./model.js";

describe("the question types offered", () => {
  const creatable = QUESTION_TYPES.filter((t) => t.canCreate);

  it("offers new questions only of types the participant app renders", () => {
    expect(creatable.map((t) => t.id)).toEqual([
      "short_text",
      "long_text",
      "single_choice",
      "dropdown",
      "yes_no",
      "rating",
      "slider",
      "multiple_choice",
      "number",
      "date",
      "info",
      "consent",
      "time_grid",
    ]);
    expect(QUESTION_TYPES.filter((t) => !t.canCreate).map((t) => t.id)).toEqual(["ladder", "form_fields", "rank_group"]);
  });

  it.each(creatable.map((t) => t.id))("starts a %s question that the schema accepts and reads back as that type", (id) => {
    const { item, scale } = templateFor(id, { key: "pets", variable: "pets", text: "Do you have pets?", instrument: "ybm_studio" });
    expect(() => itemDefinition.parse(item)).not.toThrow();
    // Every default is written out, so the draft holds exactly what freezes.
    expect(itemDefinition.parse(item)).toEqual(item);
    expect(item.revision).toBe(1);
    expect(item.identifying).toBe(false);
    expect(item.allowDecline).toBe(false);
    expect(item.responseType).toBe(questionType(id).responseType);
    if (scale) {
      expect(() => responseScale.parse(scale)).not.toThrow();
      expect(scale.key).toBe("scale.ybm_studio_pets");
      expect(scale.version).toBe("1.0.0");
      expect(scale.options.map((o) => o.code)).toEqual(scale.options.map((_, i) => i + 1));
      expect("scale" in item && item.scale).toBe(scale.key);
    }
    expect(studioTypeOf(item, scale)).toBe(id);
  });

  it("codes Yes/No as the library does, Yes = 1 and No = 2", () => {
    const { scale } = templateFor("yes_no", { key: "pets", variable: "pets", text: "Pets?" });
    expect(scale?.options.map((o) => [o.code, o.label])).toEqual([
      [1, "Yes"],
      [2, "No"],
    ]);
  });

  it("lays a rating out as five labelled points in ascending order", () => {
    const { item, scale } = templateFor("rating", { key: "calm", variable: "calm", text: "How calm are you?" });
    expect(item.responseType === "single_choice" && item.presentation).toBe("spectrum");
    expect(scale?.direction).toBe("ascending");
    expect(scale?.options).toHaveLength(5);
  });

  it("uses a given scale key", () => {
    const { scale } = templateFor("dropdown", { key: "x", variable: "x", text: "X", scaleKey: "scale.custom" });
    expect(scale?.key).toBe("scale.custom");
  });

  it("refuses to start a type that can only be edited where it exists", () => {
    expect(() => templateFor("ladder", { key: "x", variable: "x", text: "X" })).toThrow(StudioOpError);
    expect(() => questionType("matrix")).toThrow(StudioOpError);
  });

  it("says why the Likert grid is not offered", () => {
    const matrix = NOT_YET_SUPPORTED.find((t) => t.id === "matrix");
    expect(matrix?.label).toBe("Likert grid on one screen");
    expect(matrix?.reason).toMatch(/one question per screen/);
    expect(NOT_YET_SUPPORTED.map((t) => t.id)).toEqual(
      expect.arrayContaining(["file_upload", "media", "randomised_options"]),
    );
  });
});
