import { describe, expect, it } from "vitest";
import { CALLABLES } from "@myself/studio";

/**
 * The Studio's functions as the deploy tooling will see them.
 *
 * deployment.test.ts checks the packaged bundle puts every export in
 * europe-west2; this checks the Studio's own contract with the browser: every
 * name in `CALLABLES` is exported from index.ts as a callable, in London, and
 * the draft trigger listens where drafts are written.
 */

type Endpoint = {
  region?: string[];
  callableTrigger?: unknown;
  eventTrigger?: { eventType?: string; eventFilterPathPatterns?: Record<string, string>; retry?: boolean };
};

const load = async () => {
  process.env["GCLOUD_PROJECT"] ??= "demo-myself";
  return (await import("../index.js")) as unknown as Record<string, { __endpoint?: Endpoint }>;
};

describe("the Studio's functions", () => {
  it("export every callable the contract names, each in europe-west2", async () => {
    const index = await load();
    for (const name of Object.values(CALLABLES)) {
      const endpoint = index[name]?.__endpoint;
      expect(endpoint, `${name} is not exported from index.ts`).toBeDefined();
      expect(endpoint!.callableTrigger, `${name} is not a callable`).toBeDefined();
      expect(endpoint!.region, name).toEqual(["europe-west2"]);
    }
  });

  it("listen to every survey's draft, in europe-west2, without retrying a failure forever", async () => {
    const endpoint = (await load())["onStudioDraftWritten"]?.__endpoint;
    expect(endpoint?.region).toEqual(["europe-west2"]);
    expect(endpoint?.eventTrigger?.eventType).toBe("google.cloud.firestore.document.v1.written");
    expect(endpoint?.eventTrigger?.eventFilterPathPatterns).toEqual({ document: "studies/{study}/surveys/{surveyId}/draft/{doc}" });
    expect(endpoint?.eventTrigger?.retry).toBe(false);
  });
});
