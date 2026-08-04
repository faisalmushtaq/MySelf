import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the deploy tooling will see.
 *
 * These read the built bundle the way the Firebase CLI reads it — load the
 * module, look at each export's `__endpoint` — because every deployment
 * failure so far has been invisible from the source: a bundle outside the
 * project directory, a missing node_modules, and a region that silently did
 * not apply. None of them were type errors and none showed up in a unit test.
 */

const bundle = fileURLToPath(new URL("../../../infra/firebase/functions/index.js", import.meta.url));

const packaged = (): boolean => {
  if (existsSync(bundle)) return true;
  try {
    execFileSync("node", [fileURLToPath(new URL("../build-deploy.mjs", import.meta.url))], { stdio: "ignore" });
    return existsSync(bundle);
  } catch {
    return false;
  }
};

describe("what the deploy tooling will see", () => {
  it.runIf(packaged())("puts every function in europe-west2", async () => {
    // ES modules evaluate imports before the importing module's body, so
    // calling setGlobalOptions in index.ts ran AFTER every re-exported module
    // had defined its functions: the region silently did not apply and all
    // twelve would have deployed to us-central1 — the wrong continent from a
    // Firestore location that is permanent.
    process.env["GCLOUD_PROJECT"] ??= "myself-research";
    const module_ = (await import(bundle)) as Record<string, { __endpoint?: { region?: string | string[] } }>;

    const endpoints = Object.entries(module_).filter(([, v]) => v?.__endpoint);
    expect(endpoints.length).toBeGreaterThanOrEqual(12);

    for (const [name, fn] of endpoints) {
      const region = fn.__endpoint?.region;
      const first = Array.isArray(region) ? region[0] : region;
      expect(first, `${name} would deploy to ${String(first)}`).toBe("europe-west2");
    }
  });

  it.runIf(packaged())("binds the relay to the OpenAI secret rather than an environment variable", async () => {
    process.env["GCLOUD_PROJECT"] ??= "myself-research";
    const module_ = (await import(bundle)) as Record<string, { __endpoint?: { secretEnvironmentVariables?: { key: string }[] } }>;
    const secrets = module_["llmRelay"]?.__endpoint?.secretEnvironmentVariables ?? [];
    expect(secrets.map((s) => s.key)).toContain("OPENAI_API_KEY");
  });
});
