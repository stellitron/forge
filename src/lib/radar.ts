import type { Imported } from "./importers";
import { setBody, type ImportResult } from "./importAny";
import { defaults, kv, type HttpItem } from "./types";

/**
 * Website radar, the browser-free part: turns raw captured network calls into endpoints
 * (one per method + URL template), and selected endpoints into importable requests.
 */

export interface Capture {
  /** DevTools session + request id. */
  id: string;
  method: string;
  url: string;
  /** DevTools resource type: XHR, Fetch, EventSource, Other… */
  type: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  status?: number;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  failed?: string;
  /** Stopped by Forge while the agent explored without permission to change data. */
  blocked?: boolean;
  /** Page that made the call. */
  page: string;
  ts: number;
  byAgent?: boolean;
}

export interface Endpoint {
  key: string;
  method: string;
  origin: string;
  /** Path with ids replaced by `:name` parameters. */
  path: string;
  /** GraphQL operation name, when the call is one. */
  op?: string;
  count: number;
  /** Most recent captures, newest last (a few, for samples). */
  samples: Capture[];
  firstParty: boolean;
  /** Analytics, monitoring and similar calls nobody wants as requests. */
  noise: boolean;
}

const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|pdf)$/i;
const API_TYPES = new Set(["XHR", "Fetch", "EventSource"]);

/** Whether a capture is an API call worth listing (not a page load, asset or preflight). */
export function isApi(c: Capture): boolean {
  if (!/^https?:/.test(c.url)) return false;
  let path = "";
  try {
    path = new URL(c.url).pathname;
  } catch {
    return false;
  }
  if (STATIC.test(path) || c.method === "OPTIONS") return false;
  if (API_TYPES.has(c.type)) return true;
  // fetch() from a service worker and some libraries show up as "Other".
  return c.type === "Other" && (c.method !== "GET" || /json|xml|graphql|text\/plain|event-stream/i.test(c.mimeType ?? ""));
}

const TWO_PART_SUFFIX = /^(co|com|net|org|gov|edu|ac|ne|or|go)$/;

/** Approximate registrable domain ("app.acme.co.uk" → "acme.co.uk"), so api.acme.com counts as first-party for app.acme.com. */
export function siteOf(host: string): string {
  const h = host.replace(/:\d+$/, "").toLowerCase();
  if (/^[\d.]+$/.test(h) || !h.includes(".")) return h;
  const parts = h.split(".");
  const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && TWO_PART_SUFFIX.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join(".");
}

const NOISE_HOST =
  /(google-analytics|googletagmanager|analytics\.google|doubleclick|googlesyndication|googleadservices|facebook\.(com|net)|connect\.facebook|segment\.(io|com)|sentry\.io|ingest\.sentry|hotjar|mixpanel|amplitude|fullstory|clarity\.ms|newrelic|nr-data|datadoghq|browser-intake|bugsnag|cloudflareinsights|posthog|heapanalytics|rudderstack|logrocket|intercom|hubspot|linkedin\.com\/px|ads\.|pixel\.|stats\.|telemetry\.)/i;
const NOISE_PATH = /(^|\/)(collect|track|tracking|beacon|rum|telemetry|analytics|metrics|log|logs|ping|pixel|heartbeat|v1\/(t|i|p))(\/|$)/i;

export function isNoise(url: URL): boolean {
  return NOISE_HOST.test(url.host + url.pathname) || NOISE_PATH.test(url.pathname);
}

const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,}|[0-9A-HJKMNP-TV-Z]{26})$/i;

const singular = (w: string) => (/ies$/i.test(w) ? w.slice(0, -3) + "y" : /(ss|us)$/i.test(w) ? w : /s$/i.test(w) ? w.slice(0, -1) : w);
const camel = (w: string) => w.toLowerCase().replace(/[-_.]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** "/users/42/posts/9f1c…" → { path: "/users/:userId/posts/:postId", values: { userId: "42", postId: "9f1c…" } }. */
export function templatePath(pathname: string): { path: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const segs = pathname.split("/").map((seg, i, all) => {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      /* keep as is */
    }
    if (!ID_SEGMENT.test(decoded)) return seg;
    const prev = all[i - 1];
    let name = prev && !ID_SEGMENT.test(prev) && /^[A-Za-z][\w.-]*$/.test(prev) ? `${camel(singular(prev))}Id` : "id";
    for (let n = 2; name in values; n++) name = `${name.replace(/\d+$/, "")}${n}`;
    values[name] = decoded;
    return `:${name}`;
  });
  return { path: segs.join("/") || "/", values };
}

/** GraphQL operation name, from the body or the query string. */
export function graphqlOp(c: Capture): string | undefined {
  const fromQuery = (q: string) => /\b(query|mutation|subscription)\s+([A-Za-z_]\w*)/.exec(q)?.[2];
  try {
    const u = new URL(c.url);
    if (u.searchParams.get("operationName")) return u.searchParams.get("operationName")!;
    if (u.searchParams.get("query")) return fromQuery(u.searchParams.get("query")!) ?? "query";
  } catch {
    /* not a URL */
  }
  if (!c.postData) return undefined;
  try {
    const j = JSON.parse(c.postData);
    const one = Array.isArray(j) ? j[0] : j;
    if (one && typeof one.query === "string") return one.operationName || fromQuery(one.query) || "query";
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Groups API captures into endpoints, most used first within each origin. */
export function toEndpoints(captures: Capture[], startUrl: string): Endpoint[] {
  let site = "";
  try {
    site = siteOf(new URL(startUrl).host);
  } catch {
    /* compared against nothing */
  }
  const map = new Map<string, Endpoint>();
  for (const c of captures) {
    if (!isApi(c)) continue;
    const u = new URL(c.url);
    const { path } = templatePath(u.pathname);
    const op = graphqlOp(c);
    const key = `${c.method} ${u.origin}${path}${op ? ` ${op}` : ""}`;
    let ep = map.get(key);
    if (!ep) {
      ep = { key, method: c.method, origin: u.origin, path, op, count: 0, samples: [], firstParty: siteOf(u.host) === site, noise: isNoise(u) };
      map.set(key, ep);
    }
    ep.count++;
    ep.samples.push(c);
    if (ep.samples.length > 5) ep.samples.shift();
  }
  return [...map.values()].sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || a.origin.localeCompare(b.origin) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** The sample to build a request from: the latest successful one, else the latest. */
export function bestSample(ep: Endpoint): Capture {
  return [...ep.samples].reverse().find((c) => c.status && c.status < 400) ?? ep.samples[ep.samples.length - 1];
}

/** Headers the browser or the client computes itself, or that only make sense for this one page view. */
const DROP_HEADER =
  /^(:|host$|content-length$|connection$|accept-encoding$|accept-language$|user-agent$|sec-|referer$|origin$|priority$|dnt$|pragma$|cache-control$|upgrade-insecure-requests$|if-none-match$|if-modified-since$|purpose$|x-client-data$|traceparent$|tracestate$|baggage$|sentry-trace$|x-datadog-|x-b3-|newrelic$)/i;
const SECRET_HEADER = /(token|secret|api[-_]?key|apikey|auth|session|csrf|xsrf|signature|credential|password|jwt)/i;

const varName = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Short, readable fallback name, e.g. "GET /users/:userId" or "GetViewer (GraphQL)". */
export function defaultName(ep: Endpoint): string {
  if (ep.op && ep.op !== "query") return `${ep.op}`;
  return `${ep.method} ${ep.path}`.slice(0, 80);
}

/** First meaningful path segment ("/api/v2/orders/:id" → "orders"), used as the folder when nothing better is known. */
export function defaultFolder(path: string): string {
  const segs = path.split("/").filter((s) => s && !s.startsWith(":") && !/^(api|rest|v\d+(\.\d+)?|public|internal|graphql|gql)$/i.test(s));
  return segs[0] ?? "";
}

export interface Organized {
  name?: string;
  folder?: string;
}

export interface RadarImport {
  result: ImportResult;
  /** Values for {{placeholders}} used in the requests (tokens, cookies); stored as environment secrets. */
  secrets: Record<string, string>;
  baseUrl?: string;
}

/**
 * Builds a collection from the chosen endpoints. The busiest first-party origin becomes {{baseUrl}};
 * tokens, cookies and other credential headers become {{placeholders}} whose values go to secrets.
 */
export function toImport(endpoints: Endpoint[], opts: { name: string; startUrl: string; organized?: Record<string, Organized>; when?: Date }): RadarImport {
  const secrets: Record<string, string> = {};
  const byValue = new Map<string, string>();
  const secret = (name: string, value: string) => {
    const known = byValue.get(value);
    if (known) return `{{${known}}}`;
    let key = name;
    for (let i = 2; key in secrets; i++) key = `${name}${i}`;
    secrets[key] = value;
    byValue.set(value, key);
    return `{{${key}}}`;
  };

  const counts = new Map<string, number>();
  for (const ep of endpoints) if (ep.firstParty) counts.set(ep.origin, (counts.get(ep.origin) ?? 0) + ep.count);
  const baseUrl = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const when = (opts.when ?? new Date()).toISOString().slice(0, 10);

  const items: Imported[] = [];
  for (const ep of endpoints) {
    const c = bestSample(ep);
    const u = new URL(c.url);
    const { values } = templatePath(u.pathname);
    const d: HttpItem = defaults.http();
    d.method = ep.method;
    d.url = `${ep.origin === baseUrl ? "{{baseUrl}}" : ep.origin}${ep.path}`;
    d.pathVars = Object.entries(values).map(([k, v]) => kv(k, v));
    d.params = Array.from(u.searchParams).map(([k, v]) => kv(k, v));
    for (const [key, value] of Object.entries(c.requestHeaders)) {
      if (DROP_HEADER.test(key)) continue;
      const lower = key.toLowerCase();
      const bearer = lower === "authorization" && /^bearer\s+(\S+)/i.exec(value);
      if (bearer) d.auth = { type: "bearer", token: secret("token", bearer[1]) };
      else if (lower === "cookie") d.headers.push(kv("Cookie", secret("cookie", value)));
      else if (SECRET_HEADER.test(lower)) d.headers.push(kv(key, secret(varName(key), value)));
      else d.headers.push(kv(key, value));
    }
    if (c.postData != null) {
      const mime = (c.requestHeaders["content-type"] ?? c.requestHeaders["Content-Type"] ?? "").split(";")[0].trim();
      d.headers = d.headers.filter((h) => h.key.toLowerCase() !== "content-type");
      let gql: any = null;
      try {
        const j = JSON.parse(c.postData);
        if (ep.op && j && !Array.isArray(j) && typeof j.query === "string") gql = j;
      } catch {
        /* not JSON */
      }
      if (gql) {
        d.bodyMode = "graphql";
        d.graphql = { query: gql.query, variables: JSON.stringify(gql.variables ?? {}, null, 2) };
      } else if (/x-www-form-urlencoded/.test(mime)) {
        d.bodyMode = "form";
        d.form = Array.from(new URLSearchParams(c.postData)).map(([k, v]) => kv(k, v));
      } else {
        let text = c.postData;
        try {
          if (/json/.test(mime) || /^\s*[[{]/.test(text)) text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* keep as sent */
        }
        setBody(d, mime, text);
      }
    }
    const seen = ep.count === 1 ? "once" : `${ep.count} times`;
    d.description = `Captured by Website radar on ${when} from ${c.page || opts.startUrl}, seen ${seen}${c.status ? ` (last status ${c.status})` : ""}.`;
    const o = opts.organized?.[ep.key];
    const folder = o?.folder ?? (ep.origin === baseUrl ? defaultFolder(ep.path) : new URL(ep.origin).host);
    items.push({ name: (o?.name || defaultName(ep)).slice(0, 80), folder, data: d });
  }
  return {
    result: { collections: [{ name: opts.name, format: "Website radar", items }], envs: [], baseUrl, skipped: [] },
    secrets,
    baseUrl,
  };
}

/** One line per endpoint for the model: shapes and field names only, never values, headers or cookies. */
export function describeForAi(endpoints: Endpoint[]): string {
  const keys = (text?: string) => {
    if (!text) return "";
    try {
      const j = JSON.parse(text);
      const o = Array.isArray(j) ? j[0] : j;
      const ks = o && typeof o === "object" ? Object.keys(o).slice(0, 12) : [];
      return ks.length ? `${Array.isArray(j) ? "[" : "{"}${ks.join(",")}${Array.isArray(j) ? "]" : "}"}` : "";
    } catch {
      return "";
    }
  };
  return endpoints
    .map((ep, i) => {
      const c = bestSample(ep);
      const q = (() => {
        try {
          return [...new URL(c.url).searchParams.keys()].join(",");
        } catch {
          return "";
        }
      })();
      const parts = [`e${i}`, ep.method, `${ep.firstParty ? "" : new URL(ep.origin).host}${ep.path}`];
      if (ep.op) parts.push(`graphql:${ep.op}`);
      if (q) parts.push(`query:${q}`);
      const body = keys(c.postData);
      if (body) parts.push(`body:${body}`);
      if (c.status) parts.push(`→${c.status}`);
      const res = keys(c.responseBody);
      if (res) parts.push(res);
      parts.push(`×${ep.count}`);
      return parts.join(" ");
    })
    .join("\n");
}
