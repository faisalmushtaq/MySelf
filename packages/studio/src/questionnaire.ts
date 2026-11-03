import type { ItemDefinition, LogicExpr } from "@myself/schema";
import type { ChangeSummary, ScaleInput, StudioDraft } from "./contract.js";
import { describeCondition } from "./logic.js";
import { findQuestion, outline, type OutlineQuestion } from "./model.js";

/**
 * A published version as a document a person can read, print and file (D-60):
 * every section, block and question in the order a participant meets them,
 * with the answer options and their codes, the variable each answer is stored
 * under, whether it is required, and when it is shown — in words.
 *
 * It is a record, not the survey: the release JSON beside it is what the iPad
 * runs and what the hash covers. It only has to be faithful and readable, so
 * it is built from the same draft model the Studio edits with.
 *
 * `questionnaireDocument` says what the document holds, as plain text;
 * `questionnaireHtml` lays it out as a printable page (the archive prints it
 * to PDF), and the Studio lays the same document out as Word and PDF files
 * (D-76), so the three can never say different things.
 */

export interface QuestionnaireMeta {
  study: string;
  surveyId: string;
  version: string;
  hash: string;
  publishedAt: string;
  publishedBy: string | null;
  releaseNote: string | null;
  changeSummary: ChangeSummary | null;
  basedOnVersion: string | null;
}

/** How a question is answered, beyond its type. */
export interface QuestionnaireAnswer {
  /** Answer options with their stored codes. */
  options?: { code: string; label: string; specify: boolean }[];
  /** A line about the answer: a range, the groups, how a grid is stored. */
  detail?: string;
  /** Form fields, or statements to tick. */
  list?: { items: string[]; ordered: boolean };
  /** A second line of detail, after the list. */
  after?: string;
}

export interface QuestionnaireQuestion {
  number: number;
  stem: string;
  type: string;
  /** "Required", "Optional", "Asked (can be skipped)", or null for information screens. */
  required: string | null;
  variable: string;
  itemKey: string;
  condition: string | null;
  lede: string | null;
  answer: QuestionnaireAnswer;
}

export interface QuestionnaireDocument {
  title: string;
  /** "Version 17.0.0" and the like, as label / value; `code` values are identifiers. */
  facts: { label: string; value: string; code?: boolean }[];
  releaseNote: string | null;
  changes: string[];
  sections: {
    title: string;
    condition: string | null;
    blocks: { name: string; locked: boolean; condition: string | null; questions: QuestionnaireQuestion[] }[];
  }[];
  mystory: string | null;
  footer: string;
}

const TYPE_NAMES: Record<ItemDefinition["responseType"], string> = {
  info: "Information",
  single_choice: "Single choice",
  multi_choice: "Multiple choice (all that apply)",
  slider: "Slider",
  ladder: "Ladder",
  numeric: "Number",
  date: "Date",
  text_short: "Short text",
  text_long: "Long text",
  form_fields: "Form",
  rank_group: "Sort into groups",
  time_grid: "Time for each chosen option",
  checkbox_set: "Statements to tick",
};

function shownWhen(expr: unknown, draft: StudioDraft): string | null {
  if (!expr) return null;
  try {
    return describeCondition(expr as LogicExpr, draft) || null;
  } catch {
    return "Shown only under a condition (see the release JSON).";
  }
}

function options(scale: ScaleInput | undefined): QuestionnaireAnswer["options"] {
  return scale?.options.map((o) => ({ code: String(o.code), label: o.label, specify: o.kind === "other_specify" }));
}

function answerOf(item: ItemDefinition, draft: StudioDraft): QuestionnaireAnswer {
  const it = item as ItemDefinition & Record<string, unknown>;
  switch (item.responseType) {
    case "single_choice":
    case "multi_choice":
      return { options: options(draft.scales[(it["scale"] as string) ?? ""]) ?? [] };
    case "rank_group":
      return {
        options: options(draft.scales[(it["scale"] as string) ?? ""]) ?? [],
        detail: `Groups: ${(it["groups"] as { label: string }[]).map((g) => g.label).join(", ")}`,
      };
    case "slider":
    case "ladder": {
      const labels = [it["minLabel"], it["maxLabel"]].filter(Boolean).map(String).join(" … ");
      const range = item.responseType === "slider" ? `${String(it["min"])} to ${String(it["max"])}` : `${String(it["min"] ?? it["rungs"] ?? "")} rungs`;
      return { detail: `${range}${labels ? ` (${labels})` : ""}` };
    }
    case "numeric": {
      const range = [it["min"] !== undefined ? `from ${String(it["min"])}` : "", it["max"] !== undefined ? `to ${String(it["max"])}` : ""].filter(Boolean).join(" ");
      return { detail: `A number${range ? ` ${range}` : ""}${it["unitLabel"] ? ` (${String(it["unitLabel"])})` : ""}.` };
    }
    case "form_fields":
      return { list: { items: (it["fields"] as { label: string; required?: boolean }[]).map((f) => `${f.label}${f.required ? " (required)" : ""}`), ordered: false } };
    case "time_grid": {
      const from = it["rowsFrom"] as { instrument: string; item: string; group?: string };
      const max = typeof it["maxMinutesPerRow"] === "number" ? ` Each row at most ${String(it["maxMinutesPerRow"])} minutes.` : "";
      return {
        detail: `Hours and minutes for each option ${from.group ? `put in “${from.group}” at` : "chosen at"} ${from.instrument}.${from.item}, stored per option as ${item.variable}_<code> (total minutes).${max}`,
      };
    }
    case "checkbox_set":
      return {
        list: { items: (it["statements"] as { text: { text: string } }[]).map((s) => s.text.text), ordered: true },
        ...(it["autoAdvance"] ? { after: "Moves on by itself once every statement is ticked." } : {}),
      };
    default:
      return {};
  }
}

function questionOf(q: OutlineQuestion, number: number, draft: StudioDraft): QuestionnaireQuestion | null {
  const found = findQuestion(draft, q.itemKey);
  if (!found) return null;
  const item = found.item as ItemDefinition & { lede?: { text: string }; required?: string; displayIf?: unknown };
  return {
    number,
    stem: item.stem.text,
    type: TYPE_NAMES[item.responseType],
    required: item.responseType === "info" ? null : item.required === "hard" ? "Required" : item.required === "optional" ? "Optional" : "Asked (can be skipped)",
    variable: item.variable,
    itemKey: q.itemKey,
    condition: shownWhen(item.displayIf, draft),
    lede: item.lede?.text?.trim() ? item.lede.text : null,
    answer: answerOf(item, draft),
  };
}

/** What the readable questionnaire for a version holds, in order. */
export function questionnaireDocument(draft: StudioDraft, meta: QuestionnaireMeta): QuestionnaireDocument {
  const o = outline(draft);
  let n = 0;
  const sections = o.sections.map((s) => {
    const section = draft.composition.sections[s.index] as { displayIf?: unknown } | undefined;
    return {
      title: s.title,
      condition: shownWhen(section?.displayIf, draft),
      blocks: s.blocks.map((b) => {
        const component = draft.composition.sections[s.index]!.components[b.componentIndex] as { displayIf?: unknown };
        return {
          name: b.name,
          locked: b.tier === "locked",
          condition: shownWhen(component.displayIf, draft),
          questions: b.questions.map((q) => questionOf(q, ++n, draft)).filter((q): q is QuestionnaireQuestion => q !== null),
        };
      }),
    };
  });
  return {
    title: o.welcome.title,
    facts: [
      { label: "Study / survey", value: `${meta.study} / ${meta.surveyId}`, code: true },
      { label: "Version", value: `${meta.version}${meta.basedOnVersion ? ` (from ${meta.basedOnVersion})` : ""}` },
      { label: "Published", value: `${meta.publishedAt}${meta.publishedBy ? ` by ${meta.publishedBy}` : ""}` },
      { label: "Release hash", value: meta.hash, code: true },
      { label: "Questions", value: String(n) },
    ],
    releaseNote: meta.releaseNote?.trim() ? meta.releaseNote : null,
    changes: meta.changeSummary?.entries.map((e) => e.message) ?? [],
    sections,
    mystory: o.mystory
      ? `${o.mystory.title}: MyStory protocol ${o.mystory.id}${o.mystory.name ? ` (${o.mystory.name})` : ""}. Its prompts and model settings are frozen in the release JSON.`
      : null,
    footer: "A readable record of the published version. The release JSON with the same hash is the authoritative copy.",
  };
}

/** "No changes recorded", when a version has none. */
export const NO_CHANGES = "No changes recorded (the first version, or set up from the repository).";

/** A filename for a version's questionnaire: `ybm_nd2026_standard_v17.0.0_questionnaire.docx`. */
export function questionnaireFilename(meta: Pick<QuestionnaireMeta, "surveyId" | "version">, ext: "html" | "docx" | "pdf"): string {
  return `${meta.surveyId}_v${meta.version}_questionnaire.${ext}`.replace(/[^\w.-]/g, "_");
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const para = (s: string | null): string => (s ? s.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("") : "");

function answerHtml(a: QuestionnaireAnswer): string {
  const opts = a.options?.length
    ? `<table class="options"><tbody>${a.options.map((o) => `<tr><td class="code">${esc(o.code)}</td><td>${esc(o.label)}${o.specify ? " <em>(described in a box)</em>" : ""}</td></tr>`).join("")}</tbody></table>`
    : "";
  const detail = a.detail ? `<p class="detail">${esc(a.detail)}</p>` : "";
  const list = a.list
    ? `<${a.list.ordered ? "ol class=\"statements\"" : "ul class=\"fields\""}>${a.list.items.map((i) => `<li>${esc(i)}</li>`).join("")}</${a.list.ordered ? "ol" : "ul"}>`
    : "";
  const after = a.after ? `<p class="detail">${esc(a.after)}</p>` : "";
  return opts + detail + list + after;
}

function questionHtml(q: QuestionnaireQuestion): string {
  return `<section class="q">
    <div class="qhead"><span class="num">${q.number}</span><div><h4>${esc(q.stem)}</h4>
    <p class="meta">${esc(q.type)}${q.required ? ` · ${q.required}` : ""} · <code>${esc(q.variable)}</code> · <code>${esc(q.itemKey)}</code></p></div></div>
    ${q.condition ? `<p class="cond">${esc(q.condition)}</p>` : ""}
    ${q.lede ? `<div class="lede">${para(q.lede)}</div>` : ""}
    ${answerHtml(q.answer)}
  </section>`;
}

/** The whole published version as one self-contained, printable HTML page. */
export function questionnaireHtml(draft: StudioDraft, meta: QuestionnaireMeta): string {
  const doc = questionnaireDocument(draft, meta);
  const sections = doc.sections
    .map(
      (s) =>
        `<section class="section"><h2>${esc(s.title)}</h2>${s.condition ? `<p class="cond">${esc(s.condition)}</p>` : ""}${s.blocks
          .map(
            (b) => `<div class="block"><h3>${esc(b.name)}${b.locked ? ' <span class="tag">validated, used as licensed</span>' : ""}</h3>
            ${b.condition ? `<p class="cond">${esc(b.condition)}</p>` : ""}
            ${b.questions.map(questionHtml).join("")}</div>`,
          )
          .join("")}</section>`,
    )
    .join("");
  const story = doc.mystory ? `<section class="section"><h2>MyStory</h2><p>${esc(doc.mystory)}</p></section>` : "";
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(`${doc.title} — version ${meta.version}`)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 10.5pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; }
  h1 { font-size: 18pt; margin: 0 0 4pt; } h2 { font-size: 14pt; margin: 18pt 0 6pt; border-bottom: 1px solid #ccc; padding-bottom: 3pt; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 12pt 0 4pt; color: #333; break-after: avoid; } h4 { font-size: 10.5pt; margin: 0; }
  .facts { border-collapse: collapse; margin: 8pt 0 12pt; } .facts td { padding: 2pt 10pt 2pt 0; vertical-align: top; } .facts td:first-child { color: #555; }
  code { font: 9pt ui-monospace, Menlo, Consolas, monospace; color: #444; word-break: break-all; }
  .q { break-inside: avoid; margin: 0 0 9pt; padding: 0 0 6pt; border-bottom: 1px dotted #ddd; }
  .qhead { display: flex; gap: 8pt; } .num { min-width: 20pt; font-weight: 600; color: #555; }
  .meta { margin: 1pt 0 0; font-size: 8.5pt; color: #666; } .cond { margin: 3pt 0 3pt 28pt; font-size: 9pt; color: #7a4b00; }
  .lede, .detail, .options, .fields, .statements { margin-left: 28pt; } .lede p { margin: 3pt 0; color: #333; }
  .options { border-collapse: collapse; font-size: 9.5pt; margin-top: 3pt; } .options td { padding: 1pt 8pt 1pt 0; } .options .code { color: #666; text-align: right; }
  .detail { font-size: 9.5pt; color: #333; margin-top: 3pt; } .tag { font-size: 8pt; font-weight: 400; color: #666; border: 1px solid #ccc; border-radius: 3pt; padding: 0 3pt; }
  .changes li { margin: 2pt 0; } .note { white-space: pre-wrap; }
</style></head><body>
<h1>${esc(doc.title)}</h1>
<table class="facts"><tbody>
${doc.facts.map((f) => `  <tr><td>${esc(f.label)}</td><td>${f.code ? `<code>${esc(f.value)}</code>` : esc(f.value)}</td></tr>`).join("\n")}
</tbody></table>
${doc.releaseNote ? `<h2>Release note</h2><p class="note">${esc(doc.releaseNote)}</p>` : ""}
<h2>What changed</h2>${doc.changes.length ? `<ul class="changes">${doc.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : `<p>${NO_CHANGES}</p>`}
${sections}${story}
<p class="meta" style="margin-top:18pt">${esc(doc.footer)}</p>
</body></html>`;
}
