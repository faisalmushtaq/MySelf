import { createHash } from "node:crypto";
import { canonicalJson } from "@myself/schema";

/**
 * SHA-256 content hashing for release manifests, synchronously, for Node.
 *
 * The serialisation itself lives in @myself/schema so the participant app and
 * the Studio hash exactly the same bytes this does (with WebCrypto, which is
 * asynchronous). The hash is computed with the manifest's `hash` field absent.
 */

export { canonicalJson };

export function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
