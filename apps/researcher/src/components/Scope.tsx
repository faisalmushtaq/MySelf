import type { CountResult } from "@myself/store";
import type { PullRecord, SittingSource } from "../lib/db.js";

/**
 * What the numbers below are counted over, and how old they are.
 *
 * The research dashboard reads the study's database live; this view counts what was
 * last pulled into this browser, plus anything imported from a file by hand, which the
 * dashboard never sees. Both differences move the numbers, so both are stated here
 * rather than left for somebody to discover by comparing two screens.
 */

const int = (n: number): string => n.toLocaleString("en-GB");
const plural = (n: number, noun: string): string => `${int(n)} ${noun}${n === 1 ? "" : "s"}`;
const when = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function Scope({
  counted,
  sources,
  pull,
  studyAvailable,
  includeTest,
  onIncludeTest,
}: {
  counted: CountResult;
  sources: Record<SittingSource, number>;
  pull: PullRecord | null;
  studyAvailable: boolean;
  includeTest: boolean;
  onIncludeTest: (include: boolean) => void;
}) {
  const patterns = counted.rules.testCodePatterns.join(", ");
  const heldBack = (pull?.quarantined ?? 0) + (pull?.unreadable.length ?? 0);

  const origin = [
    sources.study > 0 && `${plural(sources.study, "sitting")} from the study database`,
    sources.file > 0 && `${int(sources.file)} only from files imported by hand, which the dashboard cannot see`,
    sources.demonstration > 0 && `${int(sources.demonstration)} made up for demonstration`,
  ].filter((part): part is string => typeof part === "string");

  return (
    <section className="scope" aria-label="What is counted">
      <p className="note">
        {studyAvailable
          ? pull
            ? `Last pulled from the study on ${when(pull.at)}.`
            : "Not pulled from the study in this browser yet."
          : "This build is not connected to a study."}{" "}
        {origin.length > 0 ? `Held here: ${origin.join("; ")}.` : "Nothing is held here yet."}
      </p>
      <p className="note">
        {counted.test.count === 0
          ? `No test sittings (study codes matching ${patterns}).`
          : counted.test.included
            ? `${plural(counted.test.count, "test sitting")} (study codes matching ${patterns}) counted, as you asked.`
            : `${plural(counted.test.count, "test sitting")} (study codes matching ${patterns}) left out, as the dashboard leaves them out.`}{" "}
        {heldBack === 0
          ? pull
            ? "The study held nothing back at the last pull."
            : ""
          : `${plural(heldBack, "sitting")} the study is holding back ${[
              pull!.quarantined > 0 && `(${int(pull!.quarantined)} quarantined for review)`,
              pull!.unreadable.length > 0 && `(${int(pull!.unreadable.length)} unreadable: ${pull!.unreadable.join(", ")})`,
            ]
              .filter(Boolean)
              .join(" ")} ${heldBack === 1 ? "is" : "are"} not counted, here or in the dashboard.`}
      </p>
      <label className="check">
        <input type="checkbox" checked={includeTest} onChange={(e) => onIncludeTest(e.target.checked)} />
        Include test sittings
      </label>
    </section>
  );
}
