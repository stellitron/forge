import { http, uid, type RawBody, type RawRequest } from "./ipc";
import { interpolate } from "./eval";
import { applyPathVars, encodeQueryPart, parseQuery, splitUrl } from "./urlParams";
import type { HttpItem, HttpResponse, KV } from "./types";

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

/** Resolves an HTTP item against variables into what the Rust engine sends. */
export function buildRequest(item: HttpItem, vars: Record<string, string>): RawRequest {
  const v = (s: string) => interpolate(s, vars);
  const on = (list: KV[]) => list.filter((x) => x.enabled && x.key).map((x) => ({ ...x, key: v(x.key), value: v(x.value) }));

  // Path variables first (their values are encoded), then {{vars}}.
  const { base, query, hash } = splitUrl(applyPathVars(item.url.trim(), item.pathVars, v));
  let url = v(base);
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  // The URL's own query already holds the params kept in sync with it; only add rows it lacks
  // (older items and imports keep params only in the table).
  const id = (p: KV) => `${p.key}=${p.value}`;
  const fromUrl = parseQuery(query ?? "").filter((p) => p.key || p.value);
  const inUrl = new Set(fromUrl.map(id));
  const params: KV[] = [...fromUrl, ...item.params.filter((p) => p.enabled && p.key && !inUrl.has(id(p)))];
  const headers = on(item.headers);

  const auth = item.auth;
  if (auth.type === "bearer" && auth.token) headers.push({ key: "Authorization", value: `Bearer ${v(auth.token)}`, enabled: true });
  if (auth.type === "basic") headers.push({ key: "Authorization", value: `Basic ${b64(`${v(auth.username)}:${v(auth.password)}`)}`, enabled: true });
  if (auth.type === "apikey" && auth.key) {
    if (auth.in === "header") headers.push({ key: v(auth.key), value: v(auth.value), enabled: true });
    // Fully encoded up front (a key often contains + or /); encoding below leaves it unchanged.
    else params.push({ key: encodeURIComponent(v(auth.key)), value: encodeURIComponent(v(auth.value)), enabled: true });
  }

  if (params.length) {
    // Typed text keeps its + and escapes as written; a variable's value is fully encoded, so a
    // token like "ab+c/d==" or a value containing & arrives intact. A lone {{var}} with no "="
    // is inserted as is, for variables that hold a whole query string.
    const enc = Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, encodeURIComponent(x)]));
    const part = (s: string, isKey = false) => encodeQueryPart(interpolate(s, enc), isKey);
    const qs = params
      .map((p) => (p.value === "" ? (/^\{\{[^}]+\}\}$/.test(p.key.trim()) ? v(p.key) : part(p.key, true)) : `${part(p.key, true)}=${part(p.value)}`))
      .join("&");
    url += `?${qs}`;
  }
  url += hash;

  const hasHeader = (name: string) => headers.some((h) => h.key.toLowerCase() === name.toLowerCase());
  const setType = (t: string) => !hasHeader("content-type") && headers.push({ key: "Content-Type", value: t, enabled: true });

  let body: RawBody = { type: "none" };
  switch (item.bodyMode) {
    case "json":
      setType("application/json");
      body = { type: "raw", content: v(item.body) };
      break;
    case "xml":
      setType("application/xml");
      body = { type: "raw", content: v(item.body) };
      break;
    case "text":
      setType("text/plain");
      body = { type: "raw", content: v(item.body) };
      break;
    case "graphql": {
      setType("application/json");
      let variables: unknown = {};
      try {
        variables = JSON.parse(v(item.graphql.variables) || "{}");
      } catch {
        /* sent as-is below would be invalid; keep empty */
      }
      body = { type: "raw", content: JSON.stringify({ query: v(item.graphql.query), variables }) };
      break;
    }
    case "form":
      body = { type: "form", fields: on(item.form) };
      break;
    case "multipart":
      body = { type: "multipart", fields: item.multipart.filter((f) => f.enabled && f.key).map((f) => ({ ...f, value: v(f.value) })) };
      break;
    case "binary":
      body = { type: "binary", path: v(item.body) };
      break;
  }

  return {
    method: item.bodyMode === "graphql" && item.method === "GET" ? "POST" : item.method,
    url,
    headers,
    body,
    timeoutMs: item.settings.timeoutMs,
    followRedirects: item.settings.followRedirects,
    insecure: item.settings.insecure,
  };
}

/** Quick JSON request used by the agent and protocol panels. */
export async function sendJson(
  method: string,
  url: string,
  body: unknown,
  headers: KV[] = [],
  source = "app",
): Promise<HttpResponse> {
  const h = [...headers];
  if (body !== undefined && !h.some((x) => x.key.toLowerCase() === "content-type"))
    h.push({ key: "Content-Type", value: "application/json", enabled: true });
  return http.send(uid(), {
    method,
    url,
    headers: h,
    body: body === undefined ? { type: "none" } : { type: "raw", content: JSON.stringify(body) },
    timeoutMs: 120000,
  }, source);
}

export function toCurl(req: RawRequest): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${req.method} ${q(req.url)}`];
  for (const h of req.headers) parts.push(`-H ${q(`${h.key}: ${h.value}`)}`);
  const b = req.body;
  if (b?.type === "raw") parts.push(`--data-raw ${q(b.content)}`);
  if (b?.type === "form") for (const f of b.fields) parts.push(`--data-urlencode ${q(`${f.key}=${f.value}`)}`);
  if (b?.type === "multipart") for (const f of b.fields) parts.push(`-F ${q(`${f.key}=${f.file ? "@" : ""}${f.value}`)}`);
  if (b?.type === "binary") parts.push(`--data-binary @${q(b.path)}`);
  return parts.join(" \\\n  ");
}
