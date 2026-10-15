import { analyze, cell, fmtNum, highlights, humanize, pickColumns, query, type Column, type Dataset, type Query, type Shape } from "./shape";

/**
 * Reports are assembled by code from the response data: facts, highlights, field statistics,
 * charts and tables all come from `shape.ts`. An optional summary paragraph (written by the
 * Ask assistant when the user asks for one) is the only AI text, and it is labelled as such.
 */

export type Format = "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "md";

export const FORMATS: { id: Format; label: string; ext: string; mime: string }[] = [
  { id: "pdf", label: "PDF report", ext: "pdf", mime: "application/pdf" },
  { id: "docx", label: "Word document", ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { id: "pptx", label: "PowerPoint deck", ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  { id: "xlsx", label: "Excel workbook", ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { id: "csv", label: "CSV (table)", ext: "csv", mime: "text/csv" },
  { id: "md", label: "Markdown", ext: "md", mime: "text/markdown" },
];

export interface Table {
  heading: string;
  keys: string[];
  labels: string[];
  rows: unknown[][];
  total: number;
}

export interface Chart {
  title: string;
  labels: string[];
  values: number[];
}

export interface Report {
  title: string;
  subtitle: string;
  generated: string;
  aiSummary?: string;
  facts: [string, string][];
  highlights: string[];
  fields: { heading: string; rows: string[][] };
  charts: Chart[];
  tables: Table[];
  /** Every dataset in full, for spreadsheet/CSV output. */
  datasets: Dataset[];
}

export interface ReportInput {
  title: string;
  source?: { method: string; url: string; status: number; timeMs: number };
  data: unknown;
  /** Dataset id to focus on (default: the largest). */
  dataset?: string;
  query?: Query;
  summary?: string;
}

function fieldSummary(c: Column): string {
  if (c.numeric) return `${fmtNum(c.numeric.min)} to ${fmtNum(c.numeric.max)} (avg ${fmtNum(c.numeric.mean)})`;
  if (c.dates) return `${c.dates.min.slice(0, 10)} → ${c.dates.max.slice(0, 10)}`;
  if (c.top && c.unique < c.filled) return c.top.slice(0, 4).map(([v, n]) => `${cell(v, 24)} (${n})`).join(", ");
  return "";
}

/** Bar charts for the clearest categorical breakdowns (2 to 15 categories). */
function chartsFor(ds: Dataset): Chart[] {
  const out: Chart[] = [];
  const cats = ds.columns.filter((c) => c.top && c.unique >= 2 && c.unique <= 15 && c.unique < c.filled && c.type !== "boolean");
  const num = ds.columns.find((c) => c.numeric && c.unique > 1 && !/(^|\.)(id|_id)$/i.test(c.key));
  for (const c of cats.slice(0, 2)) {
    const g = query(ds, { groupBy: c.key });
    out.push({ title: `${ds.label} by ${c.label}`, labels: g.rows.map((r) => String(r[c.key])), values: g.rows.map((r) => Number(r.count)) });
    if (num && out.length < 3) {
      const a = query(ds, { groupBy: c.key, aggregate: { column: num.key, fn: "avg" } });
      out.push({ title: `Average ${num.label} by ${c.label}`, labels: a.rows.map((r) => String(r[c.key])), values: a.rows.map((r) => Number(r[`avg of ${num.key}`]) || 0) });
    }
  }
  return out.slice(0, 3);
}

export function buildReport(input: ReportInput, shape: Shape = analyze(input.data)): Report {
  const main = shape.datasets.find((d) => d.id === input.dataset) ?? shape.datasets[0];
  const tables: Table[] = [];
  if (main) {
    const keys = input.query?.columns?.length || input.query?.groupBy ? undefined : pickColumns(main, 8);
    const q = query(main, { ...input.query, columns: input.query?.columns ?? keys });
    tables.push({ heading: input.query?.groupBy ? `${main.label} by ${humanize(input.query.groupBy)}` : main.label, keys: q.columns, labels: q.columns.map(humanize), rows: q.rows.map((r) => q.columns.map((k) => r[k])), total: q.total });
  }
  // A specific question (grouping or chosen columns) gets a focused report; otherwise include related tables.
  const focused = !!(input.query?.groupBy || input.query?.columns?.length || input.query?.where?.length);
  for (const d of focused ? [] : shape.datasets.filter((d) => d !== main).slice(0, 3)) {
    const keys = pickColumns(d, 6);
    tables.push({ heading: d.label, keys, labels: keys.map(humanize), rows: d.rows.map((r) => keys.map((k) => r[k])), total: d.rows.length });
  }
  const s = input.source;
  return {
    title: input.title,
    subtitle: s ? `${s.method} ${s.url} · ${s.status} · ${Math.round(s.timeMs)} ms` : "",
    generated: new Date().toLocaleString(),
    aiSummary: input.summary?.trim() || undefined,
    facts: shape.facts,
    highlights: main ? highlights(main) : [],
    fields: main
      ? { heading: `Fields in ${main.label}`, rows: main.columns.map((c) => [c.label, c.type, `${Math.round((c.filled / Math.max(1, main.rows.length)) * 100)}%`, String(c.unique), fieldSummary(c)]) }
      : { heading: "Fields", rows: [] },
    charts: main ? chartsFor(main) : [],
    tables,
    datasets: shape.datasets,
  };
}

// ───────────────────────── renderers ─────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);
const FIELD_HEAD = ["Field", "Type", "Filled", "Unique", "Range / common values"];
const ACCENT = "5B4CF0";

export function toCsv(ds: Dataset): string {
  const keys = ds.columns.map((c) => c.key);
  const q = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.map(q).join(","), ...ds.rows.map((r) => keys.map((k) => q(r[k])).join(","))].join("\r\n") + "\r\n";
}

export function toMarkdown(r: Report): string {
  const esc = (v: unknown) => cell(v, 80).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const table = (head: string[], rows: unknown[][]) => [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((x) => `| ${x.map(esc).join(" | ")} |`)].join("\n");
  const parts = [`# ${r.title}`, r.subtitle && `_${r.subtitle}_`, `Generated ${r.generated} by Forge`];
  if (r.aiSummary) parts.push(`## Summary (AI-written)`, r.aiSummary);
  if (r.facts.length) parts.push("## Key facts", table(["Field", "Value"], r.facts));
  if (r.highlights.length) parts.push("## Highlights", r.highlights.map((h) => `- ${h}`).join("\n"));
  for (const c of r.charts) parts.push(`## ${c.title}`, table(["", "Value"], c.labels.map((l, i) => [l, c.values[i]])));
  for (const t of r.tables) parts.push(`## ${t.heading}`, table(t.labels, t.rows.slice(0, 500)), t.total > 500 ? `_Showing 500 of ${t.total} rows._` : "");
  if (r.fields.rows.length) parts.push(`## ${r.fields.heading}`, table(FIELD_HEAD, r.fields.rows));
  return parts.filter(Boolean).join("\n\n") + "\n";
}

async function toPdf(r: Report): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const { autoTable } = await import("jspdf-autotable");
  const wide = r.tables.some((t) => t.keys.length > 6);
  const doc = new jsPDF({ orientation: wide ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  let y = M;
  const ensure = (h: number) => {
    if (y + h > doc.internal.pageSize.getHeight() - M) {
      doc.addPage();
      y = M;
    }
  };
  const h2 = (t: string) => {
    ensure(40);
    doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(30);
    doc.text(t, M, (y += 22));
    y += 8;
  };
  const para = (t: string, size = 10) => {
    doc.setFont("helvetica", "normal").setFontSize(size).setTextColor(60);
    for (const line of doc.splitTextToSize(t, W - 2 * M)) {
      ensure(14);
      doc.text(line, M, (y += 13));
    }
  };
  const table = (head: string[], body: unknown[][]) => {
    autoTable(doc, {
      startY: y + 4,
      head: [head],
      body: body.map((row) => row.map((v) => cell(v, 160))),
      margin: { left: M, right: M },
      styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fillColor: [91, 76, 240] },
      alternateRowStyles: { fillColor: [246, 245, 255] },
    });
    y = (doc as any).lastAutoTable.finalY + 10;
  };

  doc.setFont("helvetica", "bold").setFontSize(20).setTextColor(20);
  doc.text(r.title, M, (y += 12));
  if (r.subtitle) para(r.subtitle, 9);
  para(`Generated ${r.generated} by Forge`, 8);
  if (r.aiSummary) {
    h2("Summary (AI-written)");
    para(r.aiSummary);
  }
  if (r.facts.length) {
    h2("Key facts");
    table(["Field", "Value"], r.facts);
  }
  if (r.highlights.length) {
    h2("Highlights");
    for (const h of r.highlights) para(`•  ${h}`);
  }
  for (const c of r.charts) {
    h2(c.title);
    const max = Math.max(...c.values, 1);
    const barW = W - 2 * M - 150;
    for (let i = 0; i < c.labels.length; i++) {
      ensure(16);
      y += 15;
      doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(60);
      doc.text(cell(c.labels[i], 26), M, y);
      doc.setFillColor(91, 76, 240).rect(M + 110, y - 8, Math.max(1, (c.values[i] / max) * barW), 10, "F");
      doc.text(fmtNum(c.values[i]), M + 115 + (c.values[i] / max) * barW, y);
    }
    y += 6;
  }
  for (const t of r.tables) {
    h2(`${t.heading}${t.total > t.rows.length ? ` (${t.rows.length} of ${t.total})` : ""}`);
    table(t.labels, t.rows.slice(0, 5000));
  }
  if (r.fields.rows.length) {
    h2(r.fields.heading);
    table(FIELD_HEAD, r.fields.rows);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

async function toDocx(r: Report): Promise<Uint8Array> {
  const d = await import("docx");
  const p = (text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}) => new d.Paragraph({ children: [new d.TextRun({ text, ...opts })], spacing: { after: 80 } });
  const table = (head: string[], rows: unknown[][]) =>
    new d.Table({
      width: { size: 100, type: d.WidthType.PERCENTAGE },
      rows: [
        new d.TableRow({
          tableHeader: true,
          children: head.map((h) => new d.TableCell({ shading: { fill: ACCENT, type: d.ShadingType.CLEAR, color: "auto" }, children: [new d.Paragraph({ children: [new d.TextRun({ text: h, bold: true, color: "FFFFFF", size: 18 })] })] })),
        }),
        ...rows.map((row) => new d.TableRow({ children: row.map((v) => new d.TableCell({ children: [new d.Paragraph({ children: [new d.TextRun({ text: cell(v, 200), size: 18 })] })] })) })),
      ],
    });
  const kids: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [
    new d.Paragraph({ text: r.title, heading: d.HeadingLevel.TITLE }),
    ...(r.subtitle ? [p(r.subtitle, { italics: true, color: "666666" })] : []),
    p(`Generated ${r.generated} by Forge`, { size: 16, color: "888888" }),
  ];
  const h = (t: string) => kids.push(new d.Paragraph({ text: t, heading: d.HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
  if (r.aiSummary) {
    h("Summary (AI-written)");
    for (const para of r.aiSummary.split(/\n{2,}/)) kids.push(p(para));
  }
  if (r.facts.length) {
    h("Key facts");
    kids.push(table(["Field", "Value"], r.facts));
  }
  if (r.highlights.length) {
    h("Highlights");
    for (const x of r.highlights) kids.push(new d.Paragraph({ text: x, bullet: { level: 0 } }));
  }
  for (const c of r.charts) {
    h(c.title);
    kids.push(table(["", "Value"], c.labels.map((l, i) => [l, c.values[i]])));
  }
  for (const t of r.tables) {
    h(`${t.heading}${t.total > Math.min(t.rows.length, 1000) ? ` (first ${Math.min(t.rows.length, 1000)} of ${t.total})` : ""}`);
    kids.push(table(t.labels, t.rows.slice(0, 1000)));
  }
  if (r.fields.rows.length) {
    h(r.fields.heading);
    kids.push(table(FIELD_HEAD, r.fields.rows));
  }
  const doc = new d.Document({ creator: "Forge by Stellitron", title: r.title, sections: [{ children: kids }] });
  return new Uint8Array(await (await d.Packer.toBlob(doc)).arrayBuffer());
}

async function toPptx(r: Report): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = r.title;
  pptx.company = "Stellitron";
  pptx.theme = { headFontFace: "Arial", bodyFontFace: "Arial" };
  const titleOpts = { x: 0.5, y: 0.3, w: 12.3, h: 0.7, fontSize: 26, bold: true, color: "1F1F2E" } as const;

  const cover = pptx.addSlide();
  cover.background = { color: "1B1830" };
  cover.addText(r.title, { x: 0.7, y: 2.4, w: 12, h: 1.2, fontSize: 40, bold: true, color: "FFFFFF" });
  if (r.subtitle) cover.addText(r.subtitle, { x: 0.7, y: 3.6, w: 12, h: 0.6, fontSize: 16, color: "B9B3FF" });
  cover.addText(`Generated ${r.generated} · Forge by Stellitron`, { x: 0.7, y: 6.6, w: 12, h: 0.4, fontSize: 11, color: "8C86C8" });

  if (r.aiSummary || r.highlights.length) {
    const s = pptx.addSlide();
    s.addText(r.aiSummary ? "Summary" : "Highlights", titleOpts);
    const bullets = (r.aiSummary ? r.aiSummary.split(/\n+/).filter(Boolean) : r.highlights).slice(0, 8);
    s.addText(
      bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
      { x: 0.6, y: 1.2, w: 12.1, h: 5.6, fontSize: 18, color: "333333", valign: "top", paraSpaceAfter: 8 },
    );
    if (r.aiSummary) s.addText("AI-written summary", { x: 0.6, y: 6.9, w: 6, h: 0.3, fontSize: 10, italic: true, color: "999999" });
  }
  if (r.facts.length) {
    const s = pptx.addSlide();
    s.addText("Key facts", titleOpts);
    r.facts.slice(0, 8).forEach(([k, v], i) => {
      const x = 0.6 + (i % 4) * 3.1;
      const y = 1.4 + Math.floor(i / 4) * 2.4;
      s.addShape("roundRect", { x, y, w: 2.9, h: 2.1, fill: { color: "F3F1FF" }, line: { color: "D9D4FF" }, rectRadius: 0.1 });
      s.addText(cell(v, 18), { x, y: y + 0.3, w: 2.9, h: 1, fontSize: 30, bold: true, color: ACCENT, align: "center" });
      s.addText(k, { x, y: y + 1.3, w: 2.9, h: 0.5, fontSize: 14, color: "555555", align: "center" });
    });
  }
  for (const c of r.charts) {
    const s = pptx.addSlide();
    s.addText(c.title, titleOpts);
    s.addChart("bar", [{ name: c.title, labels: c.labels, values: c.values }], {
      x: 0.6, y: 1.2, w: 12.1, h: 5.8, barDir: c.labels.length > 6 ? "bar" : "col", chartColors: [ACCENT], showValue: true, dataLabelFontSize: 11, catAxisLabelFontSize: 12, valAxisLabelFontSize: 11, showLegend: false,
    });
  }
  for (const t of r.tables) {
    const cols = t.labels.slice(0, 7);
    // A deck shows a readable slice; the full data belongs in the Excel/CSV export.
    const rows = t.rows.slice(0, 60).map((row) => row.slice(0, 7).map((v) => ({ text: cell(v, 40) })));
    const s = pptx.addSlide();
    s.addText(`${t.heading}${t.total > rows.length ? ` (${rows.length} of ${t.total})` : ""}`, titleOpts);
    s.addTable([cols.map((c) => ({ text: c, options: { bold: true, color: "FFFFFF", fill: { color: ACCENT } } })), ...rows], {
      x: 0.5, y: 1.15, w: 12.3, fontSize: 11, border: { type: "solid", pt: 0.5, color: "DDDDDD" }, autoPage: true, autoPageRepeatHeader: true, autoPageSlideStartY: 0.5, colW: cols.map(() => 12.3 / cols.length),
    });
  }
  return (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
}

async function toXlsx(r: Report): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Forge by Stellitron";
  const header = (ws: any) => {
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${ACCENT}` } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };
  const sum = wb.addWorksheet("Summary");
  sum.addRow([r.title]).font = { bold: true, size: 16 };
  if (r.subtitle) sum.addRow([r.subtitle]);
  sum.addRow([`Generated ${r.generated}`]);
  sum.addRow([]);
  for (const [k, v] of r.facts) sum.addRow([k, v]);
  if (r.facts.length) sum.addRow([]);
  for (const h of r.highlights) sum.addRow([h]);
  if (r.aiSummary) sum.addRow([]), sum.addRow(["Summary (AI-written)"]).font = { bold: true }, sum.addRow([r.aiSummary]);
  sum.getColumn(1).width = 60;
  sum.getColumn(2).width = 30;
  const used = new Set<string>(["Summary"]);
  for (const d of r.datasets) {
    let name = d.label.replace(/[\\/?*[\]:]/g, " ").slice(0, 28) || "Data";
    for (let i = 2; used.has(name); i++) name = `${name.slice(0, 25)} ${i}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.columns = d.columns.map((c) => ({ header: c.label, key: c.key, width: Math.min(50, Math.max(10, c.label.length + 2, ...d.rows.slice(0, 50).map((x) => String(x[c.key] ?? "").length + 2))) }));
    for (const row of d.rows) ws.addRow(d.columns.map((c) => (c.type === "date" && typeof row[c.key] === "string" ? new Date(row[c.key] as string) : (row[c.key] as any))));
    header(ws);
    if (d.columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: d.columns.length } };
  }
  if (r.fields.rows.length) {
    const ws = wb.addWorksheet("Fields");
    ws.addRow(FIELD_HEAD);
    for (const x of r.fields.rows) ws.addRow(x);
    header(ws);
    ws.columns.forEach((c, i) => (c.width = [28, 10, 8, 8, 60][i]));
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export async function render(r: Report, format: Format, datasetId?: string): Promise<Uint8Array> {
  switch (format) {
    case "pdf":
      return toPdf(r);
    case "docx":
      return toDocx(r);
    case "pptx":
      return toPptx(r);
    case "xlsx":
      return toXlsx(r);
    case "csv":
      return enc(toCsv(r.datasets.find((d) => d.id === datasetId) ?? r.datasets[0]));
    case "md":
      return enc(toMarkdown(r));
  }
}
