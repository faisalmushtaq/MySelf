import type { AuditDoc, ChangeEntry, ChangeKind, ChangeSummary } from "@myself/studio";
import { formatDateTime, formatRelative, plural, toDate, versionLabel } from "../format.js";
import { Badge, Button, EmptyState, InfoTip, Notice } from "../ui/kit.js";

/**
 * Pieces several Studio pages share: a load failure with a retry, a change
 * summary as a tidy diff list, and the activity log in sentences.
 */

export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <Notice
      tone="error"
      action={
        <Button size="sm" variant="secondary" icon="restart" onClick={retry}>
          Try again
        </Button>
      }
    >
      {error}
    </Notice>
  );
}

// ── Change summaries ──────────────────────────────────────────────────────

const GROUPS: { kinds: ChangeKind[]; title: string }[] = [
  { kinds: ["question.added"], title: "Questions added" },
  { kinds: ["question.removed"], title: "Questions removed" },
  { kinds: ["question.archived"], title: "Questions archived" },
  { kinds: ["question.restored"], title: "Questions restored" },
  { kinds: ["question.changed"], title: "Questions changed" },
  { kinds: ["question.moved", "question.reordered"], title: "Questions moved or reordered" },
  { kinds: ["section.added", "section.removed", "section.changed", "section.reordered"], title: "Sections" },
  { kinds: ["mystory.added", "mystory.removed", "mystory.changed"], title: "MyStory" },
  { kinds: ["welcome.changed", "completion.changed"], title: "Start and finish screens" },
  { kinds: ["settings.changed"], title: "Survey settings" },
];

/**
 * A summary's entries under their headings, in survey order. A kind no heading
 * names is listed under "Other changes" rather than left out: a change the
 * publisher is never shown is a change nobody agreed to.
 */
export function changeGroups(summary: Pick<ChangeSummary, "entries">): { title: string; entries: ChangeEntry[] }[] {
  const named = new Set<ChangeKind>(GROUPS.flatMap((g) => g.kinds));
  const groups = GROUPS.map((g) => ({ title: g.title, entries: summary.entries.filter((e) => g.kinds.includes(e.kind)) }));
  groups.push({ title: "Other changes", entries: summary.entries.filter((e) => !named.has(e.kind)) });
  return groups.filter((g) => g.entries.length > 0);
}

const BUMP_WORDS = { major: "a major version", minor: "a minor version", patch: "a patch version" } as const;

/** One line saying how much changed and what version it needs. */
export function changeHeadline(summary: ChangeSummary): string {
  if (summary.entries.length === 0) return "No changes.";
  const parts = [plural(summary.entries.length, "change")];
  if (summary.bump) parts.push(`needs ${BUMP_WORDS[summary.bump]}`);
  return `${parts.join(" · ")}.`;
}

const BREAKING_HELP =
  "A breaking change alters how answers are coded or compared: data collected before and after it can’t be read as the same question.";

/** A change summary grouped by kind, breaking changes marked in words as well as colour. */
export function ChangeList({ summary, empty = "Nothing changed." }: { summary: ChangeSummary; empty?: string }) {
  if (summary.entries.length === 0) return <p className="stp-muted stp-flush">{empty}</p>;
  const breaking = summary.entries.some((e) => e.breaking);
  return (
    <div className="stp-changes">
      {breaking ? (
        <p className="stp-changes-note">
          <Badge tone="warn" icon="warning">
            Breaking
          </Badge>
          <span>changes how answers are coded</span>
          <InfoTip label="breaking changes" text={BREAKING_HELP} />
        </p>
      ) : null}
      {changeGroups(summary).map(({ title, entries }) => (
        <section key={title} className="stp-change-group">
          <h4>
            {title} <span className="stp-count">{entries.length}</span>
          </h4>
          <ul>
            {entries.map((e, i) => (
              <ChangeRow key={`${e.kind}:${e.itemKey ?? e.sectionKey ?? i}:${i}`} entry={e} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The diff sign for a change: + for something added, − for something taken away, ~ for the rest. The group heading says it in words. */
function signOf(kind: ChangeKind): { sign: string; tone: "add" | "remove" | "change" } {
  if (kind.endsWith(".added") || kind.endsWith(".restored")) return { sign: "+", tone: "add" };
  if (kind.endsWith(".removed") || kind.endsWith(".archived")) return { sign: "−", tone: "remove" };
  if (kind.endsWith(".moved") || kind.endsWith(".reordered")) return { sign: "↕", tone: "change" };
  return { sign: "~", tone: "change" };
}

function ChangeRow({ entry }: { entry: ChangeEntry }) {
  const { sign, tone } = signOf(entry.kind);
  return (
    <li>
      <span className={`stp-change-sign ${tone}`} aria-hidden="true">
        {sign}
      </span>
      <span className="stp-change-text">{entry.message}</span>
      {entry.breaking ? (
        <Badge tone="warn" icon="warning">
          Breaking
        </Badge>
      ) : null}
    </li>
  );
}

// ── Activity ──────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** An audit row as a sentence. The detail shapes are the functions'; anything unexpected is left out rather than guessed. */
export function describeAudit(row: AuditDoc): string {
  const who = row.actorEmail ?? "Someone";
  const d = row.detail ?? {};
  const reason = str(d["reason"]);
  const role = str(d["role"]);
  switch (row.action) {
    case "survey.imported": {
      const imported = Array.isArray(d["imported"]) ? (d["imported"] as unknown[]).filter((v): v is string => typeof v === "string") : [];
      return imported.length > 0
        ? `${who} set up the survey from the live release, bringing in ${imported.map(versionLabel).join(", ")}.`
        : `${who} set up the survey from the live release.`;
    }
    case "survey.created": {
      const from = str(d["fromVersion"]) ?? str(d["from"]);
      return from ? `${who} created the survey from ${versionLabel(from)}.` : `${who} created the survey.`;
    }
    case "draft.edited": {
      const keys = row.subject ? row.subject.split(/[,\s]+/).filter(Boolean) : [];
      return keys.length > 0
        ? `${who} edited the draft (${plural(keys.length, "question")}: ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? "…" : ""}).`
        : `${who} edited the draft.`;
    }
    case "draft.restored":
      return `${who} restored ${versionLabel(row.subject)} into the draft.`;
    case "draft.unlocked":
      return reason ? `${who} unlocked ${row.subject} for editing: “${reason}”` : `${who} unlocked ${row.subject} for editing.`;
    case "version.published":
      return `${who} published ${versionLabel(row.subject)}.`;
    case "version.activated":
      return reason
        ? `${who} made ${versionLabel(row.subject)} live again: “${reason}”`
        : `${who} made ${versionLabel(row.subject)} live again.`;
    case "access.member_set":
      return role ? `${who} gave ${row.subject} the ${role} role.` : `${who} changed ${row.subject}’s access.`;
    case "access.member_removed":
      return `${who} removed ${row.subject}’s access.`;
    case "access.domain_set":
      return role
        ? `${who} let every verified account at ${row.subject} in as ${role}.`
        : `${who} removed the rule for ${row.subject}.`;
    default:
      return `${who}: ${String(row.action)} ${row.subject}`;
  }
}

/** The activity log: one compact line per event, newest first. */
export function AuditList({ rows, empty }: { rows: AuditDoc[]; empty: string }) {
  if (rows.length === 0) return <EmptyState icon="history" title="No activity yet">{empty}</EmptyState>;
  return (
    <ol className="stp-audit">
      {rows.map((row, i) => {
        const at = toDate(row.at);
        return (
          <li key={`${row.action}:${row.subject}:${at?.getTime() ?? i}:${i}`}>
            <time dateTime={at?.toISOString()} title={formatDateTime(at)}>
              {formatRelative(at)}
            </time>
            <span>{describeAudit(row)}</span>
          </li>
        );
      })}
    </ol>
  );
}
