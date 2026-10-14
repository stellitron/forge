/**
 * Deterministic understanding of response data. Finds the tables hiding in a JSON response
 * (arrays of records, nested child lists), infers column types and computes statistics, so
 * tables, charts and reports come straight from the data. The AI only ever sees this summary,
 * never has to read (or re-type) a large body.
 */

export type ColType = "number" | "integer" | "boolean" | "date" | "url" | "email" | "string" | "list" | "object" | "empty" | "mixed";

export interface Column {
  key: string;
  label: string;
  type: ColType;
  filled: number; // rows with a value
  unique: number;
  numeric?: { min: number; max: number; mean: number; median: number; sum: number };
  dates?: { min: string; max: string };
  /** Most frequent values (for low-cardinality text/boolean columns). */
  top?: [string, number][];
}

export type Row = Record<string, unknown>;

export interface Dataset {
  id: string; // JSONPath-ish location, e.g. "$.products" or "$.products[*].reviews"
  label: string;
  rows: Row[];
  columns: Column[];
}

export interface Shape {
  datasets: Dataset[];
  /** Top-level single values such as total, page, limit. */
  facts: [string, string][];
}

const MAX_DEPTH = 6;
const FLAT_DEPTH = 3;
const ID_KEYS = /^(id|_id|uuid|key|slug|name|title|username|email|code|sku)$/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isRecordArray = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.filter(isObj).length >= v.length * 0.8;

export const humanize = (k: string) =>
  k
    .split(".")
    .map((p) =>
      p
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .trim()
        .replace(/^./, (c) => c.toUpperCase()),
    )
    .join(" › ");

/** Flattens nested objects into dot keys; lists of scalars become joined text, lists of records a count. */
function flatten(o: Record<string, unknown>, prefix = "", depth = 0, out: Row = {}): Row {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && depth < FLAT_DEPTH) flatten(v, key, depth + 1, out);
    else if (Array.isArray(v)) out[key] = v.every((x) => x === null || typeof x !== "object") ? v.join(", ") : `${v.length} item${v.length === 1 ? "" : "s"}`;
    else out[key] = isObj(v) ? JSON.stringify(v) : v;
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function typeOf(v: unknown): ColType {
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") {
    if (DATE.test(v)) return "date";
    if (/^https?:\/\/\S+$/.test(v)) return "url";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
    if (/^\d+ items?$/.test(v)) return "list";
    return "string";
  }
  return "object";
}

function describe(key: string, values: unknown[]): Column {
  const present = values.filter((v) => typeOf(v) !== "empty");
  const types = new Set(present.map(typeOf));
  if (types.has("number") && types.has("integer")) types.delete("integer");
  const type: ColType = !present.length ? "empty" : types.size === 1 ? [...types][0] : "mixed";
  const col: Column = { key, label: humanize(key), type, filled: present.length, unique: new Set(present.map((v) => String(v))).size };
  if (type === "number" || type === "integer") {
    const n = (present as number[]).slice().sort((a, b) => a - b);
    const sum = n.reduce((a, b) => a + b, 0);
    col.numeric = { min: n[0], max: n[n.length - 1], sum, mean: sum / n.length, median: n.length % 2 ? n[(n.length - 1) / 2] : (n[n.length / 2 - 1] + n[n.length / 2]) / 2 };
  } else if (type === "date") {
    const d = (present as string[]).slice().sort();
    col.dates = { min: d[0], max: d[d.length - 1] };
  }
  if ((type === "string" || type === "boolean" || type === "mixed") && col.unique <= Math.max(12, present.length * 0.5)) {
    const counts = new Map<string, number>();
    for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    col.top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }
  return col;
}

function columnsOf(rows: Row[]): Column[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, 500))
    for (const k of Object.keys(r))
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
  // Identifying columns first, then the rest in their natural order.
  keys.sort((a, b) => Number(ID_KEYS.test(b.split(".").pop()!)) - Number(ID_KEYS.test(a.split(".").pop()!)));
  return keys.map((k) => describe(k, rows.map((r) => r[k])));
}

function makeDataset(id: string, label: string, records: unknown[]): Dataset {
  const rows = records.map((r) => (isObj(r) ? flatten(r) : { value: r }));
  return { id, label, rows, columns: columnsOf(rows) };
}

/** Name of the column that best identifies a record, for linking child rows to parents. */
const idColumn = (rows: Row[]) => Object.keys(rows[0] ?? {}).find((k) => ID_KEYS.test(k)) ?? null;

export function analyze(json: unknown): Shape {
  const datasets: Dataset[] = [];
  const facts: [string, string][] = [];

  const visit = (v: unknown, path: string, label: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (isRecordArray(v)) {
      datasets.push(makeDataset(path, label, v));
      // Lists inside each record (e.g. every product's reviews) become one combined table.
      const sample = v.slice(0, 200);
      const childKeys = new Set<string>();
      for (const r of sample) for (const [k, x] of Object.entries(r)) if (isRecordArray(x)) childKeys.add(k);
      const parentId = idColumn(datasets[datasets.length - 1].rows);
      for (const k of childKeys) {
        const kids: Row[] = [];
        for (const r of v) {
          const list = r[k];
          if (!isRecordArray(list)) continue;
          for (const c of list) kids.push({ ...(parentId ? { [`${label.replace(/s$/, "")} ${parentId}`.trim()]: flatten(r)[parentId] } : {}), ...flatten(c) });
        }
        if (kids.length) datasets.push({ id: `${path}[*].${k}`, label: `${humanize(k)} (all ${label.toLowerCase()})`, rows: kids, columns: columnsOf(kids) });
      }
      return;
    }
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x === null || typeof x !== "object")) datasets.push(makeDataset(path, label, v));
      return;
    }
    if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`;
        if (depth === 0 && (x === null || typeof x !== "object")) facts.push([humanize(k), String(x)]);
        visit(x, p, humanize(k), depth + 1);
      }
    }
  };
  visit(json, "$", "Items", 0);

  // A single object with no lists: show it as a one-row record, plus a field/value table.
  if (!datasets.length && isObj(json)) {
    const flat = flatten(json);
    datasets.push({ id: "$", label: "Record", rows: [flat], columns: columnsOf([flat]) });
    datasets.push({ id: "$:fields", label: "Fields", rows: Object.entries(flat).map(([field, value]) => ({ field: humanize(field), value })), columns: [] });
    datasets[1].columns = columnsOf(datasets[1].rows);
  }
  // Top-level lists before lists nested inside them; then bigger first.
  const nesting = (d: Dataset) => (d.id.match(/\[\*\]/g) ?? []).length;
  datasets.sort((a, b) => nesting(a) - nesting(b) || b.rows.length - a.rows.length);
  return { datasets, facts };
}

// ───────────────────────── querying ─────────────────────────

export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "empty" | "notEmpty";
export interface Filter {
  column: string;
  op: Op;
  value?: string | number | boolean;
}
export interface Query {
  columns?: string[];
  where?: Filter[];
  sort?: { column: string; dir?: "asc" | "desc" }[];
  groupBy?: string;
  /** With groupBy: aggregate a numeric column (count is always included). */
  aggregate?: { column: string; fn: "sum" | "avg" | "min" | "max" };
  limit?: number;
}

const cmp = (a: unknown, b: unknown) => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
};

function test(v: unknown, f: Filter): boolean {
  const empty = v === null || v === undefined || v === "";
  switch (f.op) {
    case "empty":
      return empty;
    case "notEmpty":
      return !empty;
    case "contains":
      return String(v ?? "").toLowerCase().includes(String(f.value ?? "").toLowerCase());
    case "eq":
      return String(v) === String(f.value);
    case "neq":
      return String(v) !== String(f.value);
    default: {
      const a = typeof v === "number" ? v : Number(v);
      const b = Number(f.value);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return f.op === "gt" ? a > b : f.op === "gte" ? a >= b : f.op === "lt" ? a < b : a <= b;
    }
  }
}

/** Filter, sort, group and project a dataset's rows. Pure and deterministic. */
export function query(ds: Dataset, q: Query = {}): { columns: string[]; rows: Row[]; total: number } {
  let rows = ds.rows.filter((r) => (q.where ?? []).every((f) => test(r[f.column], f)));
  if (q.groupBy) {
    const g = new Map<string, Row[]>();
    for (const r of rows) {
      const k = String(r[q.groupBy] ?? "(empty)");
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    const agg = q.aggregate;
    const label = agg ? `${agg.fn} of ${agg.column}` : "";
    rows = [...g.entries()].map(([k, rs]) => {
      const out: Row = { [q.groupBy!]: k, count: rs.length };
      if (agg) {
        const n = rs.map((r) => Number(r[agg.column])).filter((x) => !Number.isNaN(x));
        out[label] = !n.length ? null : agg.fn === "sum" ? n.reduce((a, b) => a + b, 0) : agg.fn === "avg" ? n.reduce((a, b) => a + b, 0) / n.length : agg.fn === "min" ? Math.min(...n) : Math.max(...n);
      }
      return out;
    });
    if (!q.sort?.length) rows.sort((a, b) => (b.count as number) - (a.count as number));
  }
  for (const s of [...(q.sort ?? [])].reverse()) rows = [...rows].sort((a, b) => cmp(a[s.column], b[s.column]) * (s.dir === "desc" ? -1 : 1));
  const total = rows.length;
  const columns = q.groupBy ? Object.keys(rows[0] ?? { [q.groupBy]: 0, count: 0 }) : q.columns?.length ? q.columns : ds.columns.map((c) => c.key);
  if (q.limit) rows = rows.slice(0, q.limit);
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))), total };
}

// ───────────────────────── presentation helpers ─────────────────────────

export const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function cell(v: unknown, max = 120): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return fmtNum(v);
  const s = String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Columns worth showing when space is tight: identifiers, then well-filled short columns. */
export function pickColumns(ds: Dataset, max: number): string[] {
  const n = ds.rows.length || 1;
  const score = (c: Column) =>
    (ID_KEYS.test(c.key.split(".").pop()!) ? 100 : 0) +
    (c.filled / n) * 40 +
    (["number", "integer", "date", "boolean"].includes(c.type) ? 15 : 0) +
    (c.top ? 10 : 0) -
    (c.type === "url" || c.type === "object" ? 30 : 0) -
    c.key.split(".").length * 3;
  const chosen = new Set([...ds.columns].sort((a, b) => score(b) - score(a)).slice(0, max).map((c) => c.key));
  return ds.columns.filter((c) => chosen.has(c.key)).map((c) => c.key);
}

/** Plain-language highlights computed from the statistics (no AI). */
export function highlights(ds: Dataset): string[] {
  const out = [`${fmtNum(ds.rows.length)} ${ds.label.toLowerCase()} with ${ds.columns.length} fields.`];
  for (const c of ds.columns) {
    if (out.length >= 7) break;
    if (c.numeric && c.unique > 1 && !ID_KEYS.test(c.key))
      out.push(`${c.label}: ${fmtNum(c.numeric.min)} to ${fmtNum(c.numeric.max)}, average ${fmtNum(c.numeric.mean)}${c.numeric.sum && /price|amount|total|qty|quantity|stock|count|revenue|cost/i.test(c.key) ? `, total ${fmtNum(c.numeric.sum)}` : ""}.`);
    else if (c.top && c.unique > 1 && c.unique < c.filled && c.unique <= 20 && c.type !== "boolean")
      out.push(`${c.label}: ${c.unique} distinct; most common ${c.top.slice(0, 3).map(([v, n]) => `${v} (${n})`).join(", ")}.`);
    else if (c.type === "boolean" && c.top) out.push(`${c.label}: ${c.top.map(([v, n]) => `${v} ${n}`).join(", ")}.`);
    else if (c.dates) out.push(`${c.label}: from ${c.dates.min.slice(0, 10)} to ${c.dates.max.slice(0, 10)}.`);
  }
  const sparse = ds.columns.filter((c) => c.filled < ds.rows.length * 0.5 && c.type !== "empty");
  if (sparse.length) out.push(`Often missing: ${sparse.slice(0, 4).map((c) => c.label).join(", ")}.`);
  return out;
}

/** Compact, size-bounded description for an LLM: structure and stats, a few sample rows. */
export function describeShape(shape: Shape, samples = 3): string {
  const lines: string[] = [];
  if (shape.facts.length) lines.push(`Top-level values: ${shape.facts.map(([k, v]) => `${k}=${v.slice(0, 60)}`).join(", ")}`);
  for (const d of shape.datasets.slice(0, 8)) {
    lines.push(`\nDataset "${d.label}" at ${d.id}: ${d.rows.length} rows`);
    for (const c of d.columns.slice(0, 40)) {
      const extra = c.numeric
        ? ` min ${fmtNum(c.numeric.min)} max ${fmtNum(c.numeric.max)} avg ${fmtNum(c.numeric.mean)}`
        : c.dates
          ? ` ${c.dates.min} → ${c.dates.max}`
          : c.top
            ? ` top: ${c.top.slice(0, 5).map(([v, n]) => `${v.slice(0, 30)}(${n})`).join(", ")}`
            : "";
      lines.push(`  - ${c.key} [${c.type}] filled ${c.filled}/${d.rows.length}, ${c.unique} unique${extra}`);
    }
    if (d.columns.length > 40) lines.push(`  … ${d.columns.length - 40} more columns`);
    for (const r of d.rows.slice(0, samples)) lines.push(`  sample: ${JSON.stringify(r).slice(0, 400)}`);
  }
  return lines.join("\n");
}
