import type { Assertion, AssertionResult, Extraction, HttpResponse, KV } from "./types";

/** Replaces {{var}} with environment values and {{$dynamic}} with generated ones. */
export function interpolate(input: string, vars: Record<string, string>): string {
  if (!input || !input.includes("{{")) return input;
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, name: string) => {
    switch (name) {
      case "$uuid":
        return crypto.randomUUID();
      case "$timestamp":
        return String(Math.floor(Date.now() / 1000));
      case "$isoTimestamp":
        return new Date().toISOString();
      case "$randomInt":
        return String(Math.floor(Math.random() * 1000));
      case "$randomEmail":
        return `user${Math.floor(Math.random() * 1e6)}@example.com`;
    }
    return name in vars ? vars[name] : match;
  });
}

export const varsOf = (list: KV[]): Record<string, string> =>
  Object.fromEntries(list.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value]));

/** Small JSONPath subset: $.a.b[0]["c d"].e, a.b.0, $..name is not supported. */
export function jsonPath(data: unknown, path: string): unknown {
  const p = path.trim().replace(/^\$\.?/, "");
  if (!p) return data;
  const parts: string[] = [];
  const re = /([^.[\]]+)|\[(\d+|"[^"]*"|'[^']*'|\*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) parts.push((m[1] ?? m[2]).replace(/^["']|["']$/g, ""));
  let cur: any = data;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (part === "length" && Array.isArray(cur)) cur = cur.length;
    else if (part === "*" && Array.isArray(cur)) continue;
    else cur = cur[part];
  }
  return cur;
}

export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const show = (v: unknown) =>
  v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v);

function actualOf(a: Assertion, res: HttpResponse, json: unknown): unknown {
  switch (a.source) {
    case "status":
      return res.status;
    case "time":
      return Math.round(res.timeMs);
    case "size":
      return res.size;
    case "body":
      return res.body;
    case "header":
      return res.headers.find((h) => h.key.toLowerCase() === a.path.trim().toLowerCase())?.value;
    case "jsonpath":
      return jsonPath(json, a.path);
  }
}

/**
 * Checks a response. `{{variables}}` in paths and expected values are filled in, so a data-driven
 * run can expect `{{sku}}`. Labels keep the placeholders, so values (which may be secrets) aren't shown.
 */
export function runAssertions(list: Assertion[], res: HttpResponse, vars: Record<string, string> = {}): AssertionResult[] {
  const json = tryJson(res.body);
  return list
    .filter((a) => a.enabled)
    .map((original) => {
      const a = { ...original, path: interpolate(original.path, vars) };
      const actual = actualOf(a, res, json);
      const s = show(actual);
      const num = Number(actual);
      const want = interpolate(original.value, vars);
      let pass = false;
      switch (a.op) {
        case "eq":
          pass = s === want || (typeof actual === "number" && num === Number(want));
          break;
        case "neq":
          pass = s !== want;
          break;
        case "contains":
          pass = s.includes(want);
          break;
        case "notContains":
          pass = !s.includes(want);
          break;
        case "gt":
          pass = num > Number(want);
          break;
        case "lt":
          pass = num < Number(want);
          break;
        case "exists":
          pass = actual !== undefined && actual !== null;
          break;
        case "notExists":
          pass = actual === undefined || actual === null;
          break;
        case "matches":
          try {
            pass = new RegExp(want).test(s);
          } catch {
            pass = false;
          }
          break;
      }
      const target = original.source === "header" || original.source === "jsonpath" ? `${original.source} ${original.path}` : original.source;
      const needsValue = a.op !== "exists" && a.op !== "notExists";
      return { label: `${target} ${a.op}${needsValue ? ` ${original.value}` : ""}`, pass, actual: s.slice(0, 200) };
    });
}

export function runExtractions(list: Extraction[], res: HttpResponse): Record<string, string> {
  const json = tryJson(res.body);
  const out: Record<string, string> = {};
  for (const x of list) {
    if (!x.enabled || !x.variable) continue;
    const v =
      x.source === "header"
        ? res.headers.find((h) => h.key.toLowerCase() === x.path.toLowerCase())?.value
        : jsonPath(json, x.path);
    if (v !== undefined) out[x.variable] = show(v);
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function prettyBody(body: string, contentType = ""): string {
  if (/json/i.test(contentType) || /^\s*[[{]/.test(body)) {
    const j = tryJson(body);
    if (j !== undefined) return JSON.stringify(j, null, 2);
  }
  return body;
}

/** Incremental SSE parser for streamed chunks. */
export class SseParser {
  private buf = "";
  feed(chunk: string): { event?: string; data: string; id?: string }[] {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const out: { event?: string; data: string; id?: string }[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const ev: { event?: string; data: string; id?: string } = { data: "" };
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const c = line.indexOf(":");
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "event") ev.event = value;
        else if (field === "id") ev.id = value;
      }
      ev.data = data.join("\n");
      if (data.length || ev.event) out.push(ev);
    }
    return out;
  }
}
