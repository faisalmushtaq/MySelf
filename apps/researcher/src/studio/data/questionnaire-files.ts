import { NO_CHANGES, type QuestionnaireAnswer, type QuestionnaireDocument, type QuestionnaireQuestion } from "@myself/studio";

/**
 * A published version's readable questionnaire as a Word file or a PDF (D-76),
 * for ethics submissions, collaborators and the file. Both are laid out from
 * `questionnaireDocument`, the same content as the archive's HTML and PDF, so
 * they cannot say different things. Built in the browser from the release
 * already loaded: nothing is sent anywhere. The libraries load only when a
 * file is asked for.
 */

const GREY = "666666";
const AMBER = "7A4B00";

/** "Shown only if…" and the other per-question lines, as label text. */
const metaLine = (q: QuestionnaireQuestion) => `${q.type}${q.required ? ` · ${q.required}` : ""} · ${q.variable} · ${q.itemKey}`;

const paragraphsOf = (text: string) => text.split(/\n{2,}/).map((p) => p.split("\n"));

// ---------------------------------------------------------------- Word (.docx)

export async function questionnaireDocx(doc: QuestionnaireDocument): Promise<Blob> {
  const { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  type Child = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const INDENT = 560; // twentieths of a point: lines up under the question text
  const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };

  const runs = (lines: string[], opts: { size?: number; color?: string; italics?: boolean } = {}) =>
    lines.map((line, i) => new TextRun({ text: line, ...(i > 0 ? { break: 1 } : {}), ...opts }));
  const plain = (text: string, opts: { size?: number; color?: string; italics?: boolean; indent?: number; after?: number } = {}) =>
    new Paragraph({
      children: runs(text.split("\n"), opts),
      ...(opts.indent ? { indent: { left: opts.indent } } : {}),
      spacing: { after: opts.after ?? 60 },
    });

  const answer = (a: QuestionnaireAnswer): Child[] => {
    const out: Child[] = [];
    if (a.options?.length) {
      out.push(
        new Table({
          borders: noBorders,
          indent: { size: INDENT, type: WidthType.DXA },
          rows: a.options.map(
            (o) =>
              new TableRow({
                children: [
                  new TableCell({
                    width: { size: 600, type: WidthType.DXA },
                    children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: o.code, size: 19, color: GREY })] })],
                  }),
                  new TableCell({
                    width: { size: 7800, type: WidthType.DXA },
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text: o.label, size: 19 }), ...(o.specify ? [new TextRun({ text: " (described in a box)", size: 19, italics: true })] : [])],
                      }),
                    ],
                  }),
                ],
              }),
          ),
        }),
      );
    }
    if (a.detail) out.push(plain(a.detail, { size: 19, indent: INDENT }));
    if (a.list) a.list.items.forEach((item, i) => out.push(plain(`${a.list!.ordered ? `${i + 1}.` : "•"}  ${item}`, { size: 19, indent: INDENT })));
    if (a.after) out.push(plain(a.after, { size: 19, indent: INDENT }));
    return out;
  };

  const question = (q: QuestionnaireQuestion): Child[] => [
    new Paragraph({
      keepNext: true,
      spacing: { before: 160, after: 20 },
      indent: { left: INDENT, hanging: INDENT },
      children: [new TextRun({ text: `${q.number}\t`, bold: true, color: GREY }), new TextRun({ text: q.stem, bold: true })],
      tabStops: [{ type: "left", position: INDENT }],
    }),
    plain(metaLine(q), { size: 17, color: GREY, indent: INDENT }),
    ...(q.condition ? [plain(q.condition, { size: 18, color: AMBER, indent: INDENT })] : []),
    ...(q.lede ? paragraphsOf(q.lede).map((lines) => new Paragraph({ indent: { left: INDENT }, spacing: { after: 60 }, children: runs(lines, { size: 20 }) })) : []),
    ...answer(q.answer),
  ];

  const children: Child[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(doc.title)] }),
    new Table({
      borders: noBorders,
      rows: doc.facts.map(
        (f) =>
          new TableRow({
            children: [
              new TableCell({ width: { size: 2000, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: f.label, color: GREY, size: 20 })] })] }),
              new TableCell({
                width: { size: 7000, type: WidthType.DXA },
                children: [new Paragraph({ children: [new TextRun({ text: f.value, size: 20, ...(f.code ? { font: "Consolas" } : {}) })] })],
              }),
            ],
          }),
      ),
    }),
  ];
  if (doc.releaseNote) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Release note")] }), plain(doc.releaseNote));
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("What changed")] }));
  if (doc.changes.length) doc.changes.forEach((c) => children.push(plain(`•  ${c}`)));
  else children.push(plain(NO_CHANGES));
  for (const s of doc.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: false, children: [new TextRun(s.title)] }));
    if (s.condition) children.push(plain(s.condition, { size: 18, color: AMBER }));
    for (const b of s.blocks) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          keepNext: true,
          children: [new TextRun(b.name), ...(b.locked ? [new TextRun({ text: "  (validated, used as licensed)", size: 18, color: GREY })] : [])],
        }),
      );
      if (b.condition) children.push(plain(b.condition, { size: 18, color: AMBER }));
      for (const q of b.questions) children.push(...question(q));
    }
  }
  if (doc.mystory) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("MyStory")] }), plain(doc.mystory));
  children.push(plain(doc.footer, { size: 17, color: GREY }));

  const document = new Document({
    title: doc.title,
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1020, bottom: 1020, left: 907, right: 907 } } }, children }],
  });
  return Packer.toBlob(document);
}

// ---------------------------------------------------------------- PDF

/**
 * Characters the PDF's font has no shape for (emoji, mostly) come out as
 * nothing rather than as boxes. The Word file keeps them.
 */
const printable = (text: string) => text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/ {2,}/g, " ");

export async function questionnairePdf(doc: QuestionnaireDocument): Promise<Blob> {
  const [{ default: pdfMake }, fonts] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  // The font bundle is the file map itself in 0.2.x (older builds wrapped it in `pdfMake.vfs` or `vfs`).
  type Vfs = Record<string, string>;
  const mod = ((fonts as { default?: unknown }).default ?? fonts) as Vfs & { vfs?: Vfs; pdfMake?: { vfs: Vfs } };
  const vfs = mod["Roboto-Regular.ttf"] ? mod : (mod.vfs ?? mod.pdfMake?.vfs);
  if (!vfs) throw new Error("The PDF fonts did not load.");
  (pdfMake as unknown as { vfs: Vfs }).vfs = vfs;

  type Node = Record<string, unknown> | string;
  const t = (s: string) => printable(s);
  const INDENT = 22;

  const answer = (a: QuestionnaireAnswer): Node[] => {
    const out: Node[] = [];
    if (a.options?.length) {
      out.push({
        margin: [INDENT, 2, 0, 2],
        layout: "noBorders",
        table: {
          widths: [24, "*"],
          body: a.options.map((o) => [
            { text: o.code, alignment: "right", color: "#666666", fontSize: 9 },
            { text: [t(o.label), ...(o.specify ? [{ text: " (described in a box)", italics: true }] : [])], fontSize: 9 },
          ]),
        },
      });
    }
    if (a.detail) out.push({ text: t(a.detail), fontSize: 9, margin: [INDENT, 2, 0, 2] });
    if (a.list) out.push({ [a.list.ordered ? "ol" : "ul"]: a.list.items.map(t), fontSize: 9, margin: [INDENT, 2, 0, 2] });
    if (a.after) out.push({ text: t(a.after), fontSize: 9, margin: [INDENT, 2, 0, 2] });
    return out;
  };

  const question = (q: QuestionnaireQuestion): Node => ({
    unbreakable: true,
    margin: [0, 6, 0, 4],
    stack: [
      {
        columns: [
          { text: String(q.number), width: INDENT, bold: true, color: "#555555" },
          { text: t(q.stem), bold: true },
        ],
      },
      { text: t(metaLine(q)), fontSize: 8, color: "#666666", margin: [INDENT, 1, 0, 0] },
      ...(q.condition ? [{ text: t(q.condition), fontSize: 8.5, color: "#7a4b00", margin: [INDENT, 2, 0, 0] }] : []),
      ...(q.lede ? paragraphsOf(q.lede).map((lines) => ({ text: t(lines.join("\n")), fontSize: 9.5, color: "#333333", margin: [INDENT, 2, 0, 0] })) : []),
      ...answer(q.answer),
    ],
  });

  const content: Node[] = [
    { text: t(doc.title), style: "title" },
    {
      layout: "noBorders",
      margin: [0, 4, 0, 8],
      table: { widths: [80, "*"], body: doc.facts.map((f) => [{ text: f.label, color: "#555555" }, { text: t(f.value), fontSize: f.code ? 8.5 : 10 }]) },
    },
  ];
  if (doc.releaseNote) content.push({ text: "Release note", style: "h2" }, { text: t(doc.releaseNote) });
  content.push({ text: "What changed", style: "h2" }, doc.changes.length ? { ul: doc.changes.map(t) } : { text: NO_CHANGES });
  for (const s of doc.sections) {
    content.push({ text: t(s.title), style: "h2" });
    if (s.condition) content.push({ text: t(s.condition), fontSize: 8.5, color: "#7a4b00" });
    for (const b of s.blocks) {
      content.push({ text: [t(b.name), ...(b.locked ? [{ text: "  (validated, used as licensed)", fontSize: 8, color: "#666666", bold: false }] : [])], style: "h3" });
      if (b.condition) content.push({ text: t(b.condition), fontSize: 8.5, color: "#7a4b00" });
      for (const q of b.questions) content.push(question(q));
    }
  }
  if (doc.mystory) content.push({ text: "MyStory", style: "h2" }, { text: t(doc.mystory) });
  content.push({ text: doc.footer, fontSize: 8, color: "#666666", margin: [0, 14, 0, 0] });

  const definition = {
    pageSize: "A4",
    pageMargins: [45, 50, 45, 50],
    info: { title: printable(doc.title) },
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.2 },
    styles: {
      title: { fontSize: 18, bold: true, margin: [0, 0, 0, 4] },
      h2: { fontSize: 14, bold: true, margin: [0, 14, 0, 4] },
      h3: { fontSize: 11.5, bold: true, color: "#333333", margin: [0, 10, 0, 2] },
    },
    footer: (page: number, pages: number) => ({ text: `${page} / ${pages}`, alignment: "center", fontSize: 8, color: "#888888", margin: [0, 20, 0, 0] }),
    content,
  };
  const pdf = (pdfMake as unknown as { createPdf: (d: unknown) => { getBlob: (cb: (b: Blob) => void) => void } }).createPdf(definition);
  return new Promise<Blob>((resolve) => pdf.getBlob(resolve));
}
