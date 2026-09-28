import { administeredItems, compareVersions, formFor, refKeyOf } from "@myself/release/gate";
import type { InstrumentForm } from "@myself/schema";
import { normaliseRef } from "./walk.js";

/**
 * What published versions leave behind for the next one.
 *
 * A question ID or analysis variable that any published version used is
 * reserved forever: data collected under it is read back through that name,
 * so giving it to a different question would put two questions' answers in one
 * column. Likewise an option code that meant one answer must never come to mean
 * another. These functions read those facts out of frozen manifests so the
 * editor and the publishing function can hold every new draft to them.
 */

export interface ManifestIndex {
  /** Every question the release administers, as `<instrument>.<key>`, in administered order. */
  itemKeys: string[];
  /**
   * The analysis variable of each of those questions — aligned with `itemKeys`,
   * so `variables[i]` is the column `itemKeys[i]` was recorded under.
   */
  variables: string[];
}

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The questions a release administers, and their variables, read straight from
 * the manifest JSON.
 *
 * Deliberately not through the schema: releases before r5 no longer parse
 * (docs/16 R12), and what a release reserved does not depend on whether today's
 * schema still accepts it. Subset-aware, so a question defined in a frozen
 * instrument but not placed by any subset is not counted as administered.
 *
 * Throws when the manifest cannot be read. Reservation fails closed: a
 * manifest silently read as "administers nothing" would release every ID it
 * used for reuse.
 */
export function manifestIndex(manifest: unknown): ManifestIndex {
  const m = isObject(manifest) ? manifest : null;
  const composition = m && isObject(m["composition"]) ? m["composition"] : null;
  const sections = composition && Array.isArray(composition["sections"]) ? (composition["sections"] as unknown[]) : null;
  const instruments = m && isObject(m["instruments"]) ? m["instruments"] : null;
  if (!sections || !instruments) throw new Error("This is not a release manifest: it has no composition or no instruments.");

  const itemKeys: string[] = [];
  const variables: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    const components = isObject(section) && Array.isArray(section["components"]) ? (section["components"] as unknown[]) : [];
    for (const component of components) {
      if (!isObject(component) || (component["kind"] !== "instrument" && component["kind"] !== "module")) continue;
      if (!isObject(component["ref"])) throw new Error("The release places a block without saying which instrument it is.");
      const ref = normaliseRef(component["ref"] as Parameters<typeof normaliseRef>[0]);
      const refKey = refKeyOf(ref);
      const def = instruments[refKey];
      const forms = isObject(def) && Array.isArray(def["forms"]) ? (def["forms"] as InstrumentForm[]) : [];
      const form = formFor({ forms }, ref) ?? forms[0];
      if (!form || !Array.isArray(form.items)) {
        throw new Error(`The release places '${refKey}', but the instrument it freezes is missing or has no questions.`);
      }
      const subset = Array.isArray(component["items"]) ? (component["items"] as string[]) : undefined;
      for (const item of administeredItems(form, subset).items) {
        const itemKey = `${ref.instrument}.${item.key}`;
        if (seen.has(itemKey)) continue;
        seen.add(itemKey);
        itemKeys.push(itemKey);
        variables.push(item.variable);
      }
    }
  }
  return { itemKeys, variables };
}

export interface ReservedIds {
  itemKeys: ReadonlySet<string>;
  variables: ReadonlySet<string>;
  /**
   * The variable(s) each reserved question was published with, where the
   * versions recorded them aligned (see `ManifestIndex`). It is what lets
   * validation tell a question restored from an old version — same ID, same
   * variable — from a new question that happens to reuse an old ID.
   */
  variablesByItem?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Everything any published version reserved. */
export function reservedFrom(versions: { itemKeys: string[]; variables: string[] }[]): ReservedIds {
  const itemKeys = new Set<string>();
  const variables = new Set<string>();
  const variablesByItem = new Map<string, Set<string>>();
  let aligned = true;
  for (const version of versions) {
    for (const key of version.itemKeys ?? []) itemKeys.add(key);
    for (const variable of version.variables ?? []) variables.add(variable);
    if ((version.itemKeys?.length ?? 0) !== (version.variables?.length ?? 0)) {
      aligned = false;
      continue;
    }
    version.itemKeys.forEach((key, i) => {
      const variable = version.variables[i]!;
      const set = variablesByItem.get(key) ?? new Set<string>();
      set.add(variable);
      variablesByItem.set(key, set);
    });
  }
  // A version whose lists do not line up cannot say which variable went with
  // which question; pairing the rest would then under-report, so none is kept.
  return aligned ? { itemKeys, variables, variablesByItem } : { itemKeys, variables };
}

/**
 * Every option code each scale has published, with the label it last meant.
 *
 * Later releases win, so a label deliberately changed in an earlier release is
 * compared with what it became, not what it started as. Tolerant of old or
 * malformed manifests: this only feeds warnings.
 */
export function publishedScaleCodes(manifests: unknown[]): Map<string, Map<number, string>> {
  const ordered = manifests
    .filter(isObject)
    .map((m) => ({ m, version: isObject(m["release"]) && typeof m["release"]["version"] === "string" ? m["release"]["version"] : "0.0.0" }))
    .sort((a, b) => compareVersions(a.version, b.version));
  const out = new Map<string, Map<number, string>>();
  for (const { m } of ordered) {
    const scales = isObject(m["scales"]) ? m["scales"] : {};
    for (const [scaleKey, scale] of Object.entries(scales)) {
      if (!isObject(scale) || !Array.isArray(scale["options"])) continue;
      const codes = out.get(scaleKey) ?? new Map<number, string>();
      for (const option of scale["options"] as unknown[]) {
        if (!isObject(option) || typeof option["code"] !== "number" || typeof option["label"] !== "string") continue;
        codes.set(option["code"], option["label"]);
      }
      out.set(scaleKey, codes);
    }
  }
  return out;
}
