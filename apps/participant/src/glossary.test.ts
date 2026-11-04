import { describe, expect, it } from "vitest";
import { glossSegments } from "./lib/glossary.js";

const G = [
  { term: "optimistic", explanation: "Feeling hopeful that good things will happen." },
  { term: "appetite", explanation: "How much you feel like eating." },
  { term: "bad news", explanation: "Posts or stories that are upsetting or worrying." },
  { term: "news", explanation: "What is happening in the world." },
];
const terms = (text: string) => glossSegments(text, G).filter((s) => s.kind === "term").map((s) => s.text);

describe("word explanations (D-79)", () => {
  it("finds explained words, in any case, and leaves the text whole", () => {
    const text = "I’ve been feeling Optimistic about the future";
    expect(terms(text)).toEqual(["Optimistic"]);
    expect(glossSegments(text, G).map((s) => s.text).join("")).toBe(text);
  });

  it("matches whole words only, and the longest phrase first", () => {
    expect(terms("I have problems with my appetite.")).toEqual(["appetite"]);
    expect(terms("My appetites are odd")).toEqual([]);
    expect(terms("I feel an urge to seek bad news on social media")).toEqual(["bad news"]);
    expect(terms("I read the news")).toEqual(["news"]);
  });

  it("marks each word once per text", () => {
    expect(terms("optimistic, then optimistic again")).toEqual(["optimistic"]);
  });

  it("leaves text alone with no explanations", () => {
    expect(glossSegments("Nothing to see", [])).toEqual([{ kind: "text", text: "Nothing to see" }]);
    expect(glossSegments("Nothing to see", undefined)).toEqual([{ kind: "text", text: "Nothing to see" }]);
  });
});

describe("explained words on screen (D-79)", () => {
  it("are buttons around the words, and the rest of the text is untouched", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Glossed } = await import("./components/Glossed.js");
    const html = renderToStaticMarkup(createElement(Glossed, { text: "I have problems with my appetite.", glossary: G, open: null, onOpen: () => {} }));
    expect(html).toBe(
      '<span>I have problems with my </span><span class="gloss-keep"><button type="button" class="gloss" aria-expanded="false" aria-controls="gloss-note">appetite</button>.</span>',
    );
    const plain = renderToStaticMarkup(createElement(Glossed, { text: "Nothing here", glossary: G, open: null, onOpen: () => {} }));
    expect(plain).toBe("Nothing here");
  });
});
