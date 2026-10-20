import { timeGridCandidates, timeGridMax, timeGridVariable } from "@myself/engine";
import type { ReleaseManifest, ResponseScale, TimeGridSource } from "@myself/schema";
import type { Dataset } from "./dataset.js";
import { exportableNarratives, summariseNarrative, type StoredNarrativeRun } from "./narratives.js";

/**
 * BIDS-style export.
 *
 * BIDS has a home for questionnaire data — `phenotype/`, one TSV per measure,
 * keyed on `participant_id` and (for longitudinal studies) `session_id`, each
 * with a sidecar JSON data dictionary. That is what this writes, alongside the
 * `participants.tsv` and `dataset_description.json` a BIDS dataset must have,
 * and a `sessions.tsv` per subject.
 *
 * This is BIDS-style, deliberately: BIDS proper is specified around imaging,
 * and a survey-only dataset is not a valid BIDS dataset on its own. What it
 * gains by following the layout is that when the EEG arrives it drops into the
 * per-subject, per-session eeg directories beside this, without anything here
 * having to move.
 *
 * Two things are non-negotiable in what comes out:
 *   - `n/a` for missing, never an empty cell, and never a zero
 *   - a sidecar for every data file, because a TSV of codes with no dictionary
 *     is not data anybody can use in three years' time
 */

export interface BidsFile {
  path: string;
  content: string;
}

export interface BidsOptions {
  manifest: ReleaseManifest;
  datasetName: string;
  authors?: string[];
  /** Ethics reference, licence and anything else for the description. */
  description?: Record<string, unknown>;
  /**
   * Narrative runs, if the study ran the micro-narrative module.
   *
   * Passed in rather than carried on the Dataset because they are stored
   * apart and arrive apart — a study with no narratives should not pay to
   * read them, and an ingest of questionnaire data should not have to know
   * they exist.
   */
  narratives?: StoredNarrativeRun[];
}

/** BIDS labels are alphanumeric only — no underscores, dashes or spaces. */
const label = (raw: string): string => raw.replace(/[^A-Za-z0-9]/g, "");

const NA = "n/a";

/**
 * The narrative files: the raw log, and a table beside it.
 *
 * The log first, because the conversation IS the data — a young person's own
 * words in their own order, with what the model said back and what they did
 * about it. The table is derived from the log on every export and is never a
 * substitute for it; anything it gets wrong can be recomputed, and anything
 * it leaves out is still there.
 */
function narrativeFiles(runs: StoredNarrativeRun[], data: Dataset): BidsFile[] {
  const joined = exportableNarratives(runs, data);
  if (joined.length === 0) return [];

  const files: BidsFile[] = [];
  const rows: Record<string, unknown>[] = [];

  for (const { run, participantId, wave } of joined) {
    const subject = `sub-${label(participantId)}`;
    const session = `ses-${String(wave).padStart(2, "0")}`;
    const summary = summariseNarrative(run);

    rows.push({
      participant_id: subject,
      session_id: session,
      wave,
      protocol: summary.protocolKey,
      protocol_version: summary.protocolVersion,
      finished: summary.finished ? 1 : 0,
      elapsed_s: summary.elapsedSeconds,
      turns: summary.turns,
      words: summary.words,
      chosen_persona: summary.chosenPersona,
      offered: summary.offered,
      rating: summary.rating,
      rating_max: summary.ratingMax,
      adapted: summary.adapted ? 1 : 0,
      accepted_unchanged: summary.acceptedUnchanged ? 1 : 0,
      fallbacks: summary.fallbacks,
      final_scenario: summary.finalScenario,
    });

    files.push({
      path: `phenotype/narratives/${subject}_${session}_narrative.json`,
      content: json({
        participant_id: subject,
        session_id: session,
        protocol: run.protocolKey,
        protocol_version: run.protocolVersion,
        ...(run.releaseHash ? { release_hash: run.releaseHash } : {}),
        finished: run.finished === true,
        ...(run.elapsedSeconds === undefined ? {} : { elapsed_seconds: run.elapsedSeconds }),
        records: [...run.records].sort((a, b) => a.seq - b.seq),
      }),
    });
  }

  const columns = [
    "participant_id",
    "session_id",
    "wave",
    "protocol",
    "protocol_version",
    "finished",
    "elapsed_s",
    "turns",
    "words",
    "chosen_persona",
    "offered",
    "rating",
    "rating_max",
    "adapted",
    "accepted_unchanged",
    "fallbacks",
    "final_scenario",
  ];
  files.push({ path: "phenotype/narratives.tsv", content: tsv(columns, rows) });
  files.push({
    path: "phenotype/narratives.json",
    content: json({
      Description:
        "One row per micro-narrative run. Derived on every export from the record logs in phenotype/narratives/, which are the data; nothing here is entered by hand and nothing here replaces the log.",
      participant_id: { Description: "Participant's derived study code, stable across waves." },
      session_id: { Description: "The sitting this run belonged to." },
      protocol: { Description: "Which narrative protocol was administered." },
      protocol_version: { Description: "Its version, so the questions and personas are recoverable." },
      finished: { Description: "1 if the participant reached the end of the module.", Levels: { "0": "no", "1": "yes" } },
      elapsed_s: { Description: "Seconds from the first screen of the module to the last." },
      turns: { Description: "Messages the participant wrote, including corrections and their own edits." },
      words: { Description: "Total words the participant wrote across those messages." },
      chosen_persona: {
        Description:
          "Which retelling they said fitted best. The persona label is never shown to the participant, so this is their judgement of the writing rather than of the label.",
      },
      offered: { Description: "How many retellings they were shown to choose between." },
      rating: { Description: "How well the chosen retelling described what they had said." },
      rating_max: { Description: "Top of the rating scale this protocol used." },
      adapted: {
        Description: "1 if they changed the retelling, either by rewriting it themselves or by asking for a rewrite.",
        Levels: { "0": "no", "1": "yes" },
      },
      accepted_unchanged: {
        Description:
          "1 if they were offered a rewrite and said it was already right. An answer, not an absence: distinguishing it from a run that never reached the question is the point of recording it.",
        Levels: { "0": "no", "1": "yes" },
      },
      fallbacks: {
        Description:
          "How many model stages could not be reached and fell back. A run with fallbacks is complete with a documented gap, not corrupt.",
      },
      final_scenario: { Description: "The retelling the participant left with, after any changes they made." },
    }),
  });

  return files;
}

/**
 * Text as a spreadsheet will show it rather than run it.
 *
 * Exports are opened in Excel, and a cell beginning with =, +, - or @ (or their
 * full-width forms, or any of them after leading spaces) is evaluated as a
 * formula — so a participant who types "=HYPERLINK(…)" into a free-text box
 * could put a live link or worse in front of the researcher. A leading
 * apostrophe makes it plain text; the words are otherwise untouched. Numbers
 * never pass through here, so a negative number stays a number.
 */
export function defuseFormula(text: string): string {
  return /^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(text) ? `'${text}` : text;
}

/** A TSV cell: `n/a` for missing, tabs and newlines stripped from text, formulas defused. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return NA;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return defuseFormula(String(value).replace(/[\t\r\n]+/g, " ").trim()) || NA;
}

function tsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.join("\t")];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join("\t"));
  return `${lines.join("\n")}\n`;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The data dictionary for one instrument's columns: the question as the
 * participant read it, and every code with the label it stood for.
 */
function instrumentSidecar(
  instrument: string,
  manifest: ReleaseManifest,
): Record<string, unknown> {
  const scales = new Map<string, ResponseScale>(
    Object.entries(manifest.scales).map(([k, v]) => [k, v as ResponseScale]),
  );
  const out: Record<string, unknown> = {
    participant_id: { Description: "Participant's derived study code, stable across waves." },
    session_id: { Description: "Session label for this wave (ses-01, ses-02, …)." },
    wave: { Description: "Ordinal wave for this participant; 1 is their first session." },
  };
  for (const def of Object.values(manifest.instruments)) {
    const inst = def as {
      instrument: string;
      name?: string;
      citation?: string;
      forms: { items: Record<string, unknown>[] }[];
    };
    if (inst.instrument !== instrument) continue;
    for (const form of inst.forms) {
      for (const raw of form.items) {
        const item = raw as {
          key: string;
          variable: string;
          responseType: string;
          stem: { text: string };
          scale?: string;
        };
        if (item.responseType === "info") continue;
        if (item.responseType === "time_grid") {
          Object.assign(out, gridSidecar(raw, manifest, scales));
          continue;
        }
        const scale = item.scale ? scales.get(item.scale) : undefined;
        const levels: Record<string, string> = {};
        for (const o of scale?.options ?? []) {
          levels[String(o.code)] = o.codeLabel ? `${o.label} (${o.codeLabel})` : o.label;
        }
        out[item.variable] = {
          Description: item.stem.text,
          ...(scale ? { Levels: levels } : {}),
          ...(scale?.scoringNote ? { Notes: scale.scoringNote } : {}),
          ...(inst.citation ? { TermURL: undefined, Source: inst.citation } : {}),
        };
      }
    }
  }
  return out;
}

/**
 * A time grid's dictionary entries: one per row it could have, named for the
 * option it times. The grid's own variable is never a column.
 */
function gridSidecar(
  raw: Record<string, unknown>,
  manifest: ReleaseManifest,
  scales: Map<string, ResponseScale>,
): Record<string, unknown> {
  const variable = raw["variable"] as string;
  const stem = (raw["stem"] as { text: string }).text;
  const from = raw["rowsFrom"] as TimeGridSource;
  let sourceScale: string | undefined;
  for (const def of Object.values(manifest.instruments)) {
    const inst = def as { instrument: string; forms: { items: { key: string; scale?: string }[] }[] };
    if (inst.instrument !== from.instrument) continue;
    sourceScale ??= inst.forms.flatMap((f) => f.items).find((i) => i.key === from.item)?.scale;
  }
  const scale = sourceScale ? scales.get(sourceScale) : undefined;
  const max = timeGridMax(raw as { maxMinutesPerRow?: number });
  const out: Record<string, unknown> = {};
  for (const o of timeGridCandidates(scale?.options ?? [])) {
    out[timeGridVariable(variable, o.code)] = {
      Description: `${stem} — ${o.label}`,
      Units: "minutes",
      Notes: `Total minutes (hours × 60 + minutes), 0 to ${max}. Asked only if ${from.instrument}.${from.item} put ${o.label} ${from.group ? `in '${from.group}'` : "among its choices"}; otherwise not_presented_branching.`,
    };
  }
  return out;
}

export function buildBidsExport(data: Dataset, options: BidsOptions): BidsFile[] {
  const { manifest } = options;
  const files: BidsFile[] = [];

  // ── dataset_description.json ────────────────────────────────────────────
  files.push({
    path: "dataset_description.json",
    content: json({
      Name: options.datasetName,
      BIDSVersion: "1.9.0",
      DatasetType: "raw",
      ...(options.authors ? { Authors: options.authors } : {}),
      GeneratedBy: [
        {
          Name: "MySelf",
          Description:
            "Exported from the MySelf research platform. Questionnaire data follows the BIDS phenotype convention; this dataset is BIDS-style rather than a validated BIDS dataset, since it carries no imaging.",
          CodeURL: "https://github.com/faisalmushtaq/MySelf",
        },
      ],
      SourceDatasets: [
        {
          ReleaseKey: manifest.release.key,
          ReleaseVersion: manifest.release.version,
          // The content hash is what makes an answer interpretable years
          // later: it names the exact instrument wording and codes used.
          ReleaseHash: manifest.hash,
          PublishedAt: manifest.release.publishedAt,
        },
      ],
      ...(options.description ?? {}),
    }),
  });

  // ── participants.tsv + sidecar ──────────────────────────────────────────
  const participantColumns = ["participant_id", "study", "n_sessions", "first_seen", "last_seen", "sites"];
  files.push({
    path: "participants.tsv",
    content: tsv(
      participantColumns,
      data.participants.map((p) => ({
        participant_id: `sub-${label(p.participantId)}`,
        study: p.study,
        n_sessions: p.sessionCount,
        first_seen: p.firstSeen.slice(0, 10),
        last_seen: p.lastSeen.slice(0, 10),
        sites: p.sites.join(","),
      })),
    ),
  });
  files.push({
    path: "participants.json",
    content: json({
      participant_id: {
        Description:
          "The participant's pseudonymous ID: their own secret code up to survey version 7.3.0, and from 8.0.0 derived from name and date of birth (D-52). Stable across waves and not reversible to a name — the identifiers themselves are held in a separate, access-controlled schema and are not in this dataset.",
      },
      study: { Description: "Study the participant belongs to." },
      n_sessions: { Description: "Number of completed sittings for this participant." },
      first_seen: { Description: "Date of their first session (YYYY-MM-DD)." },
      last_seen: { Description: "Date of their most recent session (YYYY-MM-DD)." },
      sites: { Description: "Comma-separated site codes, from the researcher-issued study code." },
    }),
  });

  // ── phenotype/<instrument>.tsv, one row per participant per wave ────────
  const sessionById = new Map(data.sessions.map((s) => [s.sessionId, s]));
  const instruments = [...new Set(data.responses.map((r) => r.instrument))].sort();

  for (const instrument of instruments) {
    const rows = data.responses.filter((r) => r.instrument === instrument);
    const variables = [...new Set(rows.map((r) => r.variable))].sort();
    const bySession = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const session = sessionById.get(r.sessionId);
      if (!session) continue;
      let row = bySession.get(r.sessionId);
      if (!row) {
        row = {
          participant_id: `sub-${label(r.participantId)}`,
          session_id: `ses-${String(session.wave).padStart(2, "0")}`,
          wave: session.wave,
        };
        bySession.set(r.sessionId, row);
      }
      // An unanswered item is `n/a`, and *why* it is missing is kept in the
      // status column beside it — a skip and a branch that never ran are not
      // the same absence, and collapsing them loses that.
      row[r.variable] = r.status === "answered" ? (r.value ?? r.text) : null;
      row[`${r.variable}_status`] = r.status;
    }
    const columns = [
      "participant_id",
      "session_id",
      "wave",
      ...variables.flatMap((v) => [v, `${v}_status`]),
    ];
    const ordered = [...bySession.values()].sort((a, b) =>
      `${a["participant_id"]}${a["session_id"]}`.localeCompare(`${b["participant_id"]}${b["session_id"]}`),
    );
    files.push({ path: `phenotype/${instrument}.tsv`, content: tsv(columns, ordered) });

    const sidecar = instrumentSidecar(instrument, manifest);
    for (const v of variables) {
      sidecar[`${v}_status`] = {
        Description: `Why ${v} is missing, where it is: answered, skipped, declined, not_presented_branching, not_reached_ended, invalid or lost_technical.`,
      };
    }
    files.push({ path: `phenotype/${instrument}.json`, content: json(sidecar) });
  }

  // ── phenotype/scores.tsv — derived, separate, regenerable ───────────────
  if (data.scores.length > 0) {
    const byScoreSession = new Map<string, Record<string, unknown>>();
    for (const s of data.scores) {
      const session = sessionById.get(s.sessionId);
      if (!session) continue;
      let row = byScoreSession.get(s.sessionId);
      if (!row) {
        row = {
          participant_id: `sub-${label(s.participantId)}`,
          session_id: `ses-${String(session.wave).padStart(2, "0")}`,
          wave: session.wave,
        };
        byScoreSession.set(s.sessionId, row);
      }
      row[`${s.instrument}_${s.output}`] = s.value;
    }
    const scoreColumns = [
      "participant_id",
      "session_id",
      "wave",
      ...[...new Set(data.scores.map((s) => `${s.instrument}_${s.output}`))].sort(),
    ];
    files.push({
      path: "phenotype/scores.tsv",
      content: tsv(scoreColumns, [...byScoreSession.values()]),
    });
    files.push({
      path: "phenotype/scores.json",
      content: json({
        Description:
          "Derived scores. Regenerable from the raw responses and the scoring definitions frozen in the release — never edited by hand, and never a substitute for the raw data.",
        GeneratedFrom: data.releaseHashes,
        ...Object.fromEntries(
          [...new Set(data.scores.map((s) => `${s.instrument}_${s.output}`))].sort().map((k) => {
            const example = data.scores.find((s) => `${s.instrument}_${s.output}` === k)!;
            return [
              k,
              {
                Description: `${example.output} from ${example.scoringKey} v${example.scoringVersion}`,
                Instrument: example.instrument,
              },
            ];
          }),
        ),
      }),
    });
  }

  // ── sub-*/sessions.tsv — the longitudinal index BIDS asks for ───────────
  const bySubject = new Map<string, typeof data.sessions>();
  for (const s of data.sessions) {
    const key = label(s.participantId);
    const list = bySubject.get(key);
    if (list) list.push(s);
    else bySubject.set(key, [s]);
  }
  const sessionColumns = [
    "session_id",
    "wave",
    "acq_time",
    "site",
    "duration_ms",
    "foreground_ms",
    "n_answered",
    "n_skipped",
    "n_too_fast",
    "n_revisited",
    "review_edits",
    "complete",
    "release_hash",
  ];
  for (const [subject, rows] of bySubject) {
    const ordered = [...rows].sort((a, b) => a.wave - b.wave);
    files.push({
      path: `sub-${subject}/sessions.tsv`,
      content: tsv(
        sessionColumns,
        ordered.map((s) => ({
          session_id: `ses-${String(s.wave).padStart(2, "0")}`,
          wave: s.wave,
          acq_time: s.startedAt,
          site: s.site,
          duration_ms: s.durationMs,
          foreground_ms: s.foregroundMs,
          n_answered: s.answeredCount,
          n_skipped: s.skippedCount,
          n_too_fast: s.tooFastCount,
          n_revisited: s.revisitedCount,
          review_edits: s.reviewEdits,
          complete: s.complete,
          release_hash: s.releaseHash,
        })),
      ),
    });
  }
  if (bySubject.size > 0) {
    files.push({
      path: "sessions.json",
      content: json({
        session_id: { Description: "Wave label for this participant." },
        acq_time: { Description: "When the sitting started (ISO 8601)." },
        site: { Description: "Site code, from the researcher-issued study code." },
        duration_ms: { Description: "Wall-clock duration of the sitting." },
        foreground_ms: {
          Description:
            "Duration with the app in the foreground. Differs from duration_ms when the device was put down or locked mid-session.",
        },
        n_too_fast: {
          Description:
            "Answers given faster than the item could plausibly have been read. A data-quality signal, not a judgement — the answers themselves are kept unedited.",
        },
        n_revisited: { Description: "Items the participant returned to." },
        review_edits: { Description: "Answers changed from the end-of-survey review." },
        complete: { Description: "1 if the participant reached the end of the survey." },
        release_hash: {
          Description: "Content hash of the release administered, naming the exact wording and codes used.",
        },
      }),
    });
  }

  // ── .bidsignore — name what a validator will not recognise ──────────────
  files.push({
    path: ".bidsignore",
    content: "# Survey-only dataset: no imaging modalities are present yet.\n",
  });

  // The narrative module's runs, where a study ran one.
  files.push(...narrativeFiles(options.narratives ?? [], data));

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
