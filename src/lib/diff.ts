/**
 * Differences between two responses: a structural diff for JSON (what changed, at which path)
 * and a line diff (Myers) for everything else.
 */

export interface JsonChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);

/** Changes from `a` to `b`, as JSONPath-like paths. Arrays compare by index. Stops at `limit`. */
export function jsonDiff(a: unknown, b: unknown, limit = 500): { changes: JsonChange[]; more: boolean } {
  const changes: JsonChange[] = [];
  let more = false;
  const walk = (x: unknown, y: unknown, path: string) => {
    if (changes.length >= limit) return void (more = true);
    if (Object.is(x, y)) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (i >= y.length) changes.push({ path: `${path}[${i}]`, kind: "removed", before: x[i] });
        else if (i >= x.length) changes.push({ path: `${path}[${i}]`, kind: "added", after: y[i] });
        else walk(x[i], y[i], `${path}[${i}]`);
        if (changes.length >= limit) return void (more = true);
      }
      return;
    }
    if (isObj(x) && isObj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (!(k in y)) changes.push({ path: path + key(k), kind: "removed", before: x[k] });
        else if (!(k in x)) changes.push({ path: path + key(k), kind: "added", after: y[k] });
        else walk(x[k], y[k], path + key(k));
        if (changes.length >= limit) return void (more = true);
      }
      return;
    }
    changes.push({ path, kind: "changed", before: x, after: y });
  };
  walk(a, b, "$");
  return { changes, more };
}

export type LineOp = { op: "same" | "add" | "del"; text: string };

/** Myers' O((N+M)·D) diff. Gives up (returns null) past `maxD` edits, for huge rewrites. */
export function lineDiff(a: string[], b: string[], maxD = 4000): LineOp[] | null {
  // Trim the common prefix and suffix first: most responses differ in a few places.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;
  // Walk the trace backwards to recover the edit script.
  const ops: LineOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ op: "same", text: A[--x] }), y--;
    if (d > 0) {
      if (x === prevX) ops.push({ op: "add", text: B[--y] });
      else ops.push({ op: "del", text: A[--x] });
    }
  }
  while (x > 0 && y > 0) ops.push({ op: "same", text: A[--x] }), y--;
  ops.reverse();
  return [...a.slice(0, start).map((text) => ({ op: "same" as const, text })), ...ops, ...a.slice(endA).map((text) => ({ op: "same" as const, text }))];
}

/** Unified hunks: changed lines with `context` lines around them; long unchanged runs collapse. */
export function hunks(ops: LineOp[], context = 3): (LineOp | { op: "skip"; count: number })[] {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op !== "same") for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  const out: (LineOp | { op: "skip"; count: number })[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) out.push(ops[i]);
    else {
      let j = i;
      while (j < ops.length && !keep[j]) j++;
      out.push({ op: "skip", count: j - i });
      i = j - 1;
    }
  }
  return out;
}

/** Headers that change on every response and only add noise to a comparison. */
export const VOLATILE_HEADER = /^(date|age|expires|last-modified|etag|x-request-id|x-correlation-id|x-amzn-requestid|x-amzn-trace-id|x-amz-cf-id|cf-ray|traceparent|x-trace-id|server-timing|x-runtime|x-response-time|report-to|nel)$/i;

export function headerDiff(a: { key: string; value: string }[], b: { key: string; value: string }[], ignoreVolatile = true): JsonChange[] {
  const map = (list: { key: string; value: string }[]) => {
    const m = new Map<string, string>();
    for (const h of list) if (!(ignoreVolatile && VOLATILE_HEADER.test(h.key))) m.set(h.key.toLowerCase(), m.has(h.key.toLowerCase()) ? `${m.get(h.key.toLowerCase())}, ${h.value}` : h.value);
    return m;
  };
  const x = map(a);
  const y = map(b);
  const out: JsonChange[] = [];
  for (const k of [...new Set([...x.keys(), ...y.keys()])].sort()) {
    if (!y.has(k)) out.push({ path: k, kind: "removed", before: x.get(k) });
    else if (!x.has(k)) out.push({ path: k, kind: "added", after: y.get(k) });
    else if (x.get(k) !== y.get(k)) out.push({ path: k, kind: "changed", before: x.get(k), after: y.get(k) });
  }
  return out;
}
