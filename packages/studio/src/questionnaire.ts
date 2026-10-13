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
 * runs and what the hash covers. This page only has to be faithful and
 * readable, so it is built from the same draft model the Studio edits with.
 * Self-contained HTML with print styles; the archive prints it to PDF.
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

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const para = (s: string | undefined | null): string =>
  s ? s.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("") : "";

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
  checkbox_set: "Statements to tick",
};

function shownWhen(expr: unknown, draft: StudioDraft): string {
  if (!expr) return "";
  try {
    return describeCondition(expr as LogicExpr, draft);
  } catch {
    return "Shown only under a condition (see the release JSON).";
  }
}

function options(scale: ScaleInput | undefined): string {
  if (!scale) return "";
  const rows = scale.options
    .map((o) => `<tr><td class="code">${esc(o.code)}</td><td>${esc(o.label)}${o.kind === "other_specify" ? " <em>(described in a box)</em>" : ""}</td></tr>`)
    .join("");
  return `<table class="options"><tbody>${rows}</tbody></table>`;
}

function answerPart(item: ItemDefinition, draft: StudioDraft): string {
  const it = item as ItemDefinition & Record<string, unknown>;
  switch (item.responseType) {
    case "single_choice":
    case "multi_choice":
    case "rank_group":
      return options(draft.scales[(it["scale"] as string) ?? ""]) +
        (item.responseType === "rank_group" ? `<p class="detail">Groups: ${esc((it["groups"] as { label: string }[]).map((g) => g.label).join(", "))}</p>` : "");
    case "slider":
    case "ladder": {
      const min = it["min"] ?? it["rungs"] ?? "";
      const labels = [it["minLabel"], it["maxLabel"]].filter(Boolean).map(esc).join(" … ");
      return `<p class="detail">${esc(item.responseType === "slider" ? `${String(it["min"])} to ${String(it["max"])}` : `${String(min)} rungs`)}${labels ? ` (${labels})` : ""}</p>`;
    }
    case "numeric": {
      const range = [it["min"] !== undefined ? `from ${String(it["min"])}` : "", it["max"] !== undefined ? `to ${String(it["max"])}` : ""].filter(Boolean).join(" ");
      return `<p class="detail">A number${range ? ` ${range}` : ""}${it["unitLabel"] ? ` (${esc(it["unitLabel"])})` : ""}.</p>`;
    }
    case "form_fields":
      return `<ul class="fields">${(it["fields"] as { label: string; required?: boolean }[]).map((f) => `<li>${esc(f.label)}${f.required ? " (required)" : ""}</li>`).join("")}</ul>`;
    case "checkbox_set":
      return `<ol class="statements">${(it["statements"] as { text: { text: string } }[]).map((s) => `<li>${esc(s.text.text)}</li>`).join("")}</ol>` +
        (it["autoAdvance"] ? `<p class="detail">Moves on by itself once every statement is ticked.</p>` : "");
    default:
      return "";
  }
}

function question(q: OutlineQuestion, number: number, draft: StudioDraft): string {
  const found = findQuestion(draft, q.itemKey);
  if (!found) return "";
  const item = found.item as ItemDefinition & { lede?: { text: string }; required?: string; displayIf?: unknown };
  const required = item.responseType === "info" ? "" : item.required === "hard" ? "Required" : item.required === "optional" ? "Optional" : "Asked (can be skipped)";
  const condition = shownWhen(item.displayIf, draft);
  return `<section class="q">
    <div class="qhead"><span class="num">${number}</span><div><h4>${esc(item.stem.text)}</h4>
    <p class="meta">${esc(TYPE_NAMES[item.responseType])}${required ? ` · ${required}` : ""} · <code>${esc(item.variable)}</code> · <code>${esc(q.itemKey)}</code></p></div></div>
    ${condition ? `<p class="cond">${esc(condition)}</p>` : ""}
    ${item.lede?.text ? `<div class="lede">${para(item.lede.text)}</div>` : ""}
    ${answerPart(item, draft)}
  </section>`;
}

function changes(summary: ChangeSummary | null): string {
  if (!summary || summary.entries.length === 0) return "<p>No changes recorded (the first version, or set up from the repository).</p>";
  return `<ul class="changes">${summary.entries.map((e) => `<li>${esc(e.message)}</li>`).join("")}</ul>`;
}

/** The whole published version as one self-contained, printable HTML page. */
export function questionnaireHtml(draft: StudioDraft, meta: QuestionnaireMeta): string {
  const o = outline(draft);
  let n = 0;
  const sections = o.sections
    .map((s) => {
      const section = draft.composition.sections[s.index] as { displayIf?: unknown } | undefined;
      const cond = shownWhen(section?.displayIf, draft);
      const blocks = s.blocks
        .map((b) => {
          const component = draft.composition.sections[s.index]!.components[b.componentIndex] as { displayIf?: unknown };
          const bcond = shownWhen(component.displayIf, draft);
          return `<div class="block"><h3>${esc(b.name)}${b.tier === "locked" ? ' <span class="tag">validated, used as licensed</span>' : ""}</h3>
            ${bcond ? `<p class="cond">${esc(bcond)}</p>` : ""}
            ${b.questions.map((q) => question(q, ++n, draft)).join("")}</div>`;
        })
        .join("");
      return `<section class="section"><h2>${esc(s.title)}</h2>${cond ? `<p class="cond">${esc(cond)}</p>` : ""}${blocks}</section>`;
    })
    .join("");
  const story = o.mystory
    ? `<section class="section"><h2>${esc(o.mystory.title)}</h2><p>MyStory: protocol <code>${esc(o.mystory.id)}</code>${o.mystory.name ? ` (${esc(o.mystory.name)})` : ""}. Its prompts and model settings are frozen in the release JSON.</p></section>`
    : "";
  const title = `${o.welcome.title} — version ${meta.version}`;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(title)}</title>
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
<h1>${esc(o.welcome.title)}</h1>
<table class="facts"><tbody>
  <tr><td>Study / survey</td><td><code>${esc(meta.study)}</code> / <code>${esc(meta.surveyId)}</code></td></tr>
  <tr><td>Version</td><td>${esc(meta.version)}${meta.basedOnVersion ? ` (from ${esc(meta.basedOnVersion)})` : ""}</td></tr>
  <tr><td>Published</td><td>${esc(meta.publishedAt)}${meta.publishedBy ? ` by ${esc(meta.publishedBy)}` : ""}</td></tr>
  <tr><td>Release hash</td><td><code>${esc(meta.hash)}</code></td></tr>
  <tr><td>Questions</td><td>${n === 0 ? o.sections.reduce((a, s) => a + s.blocks.reduce((b, k) => b + k.questions.length, 0), 0) : n}</td></tr>
</tbody></table>
${meta.releaseNote ? `<h2>Release note</h2><p class="note">${esc(meta.releaseNote)}</p>` : ""}
<h2>What changed</h2>${changes(meta.changeSummary)}
${sections}${story}
<p class="meta" style="margin-top:18pt">A readable record of the published version. The release JSON with the same hash is the authoritative copy.</p>
</body></html>`;
}
