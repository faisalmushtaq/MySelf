import type { ReleaseManifest, ResponseScale } from "@myself/schema";
import type { DeviceSession, DeviceEvent } from "./ingest.js";

/**
 * Synthetic sessions, for the researcher view to have something to show before
 * the first school visit.
 *
 * Generated data is generated data, and it must never be mistaken for the real
 * thing. Two guards: every synthetic session's study code starts with `DEMO`,
 * and the participant codes it produces are drawn from a fixed made-up pool.
 * A dataset containing them is obvious at a glance in the site column.
 *
 * It is deterministic — same seed, same dataset — so a screenshot in a paper
 * or a bug report can be reproduced exactly.
 */

/** mulberry32: small, fast, and reproducible across engines. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoOptions {
  manifest: ReleaseManifest;
  /** How many made-up people. */
  participants?: number;
  seed?: number;
  /** Sites the sittings are spread across; each becomes a study code prefix. */
  sites?: string[];
  /** Date of the first wave; later waves fall a few months after. */
  firstWave?: Date;
}

interface FrozenItem {
  key: string;
  responseType: string;
  scale?: string;
  rungs?: number;
  min?: number;
  max?: number;
  fields?: { key: string }[];
  statements?: { key: string }[];
}

const FIRST_NAMES = ["Amara", "Ben", "Chloe", "Dev", "Esme", "Finlay", "Gracie", "Hamza", "Isla", "Jonah", "Kaya", "Louis"];
const LAST_NAMES = ["Ahmed", "Brook", "Clarke", "Dhillon", "Evans", "Fisher", "Grant", "Hussain", "Ijaz", "Jones"];
const GAMES = ["Minecraft", "Roblox", "FIFA", "Fortnite", "Among Us", "Stardew Valley"];

export function buildDemoSessions(options: DemoOptions): DeviceSession[] {
  const { manifest } = options;
  const count = options.participants ?? 24;
  const random = rng(options.seed ?? 20260101);
  const sites = options.sites ?? ["DEMOA", "DEMOB"];
  const firstWave = options.firstWave ?? new Date("2026-03-02T09:30:00.000Z");

  const scales = new Map<string, ResponseScale>(
    Object.entries(manifest.scales).map(([k, v]) => [k, v as ResponseScale]),
  );
  const instruments: { instrument: string; items: FrozenItem[] }[] = Object.values(manifest.instruments).map((raw) => {
    const inst = raw as { instrument: string; forms: { items: FrozenItem[] }[] };
    return { instrument: inst.instrument, items: inst.forms.flatMap((f) => f.items) };
  });

  const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)]!;
  const letters = () =>
    String.fromCharCode(65 + Math.floor(random() * 26)) + String.fromCharCode(65 + Math.floor(random() * 26));

  const sessions: DeviceSession[] = [];

  for (let p = 0; p < count; p += 1) {
    // Each person's code parts are fixed once, so their waves link — that is
    // the whole point of the exercise, and a generator that re-rolled them
    // would quietly produce a dataset with no longitudinal signal at all.
    const parts = {
      motherInitials: letters(),
      houseDigit: String(Math.floor(random() * 10)),
      birthMonthCode: 1 + Math.floor(random() * 12),
      postcodeLetters: letters(),
    };
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const birthYear = 2008 + Math.floor(random() * 6);
    const dob = `${birthYear}-${String(parts.birthMonthCode).padStart(2, "0")}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`;
    const site = sites[p % sites.length]!;
    // A right-handed majority, as any unselected sample has.
    const handednessLean = random() < 0.86 ? 1 : -1;

    // Roughly three in five come back for a second wave, one in five for a third.
    const waves = random() < 0.6 ? (random() < 0.33 ? 3 : 2) : 1;

    for (let w = 0; w < waves; w += 1) {
      const started = new Date(firstWave.getTime() + w * 120 * 86_400_000 + p * 900_000 + random() * 3_600_000);
      const complete = !(w === waves - 1 && random() < 0.12);
      const events: DeviceEvent[] = [];
      let seq = 0;
      let elapsed = 0;
      const at = () => new Date(started.getTime() + elapsed).toISOString();

      events.push({
        seq: seq++,
        type: "session.started",
        payload: { releaseHash: manifest.hash, val_id: `${site}${String(w + 1).padStart(2, "0")}` },
        tWall: at(),
        tMono: elapsed,
      });

      let answeredAny = 0;
      for (const inst of instruments) {
        for (const item of inst.items) {
          if (item.responseType === "info") continue;
          const key = `${inst.instrument}.${item.key}`;
          // A late abandonment stops the log where the participant stopped.
          if (!complete && answeredAny > 45) break;

          const dwell = 900 + Math.floor(random() * 5200);
          elapsed += dwell;
          const skip = random() < 0.03 && !key.startsWith("ybm_identity");
          if (skip) {
            events.push({ seq: seq++, type: "item.skipped", itemKey: key, tWall: at(), tMono: elapsed });
          } else {
            const value = answerFor(item, {
              random,
              scales,
              firstName,
              lastName,
              dob,
              parts,
              handednessLean,
            });
            if (value === null) continue;
            const tooFast = random() < 0.02;
            events.push({
              seq: seq++,
              type: "response.recorded",
              itemKey: key,
              payload: { value, timing: { dwellMs: dwell, tooFast } },
              tWall: at(),
              tMono: elapsed,
            });
            if (tooFast) {
              events.push({ seq: seq++, type: "response.too_fast", itemKey: key, tWall: at(), tMono: elapsed });
            }
            answeredAny += 1;
          }
          const visits = random() < 0.08 ? 2 : 1;
          events.push({
            seq: seq++,
            type: "item.left",
            itemKey: key,
            payload: { totalDwellMs: dwell * visits, visit: visits },
            tWall: at(),
            tMono: elapsed,
          });
        }
      }

      if (complete) {
        const edits = random() < 0.25 ? 1 + Math.floor(random() * 2) : 0;
        for (let e = 0; e < edits; e += 1) {
          events.push({ seq: seq++, type: "review.edited", tWall: at(), tMono: elapsed });
        }
        events.push({
          seq: seq++,
          type: "session.completed",
          payload: { totalMs: elapsed, foregroundMs: Math.round(elapsed * (0.9 + random() * 0.1)) },
          tWall: at(),
          tMono: elapsed,
        });
      }

      sessions.push({
        sessionId: `ses_demo_${String(p).padStart(3, "0")}_${w + 1}`,
        studyCode: `${site}${String(w + 1).padStart(2, "0")}`,
        releaseKey: manifest.release.key,
        releaseHash: manifest.hash ?? "",
        startedAt: started.toISOString(),
        ...(complete ? { completedAt: new Date(started.getTime() + elapsed).toISOString() } : {}),
        complete,
        events,
      });
    }
  }

  return sessions;
}

interface AnswerContext {
  random: () => number;
  scales: Map<string, ResponseScale>;
  firstName: string;
  lastName: string;
  dob: string;
  parts: { motherInitials: string; houseDigit: string; birthMonthCode: number; postcodeLetters: string };
  handednessLean: number;
}

function answerFor(item: FrozenItem, ctx: AnswerContext): unknown {
  const { random } = ctx;
  switch (item.key) {
    case "first_name":
      return { kind: "text", value: ctx.firstName };
    case "last_name":
      return { kind: "text", value: ctx.lastName };
    case "dob":
      return { kind: "date", iso: ctx.dob };
    case "ps_mother_initials":
      return { kind: "text", value: ctx.parts.motherInitials };
    case "ps_house_digit":
      return { kind: "text", value: ctx.parts.houseDigit };
    case "ps_postcode_letters":
      return { kind: "text", value: ctx.parts.postcodeLetters };
    case "ps_birth_month":
      return { kind: "choice", code: ctx.parts.birthMonthCode };
  }

  switch (item.responseType) {
    case "single_choice": {
      const scale = item.scale ? ctx.scales.get(item.scale) : undefined;
      const options = scale?.options ?? [];
      if (options.length === 0) return null;
      if (item.scale === "scale.ehi_sf_5pt") {
        // Handedness is bimodal, not uniform: pull towards the person's side.
        // Which end that is comes from the labels, not from the code order —
        // this scale is anchored right-first, and a generator that assumed
        // otherwise would produce a left-handed cohort by accident.
        const want = ctx.handednessLean > 0 ? /right/i : /left/i;
        const side = options.filter((o) => want.test(o.label));
        if (side.length === 0) return { kind: "choice", code: options[0]!.code };
        const strongest = side.find((o) => /always/i.test(o.label)) ?? side[0]!;
        const softer = side.find((o) => o !== strongest) ?? strongest;
        return { kind: "choice", code: random() < 0.75 ? strongest.code : softer.code };
      }
      const option = options[Math.floor(random() * options.length)]!;
      return { kind: "choice", code: option.code };
    }
    case "multi_choice": {
      const scale = item.scale ? ctx.scales.get(item.scale) : undefined;
      const options = scale?.options ?? [];
      const codes = options.filter(() => random() < 0.35).map((o) => o.code);
      return { kind: "multi", codes: codes.length ? codes : [options[0]?.code ?? 1] };
    }
    case "ladder": {
      const rungs = item.rungs ?? 10;
      return { kind: "choice", code: 1 + Math.floor(random() * rungs) };
    }
    case "slider": {
      const min = item.min ?? 0;
      const max = item.max ?? 100;
      return { kind: "number", value: Math.round(min + random() * (max - min)) };
    }
    case "numeric": {
      const min = item.min ?? 0;
      const max = item.max ?? 30;
      return { kind: "number", value: Math.round(min + random() * (max - min)) };
    }
    case "text_short":
      return { kind: "text", value: "" };
    case "text_long":
      return {
        kind: "text",
        value: "In five years I hope I am still playing football and doing something I enjoy.",
      };
    case "form_fields": {
      const values: Record<string, string> = {};
      const fields = item.fields ?? [];
      const howMany = 1 + Math.floor(random() * Math.min(3, fields.length));
      fields.slice(0, howMany).forEach((f) => {
        values[f.key] = GAMES[Math.floor(random() * GAMES.length)]!;
      });
      return { kind: "fields", values };
    }
    case "checkbox_set":
      return { kind: "checkboxes", checked: (item.statements ?? []).map((s) => s.key) };
    case "rank_group": {
      const scale = item.scale ? ctx.scales.get(item.scale) : undefined;
      const assignments: Record<number, { group: string; rank?: number }> = {};
      let rank = 1;
      for (const option of scale?.options ?? []) {
        if (random() < 0.5) assignments[option.code] = { group: "owned", rank: rank++ };
      }
      return { kind: "group_rank", assignments };
    }
    default:
      return null;
  }
}
