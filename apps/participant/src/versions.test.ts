import { describe, expect, it } from "vitest";
import { manifestContentHash, releaseManifest, type ActiveReleaseDoc, type ReleaseManifest } from "@myself/schema";
import r8 from "../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json";
import r9 from "../../../releases/ybm_nd2026_standard_r9.0.0.manifest.json";
import {
  canResumeUnder,
  chooseForNewSittings,
  chooseRelease,
  runnable,
  type ChoiceOptions,
  type DeviceReleases,
  type PublishedSource,
} from "./lib/versions.js";

/**
 * How a device picks the version it runs (D-54), with the study's database and
 * the device's storage both faked. Each case is one of the ways a school day
 * actually goes: the study reachable or not, a new version published, one
 * that was tampered with or built for a newer engine, and a sitting being
 * picked up after a new version went live.
 */

const ENGINE = "0.3.0";
const bundled = releaseManifest.parse(r9);

/** A version as the dashboard would publish it: `base` changed, then hashed again. */
async function published(
  version: string,
  change: (m: Record<string, unknown> & { release: Record<string, unknown> }) => void = () => undefined,
): Promise<{ manifest: ReleaseManifest; json: string; doc: Record<string, unknown> }> {
  const draft = structuredClone(r9) as unknown as Record<string, unknown> & { release: Record<string, unknown> };
  delete draft["hash"];
  draft.release["version"] = version;
  draft.release["key"] = `ybm_nd2026_standard_r${version.replaceAll(".", "_")}`;
  change(draft);
  const hash = await manifestContentHash(draft);
  const json = JSON.stringify({ ...draft, hash });
  const manifest = releaseManifest.parse(JSON.parse(json));
  return {
    manifest,
    json,
    doc: {
      hash,
      version,
      key: manifest.release.key,
      study: "ybm",
      publishedAt: "2026-10-01T09:00:00.000Z",
      publishedBy: "owner@example.ac.uk",
      engineVersion: manifest.release.engineVersion,
      manifestJson: json,
      source: "editor",
    },
  };
}

const pointer = (doc: Record<string, unknown>): ActiveReleaseDoc => ({
  hash: doc["hash"] as string,
  version: doc["version"] as string,
  key: doc["key"] as string,
  activatedAt: "2026-10-01T09:00:00.000Z",
  activatedBy: "owner@example.ac.uk",
});

/** The device's own storage, in memory. */
function device(seed: { stored?: Record<string, string>; lastActive?: string; resume?: { hash: string; code: string } } = {}) {
  const stored = new Map(Object.entries(seed.stored ?? {}));
  let lastActive = seed.lastActive ?? null;
  let resume = seed.resume ?? null;
  const releases: DeviceReleases = {
    get: async (hash) => stored.get(hash) ?? null,
    put: async (manifest, json) => void stored.set(manifest.hash!, json),
    lastActive: async () => lastActive,
    setLastActive: async (hash) => void (lastActive = hash),
    takeResume: async () => {
      const taken = resume;
      resume = null;
      return taken;
    },
  };
  return { releases, stored, lastActiveNow: () => lastActive, resumePending: () => resume !== null };
}

/** The study's database: what is active, what is published, or no answer at all. */
function study(state: {
  active?: ActiveReleaseDoc | null;
  docs?: Record<string, unknown>;
  offline?: boolean;
  never?: boolean;
}) {
  const asked: string[] = [];
  const answer = async <T>(value: () => T): Promise<T> => {
    if (state.never) return new Promise<T>(() => undefined);
    if (state.offline) throw new TypeError("Failed to fetch");
    return value();
  };
  const source: PublishedSource = {
    activeRelease: () => {
      asked.push("activeRelease");
      return answer(() => state.active ?? null);
    },
    release: (hash) => {
      asked.push(hash);
      return answer(() => state.docs?.[hash] ?? null);
    },
  };
  return { source, asked };
}

const options = (over: Partial<ChoiceOptions> & Pick<ChoiceOptions, "device">): ChoiceOptions => ({
  bundled,
  source: null,
  engineVersion: ENGINE,
  activeTimeoutMs: 50,
  manifestTimeoutMs: 50,
  ...over,
});

describe("with no study configured, as on the public preview", () => {
  it("runs the bundled release and asks nobody", async () => {
    const d = device();
    const chosen = await chooseRelease(options({ device: d.releases }));
    expect(chosen.origin).toBe("bundled");
    expect(chosen.manifest.hash).toBe(bundled.hash);
    // Kept, so a sitting begun under it can be finished by a later build.
    expect(d.stored.has(bundled.hash!)).toBe(true);
  });
});

describe("the study's active version", () => {
  it("is fetched, checked, stored and run when the device has not seen it", async () => {
    const v10 = await published("10.0.0");
    const d = device();
    const s = study({ active: pointer(v10.doc), docs: { [v10.manifest.hash!]: v10.doc } });
    const chosen = await chooseRelease(options({ device: d.releases, source: s.source }));
    expect(chosen).toMatchObject({ origin: "active" });
    expect(chosen.manifest.release.version).toBe("10.0.0");
    expect(d.stored.get(v10.manifest.hash!)).toBe(v10.json);
    expect(d.lastActiveNow()).toBe(v10.manifest.hash);
  });

  it("is taken from the device, without fetching it again, once it is stored", async () => {
    const v10 = await published("10.0.0");
    const d = device({ stored: { [v10.manifest.hash!]: v10.json } });
    const s = study({ active: pointer(v10.doc), docs: {} });
    const chosen = await chooseRelease(options({ device: d.releases, source: s.source }));
    expect(chosen.origin).toBe("active");
    expect(chosen.manifest.release.version).toBe("10.0.0");
    expect(s.asked).toEqual(["activeRelease"]);
  });

  it("is the bundled release when the study has made that one active", async () => {
    const d = device();
    const s = study({ active: { hash: bundled.hash!, version: "9.0.0" } });
    const chosen = await chooseRelease(options({ device: d.releases, source: s.source }));
    expect(chosen).toMatchObject({ origin: "active", manifest: { hash: bundled.hash } });
    expect(s.asked).toEqual(["activeRelease"]);
  });

  it("is the bundled release when the study has published nothing from the dashboard", async () => {
    const chosen = await chooseRelease(options({ device: device().releases, source: study({ active: null }).source }));
    expect(chosen.origin).toBe("bundled");
    expect(chosen.note).toBeUndefined();
  });

  it("can be an earlier fielded release made active again, which is the rollback", async () => {
    const r8doc = { hash: r8.hash, version: "8.0.0", key: r8.release.key, manifestJson: JSON.stringify(r8) };
    const s = study({ active: pointer(r8doc), docs: { [r8.hash]: r8doc } });
    const chosen = await chooseRelease(options({ device: device().releases, source: s.source }));
    expect(chosen.origin).toBe("active");
    expect(chosen.manifest.release.version).toBe("8.0.0");
  });
});

describe("a version that does not check out is never run", () => {
  it("refuses a manifest whose content does not match its hash, and falls back", async () => {
    const v10 = await published("10.0.0");
    const tampered = { ...v10.doc, manifestJson: v10.json.replace("brainpop@leeds.ac.uk", "someone@example.com") };
    const d = device();
    const s = study({ active: pointer(v10.doc), docs: { [v10.manifest.hash!]: tampered } });
    const chosen = await chooseRelease(options({ device: d.releases, source: s.source }));
    expect(chosen.origin).toBe("bundled");
    expect(chosen.note).toMatch(/refused: its content hashes to/);
    expect(d.stored.has(v10.manifest.hash!)).toBe(false);
    expect(d.lastActiveNow()).toBeNull();
  });

  it("refuses one built for an engine this app does not have, and keeps the last good one", async () => {
    const v10 = await published("10.0.0");
    const v11 = await published("11.0.0", (m) => {
      m.release["engineVersion"] = "0.4.0";
    });
    const d = device({ stored: { [v10.manifest.hash!]: v10.json }, lastActive: v10.manifest.hash! });
    const s = study({ active: pointer(v11.doc), docs: { [v11.manifest.hash!]: v11.doc } });
    const chosen = await chooseRelease(options({ device: d.releases, source: s.source }));
    expect(chosen.origin).toBe("stored");
    expect(chosen.manifest.release.version).toBe("10.0.0");
    expect(chosen.note).toMatch(/needs engine 0\.4\.0/);
    expect(d.stored.has(v11.manifest.hash!)).toBe(false);
  });

  it("refuses one the schema accepts but the app could not draw", async () => {
    // A narrative placed in a section with no protocol frozen for it: the
    // outline is valid, and flattening it would fail as the app loads.
    const broken = await published("10.0.0", (m) => {
      const composition = m["composition"] as { sections: { components: unknown[] }[] };
      composition.sections[0]!.components.push({ kind: "narrative", protocol: "np.nothing_frozen", protocolVersion: "1.0.0" });
    });
    expect(runnable(broken.manifest)).toMatch(/not frozen/);
    const s = study({ active: pointer(broken.doc), docs: { [broken.manifest.hash!]: broken.doc } });
    const chosen = await chooseRelease(options({ device: device().releases, source: s.source }));
    expect(chosen.origin).toBe("bundled");
    expect(chosen.note).toMatch(/cannot draw it/);
  });

  it("refuses one the study has no copy of", async () => {
    const v10 = await published("10.0.0");
    const s = study({ active: pointer(v10.doc), docs: {} });
    const chosen = await chooseRelease(options({ device: device().releases, source: s.source }));
    expect(chosen).toMatchObject({ origin: "bundled", note: expect.stringMatching(/no copy/) });
  });

  it("does not run a stored copy that has since been damaged", async () => {
    const v10 = await published("10.0.0");
    const damaged = v10.json.replace("brainpop@leeds.ac.uk", "x@example.com");
    const d = device({ stored: { [v10.manifest.hash!]: damaged }, lastActive: v10.manifest.hash! });
    const chosen = await chooseRelease(options({ device: d.releases, source: study({ offline: true }).source }));
    expect(chosen.origin).toBe("bundled");
  });
});

describe("with no network, or a study that does not answer", () => {
  it("runs the last active version this device stored", async () => {
    const v10 = await published("10.0.0");
    const d = device({ stored: { [v10.manifest.hash!]: v10.json }, lastActive: v10.manifest.hash! });
    const chosen = await chooseRelease(options({ device: d.releases, source: study({ offline: true }).source }));
    expect(chosen.origin).toBe("stored");
    expect(chosen.manifest.release.version).toBe("10.0.0");
    expect(chosen.note).toMatch(/could not be asked.*Failed to fetch/);
  });

  it("runs the bundled release when nothing is stored", async () => {
    const chosen = await chooseRelease(options({ device: device().releases, source: study({ offline: true }).source }));
    expect(chosen.origin).toBe("bundled");
  });

  it("does not wait for a study that never answers", async () => {
    const started = Date.now();
    const chosen = await chooseRelease(options({ device: device().releases, source: study({ never: true }).source }));
    expect(chosen.origin).toBe("bundled");
    expect(chosen.note).toMatch(/no answer within/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not wait for a manifest that never arrives either", async () => {
    const v10 = await published("10.0.0");
    const slow: PublishedSource = {
      activeRelease: async () => pointer(v10.doc),
      release: () => new Promise(() => undefined),
    };
    const chosen = await chooseRelease(options({ device: device().releases, source: slow }));
    expect(chosen.origin).toBe("bundled");
  });

  it("still starts when the device's storage fails", async () => {
    const failing: DeviceReleases = {
      get: () => Promise.reject(new Error("QuotaExceededError")),
      put: () => Promise.reject(new Error("QuotaExceededError")),
      lastActive: () => Promise.reject(new Error("QuotaExceededError")),
      setLastActive: () => Promise.reject(new Error("QuotaExceededError")),
      takeResume: () => Promise.reject(new Error("QuotaExceededError")),
    };
    const v10 = await published("10.0.0");
    const s = study({ active: pointer(v10.doc), docs: { [v10.manifest.hash!]: v10.doc } });
    const chosen = await chooseRelease(options({ device: failing, source: s.source }));
    // Checked and used this time; just not kept for next time.
    expect(chosen).toMatchObject({ origin: "active", manifest: { release: { version: "10.0.0" } } });
  });
});

describe("finishing a sitting under the version it started with", () => {
  it("opens that version, with the code, whatever the study has made active since", async () => {
    const v10 = await published("10.0.0");
    const v11 = await published("11.0.0");
    const d = device({
      stored: { [v10.manifest.hash!]: v10.json, [v11.manifest.hash!]: v11.json },
      lastActive: v11.manifest.hash!,
      resume: { hash: v10.manifest.hash!, code: "NDC0042" },
    });
    const s = study({ active: pointer(v11.doc) });
    const chosen = await chooseRelease(options({ device: d.releases, source: s.source }));
    expect(chosen).toMatchObject({ origin: "resumed", resumeCode: "NDC0042" });
    expect(chosen.manifest.release.version).toBe("10.0.0");
    // Asked once: the next start is an ordinary one.
    expect(d.resumePending()).toBe(false);
    expect(s.asked).toEqual([]);
  });

  it("can resume under the bundled release, even when it is no longer active", async () => {
    const d = device({ resume: { hash: bundled.hash!, code: "NDC0042" } });
    const chosen = await chooseRelease(options({ device: d.releases }));
    expect(chosen).toMatchObject({ origin: "resumed", manifest: { hash: bundled.hash } });
  });

  it("carries on normally when that version is not on the device", async () => {
    const d = device({ resume: { hash: `sha256:${"0".repeat(64)}`, code: "NDC0042" } });
    const chosen = await chooseRelease(options({ device: d.releases }));
    expect(chosen.origin).toBe("bundled");
    expect(chosen.resumeCode).toBeUndefined();
  });

  it("is offered only for a version the device holds and can still run", async () => {
    const v10 = await published("10.0.0");
    const v11 = await published("11.0.0", (m) => {
      m.release["engineVersion"] = "0.4.0";
    });
    const d = device({ stored: { [v10.manifest.hash!]: v10.json, [v11.manifest.hash!]: v11.json } });
    const o = options({ device: d.releases });
    expect(await canResumeUnder(o, v10.manifest.hash!)).toBe(true);
    expect(await canResumeUnder(o, bundled.hash!)).toBe(true);
    expect(await canResumeUnder(o, v11.manifest.hash!)).toBe(false);
    expect(await canResumeUnder(o, `sha256:${"0".repeat(64)}`)).toBe(false);
  });
});

describe("after a handover", () => {
  it("learns that a different version is now active, and has it stored before any reload", async () => {
    const v10 = await published("10.0.0");
    const d = device();
    const s = study({ active: pointer(v10.doc), docs: { [v10.manifest.hash!]: v10.doc } });
    const next = await chooseForNewSittings(options({ device: d.releases, source: s.source }));
    expect(next.manifest.hash).not.toBe(bundled.hash);
    expect(d.stored.has(v10.manifest.hash!)).toBe(true);
    // Then the reload, offline: the stored copy is what it opens.
    const reloaded = await chooseRelease(options({ device: d.releases, source: study({ offline: true }).source }));
    expect(reloaded.manifest.hash).toBe(v10.manifest.hash);
  });

  it("sees no change when the study cannot be asked, so nothing reloads", async () => {
    const next = await chooseForNewSittings(options({ device: device().releases, source: study({ offline: true }).source }));
    expect(next.manifest.hash).toBe(bundled.hash);
  });
});
