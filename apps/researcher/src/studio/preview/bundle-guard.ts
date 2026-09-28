/**
 * What the preview frame must never contain — docs/16 risk R7.
 *
 * The participant app keeps every answer in IndexedDB on this same origin and
 * uploads sittings from it. The preview runs the participant's own screens,
 * so the line between "the participant's components" and "the participant's
 * storage" is the whole of the guarantee that a researcher trying a draft can
 * never put a row in the study's data. It is drawn here, once, and checked
 * twice: by a unit test over the source import graph, and by the build, which
 * refuses to emit a preview bundle that crosses it.
 */

export interface Forbidden {
  /** Matched against a module id: an absolute, forward-slashed file path or a virtual id. */
  pattern: RegExp;
  why: string;
}

export const FORBIDDEN_MODULES: Forbidden[] = [
  {
    pattern: /apps\/participant\/src\/lib\/(db|sync|device|identity|export|durability|space|updates|crypto|ulid)\.ts$/,
    why: "the participant app's storage, device identity, upload and export code",
  },
  {
    pattern: /apps\/participant\/src\/(App|main)\.tsx$/,
    why: "the participant app itself, which opens the device database at start-up",
  },
  { pattern: /(^|\/)node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?dexie\//, why: "the IndexedDB library" },
  {
    pattern: /(^|\/)node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(firebase|@firebase)\//,
    why: "the Firebase SDK, which could write to the study's project",
  },
  {
    pattern: /(^|\/)node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?workbox-[^/]+\//,
    why: "service-worker code, which would put the preview in the participant's offline cache",
  },
  { pattern: /virtual:pwa-register/, why: "service-worker registration" },
  { pattern: /packages\/(store|firebase)\//, why: "sync, ingest and Firestore code" },
  {
    pattern: /apps\/researcher\/src\/(lib|studio\/data)\//,
    why: "the researcher view's data layer, which signs in and reads the study",
  },
];

/**
 * Words that only storage or upload code contains. An undefined `define` is
 * left in the bundle as a bare name, so the participant's upload URL would
 * show up here even if the module that reads it were renamed.
 */
export const FORBIDDEN_TEXT = ["indexedDB", "Dexie", "saveSitting", "__SITTINGS_URL__", "serviceWorker"] as const;

export function forbiddenModule(id: string): Forbidden | null {
  const normal = id.replace(/\\/g, "/");
  return FORBIDDEN_MODULES.find((f) => f.pattern.test(normal)) ?? null;
}

/** The parts of a Rollup output chunk this check reads. */
export interface ChunkLike {
  type: "chunk";
  fileName: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  moduleIds: string[];
  code: string;
}

/**
 * Every problem with the preview entry's part of a built bundle: a forbidden
 * module anywhere in the chunks it loads, statically or on demand, or a
 * forbidden word in their code.
 *
 * Chunks shared with the Studio's own entry are included, because the frame
 * loads them too; Rollup only shares a chunk between entries that both use
 * every module in it, so this is exactly what the frame can execute.
 */
export function auditPreviewBundle(
  bundle: Record<string, ChunkLike | { type: "asset" }>,
  isPreviewEntry: (facadeModuleId: string) => boolean = (id) => /(^|\/)preview\.html$/.test(id.replace(/\\/g, "/")),
): string[] {
  const chunks = new Map<string, ChunkLike>();
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk") chunks.set(output.fileName, output);
  }
  const entries = [...chunks.values()].filter((c) => c.isEntry && c.facadeModuleId && isPreviewEntry(c.facadeModuleId));
  if (entries.length === 0) return ["No preview entry chunk was found in the bundle, so its isolation could not be checked."];

  const reached = new Set<string>();
  const queue = entries.map((c) => c.fileName);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const chunk = chunks.get(name);
    if (chunk) queue.push(...chunk.imports, ...chunk.dynamicImports);
  }

  const problems: string[] = [];
  for (const name of reached) {
    const chunk = chunks.get(name);
    if (!chunk) continue;
    for (const id of chunk.moduleIds) {
      const hit = forbiddenModule(id);
      if (hit) problems.push(`${name} contains ${id} — ${hit.why}.`);
    }
    for (const word of FORBIDDEN_TEXT) {
      if (chunk.code.includes(word)) problems.push(`${name} contains "${word}".`);
    }
  }
  return problems;
}
