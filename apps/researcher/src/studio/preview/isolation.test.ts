import { describe, expect, it } from "vitest";
import ts from "typescript";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPreviewBundle, FORBIDDEN_TEXT, forbiddenModule, type ChunkLike } from "./bundle-guard.js";

/**
 * The preview can never touch production data — docs/16 risk R7.
 *
 * Proved from the source, statically: every module the preview frame can
 * load is found by following imports from frame.tsx, the way the bundler
 * does, and none of them is the participant's storage, device, upload or
 * export code, nor any library that could store or send. The build checks
 * the same list against the real bundle (vite.config.ts); this catches it
 * sooner, and without a build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const participantSrc = join(repo, "apps/participant/src");
const researcherSrc = join(repo, "apps/researcher/src");
const participantStyles = join(participantSrc, "styles.css");

interface Graph {
  /** Source files reached, absolute. */
  files: Set<string>;
  /** Stylesheets reached, absolute. */
  styles: Set<string>;
  /** Third-party packages reached, by package name. */
  packages: Set<string>;
  /** Identifiers, strings and JSX text in the reached sources — no comments. */
  words: Map<string, string[]>;
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

type Resolved = { kind: "file"; path: string } | { kind: "package"; name: string };

/** Resolve an import as vite.config.ts does: the @participant alias, workspace packages from source. */
function resolveImport(spec: string, from: string): Resolved {
  let base: string;
  if (spec.startsWith("@participant/")) base = join(participantSrc, spec.slice("@participant/".length));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else if (spec.startsWith("@myself/")) {
    const [, pkg, ...sub] = spec.split("/");
    base = join(repo, "packages", pkg!, "src", sub.length > 0 ? sub.join("/") : "index");
  } else {
    const parts = spec.split("/");
    return { kind: "package", name: spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]! };
  }
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ];
  const found = candidates.find(isFile);
  if (!found) throw new Error(`Could not resolve "${spec}" from ${relative(repo, from)}`);
  return { kind: "file", path: found };
}

/** The runtime imports of a source file (type-only imports are erased, so skipped) and the words in it. */
function scan(path: string): { imports: string[]; words: string[] } {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports: string[] = [];
  const words: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) words.push(node.text);
    else if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) words.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, words };
}

function importGraph(entry: string): Graph {
  const graph: Graph = { files: new Set(), styles: new Set(), packages: new Set(), words: new Map() };
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.files.has(file)) continue;
    graph.files.add(file);
    if (file.endsWith(".json")) continue;
    const { imports, words } = scan(file);
    graph.words.set(file, words);
    for (const spec of imports) {
      const target = resolveImport(spec, file);
      if (target.kind === "package") graph.packages.add(target.name);
      else if (target.path.endsWith(".css")) graph.styles.add(target.path);
      else queue.push(target.path);
    }
  }
  return graph;
}

const frame = importGraph(join(here, "frame.tsx"));

describe("the preview frame's reach", () => {
  it("runs the participant's own screens (so this check is not vacuous)", () => {
    for (const file of ["components/SurveyScreen.tsx", "components/ReviewScreen.tsx", "components/controls.tsx", "lib/flatten.ts", "lib/pipes.ts"]) {
      expect(frame.files).toContain(join(participantSrc, file));
    }
    expect(frame.files).toContain(join(repo, "packages/engine/src/walker.ts"));
  });

  it("reaches none of the participant's storage, device, upload or export code", () => {
    const hits = [...frame.files].flatMap((file) => {
      const hit = forbiddenModule(file);
      return hit ? [`${relative(repo, file)} — ${hit.why}`] : [];
    });
    expect(hits).toEqual([]);
    for (const lib of ["db", "sync", "device", "identity", "export"]) {
      expect(frame.files).not.toContain(join(participantSrc, `lib/${lib}.ts`));
    }
  });

  it("uses no library but React and zod — no Dexie, no Firebase, no service worker", () => {
    expect([...frame.packages].sort()).toEqual(["react", "react-dom", "zod"]);
  });

  it("contains no code that names IndexedDB, Dexie, saveSitting or the upload URL", () => {
    const hits: string[] = [];
    for (const [file, words] of frame.words) {
      for (const word of FORBIDDEN_TEXT) {
        if (words.some((w) => w.includes(word))) hits.push(`${relative(repo, file)}: ${word}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("is the only place the participant stylesheet is loaded", () => {
    expect([...frame.styles]).toContain(participantStyles);

    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) {
          for (const spec of scan(path).imports) {
            const target = resolveImport(spec, path);
            if (target.kind === "file" && target.path === participantStyles) importers.push(relative(researcherSrc, path));
          }
        }
      }
    };
    walk(researcherSrc);
    expect(importers).toEqual(["studio/preview/frame.tsx"]);

    // And the Studio's side of the preview does not pull it in by another route.
    const page = importGraph(join(here, "PreviewPage.tsx"));
    expect([...page.styles]).not.toContain(participantStyles);
  });
});

describe("preview.html's content security policy (the second lock)", () => {
  // Nothing else would notice if the policy were dropped or loosened: the
  // frame works exactly the same without it until something tries to send.
  const html = readFileSync(join(repo, "apps/researcher/preview.html"), "utf8");
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  const directives = new Map(
    (meta?.[1] ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name!, values.join(" ")] as const),
  );

  it("refuses every way out: connections, workers, frames, forms, and images or media from elsewhere", () => {
    expect(meta).not.toBeNull();
    expect(directives.get("connect-src")).toBe("'none'");
    expect(directives.get("worker-src")).toBe("'none'");
    expect(directives.get("frame-src")).toBe("'none'");
    expect(directives.get("media-src")).toBe("'none'");
    expect(directives.get("form-action")).toBe("'none'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("img-src")).toBe("'self' data:");
    // A default-src would also govern connect-src if the explicit one went;
    // there is none, so the explicit ones above are the whole guarantee.
    expect(directives.has("default-src")).toBe(false);
  });

  it("comes before anything the page loads, so it governs all of it", () => {
    expect(meta).not.toBeNull();
    expect(html.indexOf(meta![0])).toBeLessThan(html.indexOf("<script"));
    expect(html.indexOf(meta![0])).toBeLessThan(html.indexOf("<body"));
  });
});

describe("the build's check of the preview bundle", () => {
  const chunk = (fileName: string, over: Partial<ChunkLike> = {}): ChunkLike => ({
    type: "chunk",
    fileName,
    isEntry: false,
    facadeModuleId: null,
    imports: [],
    dynamicImports: [],
    moduleIds: [],
    code: "",
    ...over,
  });
  const entry = (over: Partial<ChunkLike> = {}) =>
    chunk("assets/preview.js", { isEntry: true, facadeModuleId: "/repo/apps/researcher/preview.html", ...over });

  it("passes a preview that reaches only the screens", () => {
    const bundle = {
      "assets/preview.js": entry({ imports: ["assets/shared.js"], moduleIds: ["/repo/apps/participant/src/components/SurveyScreen.tsx"] }),
      "assets/shared.js": chunk("assets/shared.js", { moduleIds: ["/repo/node_modules/.pnpm/zod@3.23.8/node_modules/zod/lib/index.mjs"] }),
      // The Studio's own entry may use anything; the frame never loads it.
      "assets/main.js": chunk("assets/main.js", {
        isEntry: true,
        facadeModuleId: "/repo/apps/researcher/index.html",
        moduleIds: ["/repo/node_modules/.pnpm/dexie@4.4.4/node_modules/dexie/dist/dexie.mjs"],
        code: "indexedDB.open('x')",
      }),
      "assets/preview.css": { type: "asset" as const },
    };
    expect(auditPreviewBundle(bundle)).toEqual([]);
  });

  it("fails a preview that reaches storage through a shared or lazily loaded chunk", () => {
    const bundle = {
      "assets/preview.js": entry({ imports: ["assets/shared.js"], dynamicImports: ["assets/later.js"] }),
      "assets/shared.js": chunk("assets/shared.js", { moduleIds: ["/repo/node_modules/.pnpm/dexie@4.4.4/node_modules/dexie/dist/dexie.mjs"] }),
      "assets/later.js": chunk("assets/later.js", {
        moduleIds: ["/repo/apps/participant/src/lib/sync.ts"],
        code: 'fetch(__SITTINGS_URL__)',
      }),
    };
    const problems = auditPreviewBundle(bundle);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/dexie/);
    expect(problems.join("\n")).toMatch(/lib\/sync\.ts/);
    expect(problems.join("\n")).toMatch(/__SITTINGS_URL__/);
  });

  it("fails rather than passes when it cannot find the preview at all", () => {
    expect(auditPreviewBundle({ "assets/main.js": chunk("assets/main.js", { isEntry: true, facadeModuleId: "/x/index.html" }) })).toHaveLength(1);
  });
});
