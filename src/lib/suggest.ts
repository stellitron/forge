import { tryJson } from "./eval";
import type { Assertion, HttpResponse } from "./types";

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `["${k}"]`);

/**
 * Proposes assertions that pin down the response you just got: status, content type,
 * a generous time budget, and the presence of the JSON fields that came back.
 */
export function suggestAssertions(res: HttpResponse, existing: Assertion[]): Assertion[] {
  const out: Assertion[] = [];
  const a = (source: Assertion["source"], op: Assertion["op"], value = "", path = "") => out.push({ enabled: true, source, path, op, value });

  a("status", "eq", String(res.status));
  const ctype = res.headers.find((h) => h.key.toLowerCase() === "content-type")?.value.split(";")[0].trim();
  if (ctype) a("header", "contains", ctype, "content-type");
  // Leave headroom so normal jitter doesn't fail the test.
  a("time", "lt", String(Math.max(500, Math.ceil((res.timeMs * 3) / 100) * 100)));

  const json = tryJson(res.body);
  if (json !== undefined && !res.bodyBase64) {
    const visit = (v: unknown, path: string, depth: number) => {
      if (out.length > 14 || depth > 2) return;
      if (Array.isArray(v)) {
        if (path === "$") a("jsonpath", v.length ? "gt" : "eq", "0", "$.length");
        if (v.length && typeof v[0] === "object" && v[0] !== null) visit(v[0], `${path}[0]`, depth + 1);
        return;
      }
      if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          if (out.length > 14) return;
          const p = `${path}${key(k)}`;
          a("jsonpath", "exists", "", p);
          // Pin stable scalars at the top level (ids and timestamps change, so skip those).
          if (depth === 0 && typeOf(child) !== "object" && typeOf(child) !== "array" && !/id$|_at$|At$|time|date|token/i.test(k) && String(child).length < 60)
            a("jsonpath", "eq", String(child), p);
          if (typeof child === "object" && child !== null) visit(child, p, depth + 1);
        }
      }
    };
    visit(json, "$", 0);
  }

  const sig = (x: Assertion) => `${x.source}|${x.path}|${x.op}`;
  const have = new Set(existing.map(sig));
  return out.filter((x) => !have.has(sig(x)));
}
