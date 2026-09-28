import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The preview's announcements ("The draft changed, so the preview
 * restarted…") reach a screen reader only if the live region holding them is
 * in the accessibility tree before the words arrive. announce() empties the
 * region before every message, so a rule hiding it while empty meant each
 * message appeared in a region that had just been out of the tree — which
 * Chrome does not announce. No test renders the page, so this pins the CSS.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "preview.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const page = readFileSync(join(here, "PreviewPage.tsx"), "utf8");

describe("the preview's live region", () => {
  it("is a status region", () => {
    expect(page).toMatch(/className="st-pv-announce" role="status"/);
  });

  it("is never taken out of the accessibility tree, empty or not", () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => selector!.includes("st-pv-announce"));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      expect(`${selector!.trim()} { ${body!.trim()} }`).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    }
  });
});
