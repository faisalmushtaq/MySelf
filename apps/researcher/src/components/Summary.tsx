import { rateOf, type CountResult } from "@myself/store";
import { byWave } from "../lib/longitudinal.js";
import type { Row } from "../lib/filter.js";

/**
 * The global measures: what a monitoring visit needs at a glance, above
 * anything that requires reading a table.
 *
 * Rates are shown with their denominators. "3% too fast" means nothing on its
 * own; "3% of 4,102 answers" is a fact somebody can act on.
 *
 * THE SAME FIGURES AS THE RESEARCH DASHBOARD. Every card is computed by
 * `countSittings` (@myself/store counting.ts), which the dashboard vendors, and the
 * dashboard's Overview shows these cards under these labels, computed by that code
 * over the same sittings. Where the dashboard has a measure of its own — "Median
 * completion time" beside "Median length" — the label differs and says what it counts.
 */

const pct = (value: number | null): string => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null, dp = 1): string => (value === null ? "—" : value.toFixed(dp));
const int = (value: number): string => value.toLocaleString("en-GB");
const plural = (n: number, noun: string): string => `${int(n)} ${noun}${n === 1 ? "" : "s"}`;

export function Summary({ counted, rows }: { counted: CountResult; rows: Row[] }) {
  const f = counted.figures;
  const summary = counted.summary;
  const scoreKeys = summary.scores.map((s) => s.key);
  const trajectories = scoreKeys
    .map((key) => ({ key, waves: byWave(rows, key) }))
    .filter((t) => t.waves.length > 1);
  const judged = `of ${plural(f.finishedOrAbandoned, "finished or abandoned sitting")}`;

  return (
    <section className="summary">
      <div className="cards">
        <Card
          label="Sittings"
          value={int(f.sittings)}
          note={f.notLinked === 0 ? "all linked to a participant" : `${int(f.notLinked)} not linked to a participant`}
        />
        <Card label="Participants" value={int(f.participants)} note={`from ${plural(f.linked, "linked sitting")}`} />
        <Card
          label="Followed up"
          value={int(f.followedUp)}
          note={
            f.participants === 0
              ? "no data yet"
              : `${pct(f.followedUp / f.participants)} of participants · up to wave ${f.maxWave}`
          }
        />
        <Card
          label="Reached the end"
          value={pct(rateOf(f.reachedEnd, f.finishedOrAbandoned))}
          note={`${int(f.reachedEnd)} ${judged}`}
        />
        <Card
          label="All required answered"
          value={pct(rateOf(f.allRequiredAnswered, f.finishedOrAbandoned))}
          note={`${int(f.allRequiredAnswered)} ${judged}`}
        />
        <Card
          label="Median length"
          value={`${num(f.durationMinutes.median)} min`}
          note={
            f.durationMinutes.n === 0
              ? "no sitting has reached the end"
              : `${plural(f.durationMinutes.n, "sitting")} timed on the device · range ${num(f.durationMinutes.min)}–${num(f.durationMinutes.max)}`
          }
        />
        <Card label="Skipped" value={pct(f.skipRate)} note={`of ${int(f.answered + f.skipped)} questions answered, skipped or declined`} />
        <Card label="Answered very fast" value={pct(f.tooFastRate)} note={`of ${plural(f.answered, "answer")} given`} />
      </div>
      <p className="note definitions">
        Both completion measures are out of the sittings that have finished or been abandoned (no word for{" "}
        {counted.rules.abandonAfterHours} hours).{" "}
        {f.byLifecycle.in_progress + f.byLifecycle.not_started === 0
          ? "None is still in progress."
          : `${plural(f.byLifecycle.in_progress, "sitting")} still in progress and ${int(f.byLifecycle.not_started)} not started are in neither.`}{" "}
        &ldquo;All required answered&rdquo; means every required question that applied was answered or declined;
        required means {counted.rules.requiredLevels.join(" and ")} questions. Participants, length, skips and speed
        come from the linked sittings only.
      </p>

      {summary.sites.length > 0 && (
        <div className="panel">
          <h2>Sites</h2>
          <table className="mini">
            <thead>
              <tr>
                <th>Site</th>
                <th className="n">Participants</th>
                <th className="n">Sittings</th>
              </tr>
            </thead>
            <tbody>
              {summary.sites.map((s) => (
                <tr key={s.site}>
                  <td>{s.site}</td>
                  <td className="n">{s.participants}</td>
                  <td className="n">{s.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.scores.length > 0 && (
        <div className="panel">
          <h2>Derived measures</h2>
          <p className="note">
            Recomputed from the raw answers on every load, using the scoring frozen into each release.
          </p>
          <table className="mini">
            <thead>
              <tr>
                <th>Measure</th>
                <th className="n">n</th>
                <th className="n">Missing</th>
                <th className="n">Mean</th>
                <th className="n">SD</th>
                <th className="n">Median</th>
                <th className="n">Range</th>
              </tr>
            </thead>
            <tbody>
              {summary.scores.map((s) => (
                <tr key={s.key}>
                  <td>{s.key}</td>
                  <td className="n">{s.summary.n}</td>
                  <td className="n">{s.summary.missing}</td>
                  <td className="n">{num(s.summary.mean, 2)}</td>
                  <td className="n">{num(s.summary.sd, 2)}</td>
                  <td className="n">{num(s.summary.median, 2)}</td>
                  <td className="n">
                    {/* "to", not a dash: half these scales run through zero and
                        "-100.0--50.0" is unreadable. */}
                    {num(s.summary.min)} to {num(s.summary.max)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {trajectories.length > 0 && (
        <div className="panel">
          <h2>Across waves</h2>
          <p className="note">
            Returning participants only. Comparing a later wave against everyone who ever did a first one mixes
            change with drop-out, and the two cannot be separated afterwards.
          </p>
          <table className="mini">
            <thead>
              <tr>
                <th>Measure</th>
                {[...new Set(trajectories.flatMap((t) => t.waves.map((w) => w.wave)))]
                  .sort((a, b) => a - b)
                  .map((w) => (
                    <th key={w} className="n">
                      Wave {w}
                    </th>
                  ))}
            </tr>
            </thead>
            <tbody>
              {trajectories.map((t) => (
                <tr key={t.key}>
                  <td>{t.key}</td>
                  {t.waves.map((w) => (
                    <td key={w.wave} className="n">
                      {num(w.summary.mean, 1)} <span className="dim">(n={w.n})</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.releaseHashes.length > 0 && (
        <p className="note releases">
          Collected under {summary.releaseHashes.length} release
          {summary.releaseHashes.length === 1 ? "" : "s"}: {summary.releaseHashes.map((h) => h.slice(7, 19)).join(", ")}
        </p>
      )}
    </section>
  );
}

function Card({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card">
      <span className="card-label">{label}</span>
      <span className="card-value">{value}</span>
      <span className="card-note">{note}</span>
    </div>
  );
}
