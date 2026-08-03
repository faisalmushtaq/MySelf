import type { DatasetSummary } from "@myself/store";
import { byWave } from "../lib/longitudinal.js";
import type { Row } from "../lib/filter.js";

/**
 * The global measures: what a monitoring visit needs at a glance, above
 * anything that requires reading a table.
 *
 * Rates are shown with their denominators. "3% too fast" means nothing on its
 * own; "3% of 4,102 answers" is a fact somebody can act on.
 */

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const num = (value: number | null, dp = 1): string => (value === null ? "—" : value.toFixed(dp));

export function Summary({ summary, rows }: { summary: DatasetSummary; rows: Row[] }) {
  const scoreKeys = summary.scores.map((s) => s.key);
  const trajectories = scoreKeys
    .map((key) => ({ key, waves: byWave(rows, key) }))
    .filter((t) => t.waves.length > 1);

  return (
    <section className="summary">
      <div className="cards">
        <Card label="Participants" value={String(summary.participants)} note={`${summary.sessions} sittings`} />
        <Card
          label="Followed up"
          value={String(summary.returning)}
          note={
            summary.participants === 0
              ? "no data yet"
              : `${pct(summary.returning / summary.participants)} of participants · up to wave ${summary.maxWave}`
          }
        />
        <Card label="Completed" value={pct(summary.completionRate)} note={`${summary.completeSessions} of ${summary.sessions} sittings`} />
        <Card label="Median length" value={`${num(summary.durationMinutes.median)} min`} note={`range ${num(summary.durationMinutes.min)}–${num(summary.durationMinutes.max)}`} />
        <Card label="Skipped" value={pct(summary.skipRate)} note="of items presented" />
        <Card label="Answered very fast" value={pct(summary.tooFastRate)} note="of answers given" />
      </div>

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
