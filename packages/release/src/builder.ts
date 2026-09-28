import { releaseManifest, type ReleaseManifest } from "@myself/schema";
import type { assessmentDraft } from "@myself/schema";
import type { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import { freezeRelease, PublishGateError, type PublishMeta, type Registries } from "./gate.js";

/**
 * Release builder + publish gate. Resolves a draft composition against the
 * library registries, runs the gate checks, and freezes everything into a
 * content-hashed manifest. Publishing NEVER mutates inputs; a manifest is
 * immutable once hashed (docs/06 §3).
 *
 * The gate and the freeze live in gate.ts, which a browser can load; this adds
 * the hash, which needs node:crypto.
 */

export { PublishGateError, type PublishMeta, type Registries };

export function buildRelease(
  draftInput: z.input<typeof assessmentDraft>,
  registries: Registries,
  meta: PublishMeta,
): ReleaseManifest {
  const { body, failures } = freezeRelease(draftInput, registries, meta);
  if (failures.length > 0) throw new PublishGateError(failures);
  const hash = contentHash(body);
  return releaseManifest.parse({ ...body, hash });
}

export function verifyManifestHash(manifest: ReleaseManifest): boolean {
  const { hash, ...body } = manifest;
  return hash !== undefined && contentHash(body) === hash;
}

export { canonicalJson, contentHash };
