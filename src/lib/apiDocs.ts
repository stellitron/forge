import { effectiveItem, folderVars } from "./inherit";
import { defaultExample, exampleAsResponse } from "./examples";
import { generate, LANGUAGES, type LangId } from "./codegen";
import { buildRequest } from "./request";
import { openApiLocation, type ExportInput } from "./exportCollection";
import { displayUrl, parseQuery, splitUrl } from "./urlParams";
import type { RawRequest } from "./ipc";
import { HIDDEN, SECRET_KEY, redact, redactText, type ExampleMode } from "./redact";
import type { Assertion, Auth, HttpItem, HttpResponse, Item } from "./types";

/**
 * API documentation built from the requests themselves: endpoints, parameters, auth, bodies,
 * response examples and field types from the last run, tests as documented behaviour, and code
 * samples. No AI here; descriptions come from each request's Docs tab (which the AI can draft).
 */

/**
 * How response examples from the last run appear. "sample" replaces personal data (names, emails,
 * phones, addresses, locations, ID numbers) with fake values of the same shape; "real" keeps it.
 * Secrets are hidden in both.
 */
export type { ExampleMode } from "./redact";
export { redact } from "./redact";

export interface DocOptions {
  title: string;
  intro: string;
  examples: ExampleMode;
  samples: LangId[];
}

export interface Field {
  path: string;
  type: string;
  example: string;
}

export interface DocParam {
  name: string;
  in: "path" | "query" | "header";
  example: string;
  required: boolean;
}

export interface DocEndpoint {
  id: string;
  /** The request file this endpoint comes from. */
  source: string;
  folder: string;
  name: string;
  method: string;
  path: string;
  description: string;
  auth: string;
  params: DocParam[];
  body?: { type: string; example: string; fields: Field[] };
  response?: { status: number; statusText: string; type: string; example: string; fields: Field[] };
  tests: string[];
  samples: { label: string; code: string }[];
}

export interface DocModel {
  title: string;
  intro: string;
  generated: string;
  servers: string[];
  authSchemes: string[];
  folders: { name: string; endpoints: DocEndpoint[] }[];
}

// ───────────────────────── Redaction and field tables ─────────────────────────

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);

/** Flattens a JSON value into documented fields: `items[].price` → number, with an example. */
export function fieldTable(value: unknown, max = 60, mode: Exclude<ExampleMode, "off"> = "sample"): Field[] {
  const out: Field[] = [];
  const walk = (v: unknown, path: string, key: string, depth: number) => {
    if (out.length >= max || depth > 6) return;
    const t = typeOf(v);
    // The parent row already says "array of object"; list the item's fields, not the item itself.
    if (path && !(path.endsWith("[]") && t === "object")) {
      const shown = t === "object" || t === "array" ? "" : String(redact(v, key, 0, mode));
      out.push({ path, type: t === "array" && Array.isArray(v) && v.length ? `array of ${typeOf(v[0])}` : t, example: shown.length > 40 ? `${shown.slice(0, 40)}…` : shown });
    }
    if (t === "array" && Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] !== null) walk(v[0], `${path}[]`, key, depth + 1);
    else if (t === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, k, depth + 1);
  };
  walk(value, "", "", 0);
  // Arrays at the root document their items directly.
  return out;
}

/** A JSON body with secret fields hidden; other text is returned unchanged. */
function cleanBody(text: string): string {
  const j = parseJson(text);
  return j.ok ? JSON.stringify(redact(j.value), null, 2) : text;
}

const literal = (v: string) => !!v && !v.includes("{{");

/** The request as code samples show it: literal credentials hidden, placeholders kept. */
export function sampleRequest(d: HttpItem): RawRequest {
  const raw = buildRequest(d, {});
  const a = d.auth;
  const headers = raw.headers.map((h) => {
    const k = h.key.toLowerCase();
    if (k === "authorization") {
      if (a.type === "basic") return { ...h, value: literal(a.username) || literal(a.password) ? "Basic ••••••" : "Basic {{base64(username:password)}}" };
      const [scheme, ...rest] = h.value.split(" ");
      return literal(rest.join(" ")) && rest.length ? { ...h, value: `${scheme} ${HIDDEN}` } : literal(h.value) && !rest.length ? { ...h, value: HIDDEN } : h;
    }
    const isKey = a.type === "apikey" && a.in === "header" && k === a.key.toLowerCase();
    return (isKey || SECRET_KEY.test(h.key)) && literal(h.value) ? { ...h, value: HIDDEN } : h;
  });
  let url = raw.url;
  const q = url.indexOf("?");
  if (q >= 0) {
    const hide = (key: string) => SECRET_KEY.test(decodeURIComponent(key)) || (a.type === "apikey" && a.in === "query" && decodeURIComponent(key) === a.key);
    url = url.slice(0, q + 1) + url.slice(q + 1).split("&").map((p) => {
      const at = p.indexOf("=");
      return at > 0 && hide(p.slice(0, at)) && literal(decodeURIComponent(p.slice(at + 1))) ? `${p.slice(0, at)}=${encodeURIComponent(HIDDEN)}` : p;
    }).join("&");
  }
  const body = raw.body?.type === "raw" ? { type: "raw" as const, content: cleanBody(raw.body.content) } : raw.body?.type === "form" || raw.body?.type === "multipart" ? { ...raw.body, fields: raw.body.fields.map((f) => (SECRET_KEY.test(f.key) && literal(f.value) ? { ...f, value: HIDDEN } : f)) } : raw.body;
  return { ...raw, url, headers, body: body as RawRequest["body"] };
}

const parseJson = (s: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};

// ───────────────────────── Model ─────────────────────────

function describeAuth(a: Auth): string {
  switch (a.type) {
    // Callers resolve inherited auth first; unresolved, it means nothing is set.
    case "inherit":
    case "none":
      return "";
    case "bearer":
      return "Bearer token in the Authorization header";
    case "basic":
      return "HTTP Basic (username and password)";
    case "apikey":
      return `API key in the \`${a.key}\` ${a.in === "header" ? "header" : "query parameter"}`;
    case "oauth2": {
      const grant = { authorization_code: "authorization code", client_credentials: "client credentials", password: "password" }[a.grant];
      return `OAuth 2.0 (${grant}${a.grant === "authorization_code" && a.pkce ? " with PKCE" : ""})${a.tokenUrl && !a.tokenUrl.includes("{{") ? `, token URL ${a.tokenUrl}` : ""}${a.scope ? `, scopes: ${a.scope}` : ""}`;
    }
    case "digest":
      return "HTTP Digest";
    case "awsv4":
      return `AWS Signature v4 (service ${a.service}, region ${a.region})`;
    case "hawk":
      return "Hawk";
    case "jwt":
      return `JWT (${a.algorithm}) in the Authorization header`;
  }
}

const OPS: Record<Assertion["op"], string> = { eq: "is", neq: "is not", contains: "contains", notContains: "does not contain", gt: "is greater than", lt: "is less than", exists: "exists", notExists: "does not exist", matches: "matches" };

export function describeTest(a: Assertion): string {
  const what = { status: "Status", header: `Header \`${a.path}\``, jsonpath: `\`${a.path || "$"}\``, body: "Body", time: "Response time (ms)", size: "Response size (bytes)" }[a.source];
  return `${what} ${OPS[a.op]}${a.op === "exists" || a.op === "notExists" ? "" : ` ${a.source === "jsonpath" || a.source === "header" || a.op === "matches" ? `\`${a.value}\`` : a.value}`}`;
}

const rel = (root: string, path: string) => path.slice(root.length + 1);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "endpoint";

export function buildDocModel(i: ExportInput, opts: DocOptions, now = new Date()): DocModel {
  const items = i.items.filter((x): x is Item & HttpItem => x.kind === "http" && x.path.startsWith(`${i.root}/`)).sort((a, b) => a.path.localeCompare(b.path));
  const servers = new Set<string>();
  const schemes = new Set<string>();
  const ids = new Set<string>();
  const folders = new Map<string, DocEndpoint[]>();

  for (const own of items) {
    // Documented as sent: folder headers and inherited auth, with collection variables for base URLs.
    const d = effectiveItem(own, i.folders ?? {});
    const r = rel(i.root, d.path);
    const folder = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
    const loc = openApiLocation(d.url, { ...folderVars(d.path, i.folders ?? {}), ...i.vars });
    if (loc.server) servers.add(loc.server);
    const auth = describeAuth(d.auth);
    if (auth) schemes.add(auth);
    let id = slug(`${folder} ${d.name}`);
    for (let n = 2; ids.has(id); n++) id = `${slug(`${folder} ${d.name}`)}-${n}`;
    ids.add(id);

    const url = displayUrl(d.url, d.params);
    const queryKeys = new Set(parseQuery(splitUrl(url).query ?? "").map((p) => p.key));
    const params: DocParam[] = [
      ...loc.pathParams.map((name) => ({ name, in: "path" as const, example: d.pathVars?.find((v) => v.key === name)?.value ?? "", required: true })),
      ...d.params.filter((p) => p.key).map((p) => ({ name: p.key, in: "query" as const, example: p.value, required: false })),
      ...[...queryKeys].filter((k) => !d.params.some((p) => p.key === k)).map((name) => ({ name, in: "query" as const, example: "", required: false })),
      ...d.headers.filter((h) => h.key && h.enabled).map((h) => ({ name: h.key, in: "header" as const, example: SECRET_KEY.test(h.key) && !h.value.includes("{{") ? HIDDEN : h.value, required: false })),
    ];

    let body: DocEndpoint["body"];
    if (d.bodyMode === "json") {
      const j = parseJson(d.body);
      body = { type: "application/json", example: cleanBody(d.body.trim()), fields: j.ok ? fieldTable(j.value) : [] };
    } else if (d.bodyMode === "graphql") body = { type: "application/json (GraphQL)", example: d.graphql.query.trim(), fields: [] };
    else if (d.bodyMode === "xml" || d.bodyMode === "text") body = { type: d.bodyMode === "xml" ? "application/xml" : "text/plain", example: d.body.trim(), fields: [] };
    else if (d.bodyMode === "form" || d.bodyMode === "multipart")
      body = {
        type: d.bodyMode === "form" ? "application/x-www-form-urlencoded" : "multipart/form-data",
        example: "",
        fields: (d.bodyMode === "form" ? d.form : d.multipart).filter((f) => f.key).map((f) => ({ path: f.key, type: "file" in f && f.file ? "file" : "string", example: SECRET_KEY.test(f.key) ? HIDDEN : f.value })),
      };
    else if (d.bodyMode === "binary") body = { type: "application/octet-stream", example: "", fields: [] };

    let response: DocEndpoint["response"];
    // A saved example is curated, so it's preferred over whatever the last run returned.
    const saved = defaultExample(d.examples);
    const res: HttpResponse | undefined = saved ? exampleAsResponse(saved) : i.responses?.[d.path];
    if (opts.examples !== "off" && res && !res.bodyBase64) {
      const mode = opts.examples;
      const type = res.headers.find((h) => h.key.toLowerCase() === "content-type")?.value.split(";")[0] ?? "";
      const j = parseJson(res.body);
      const shown = j.ok ? JSON.stringify(redact(j.value, "", 0, mode), null, 2) : redactText(res.body.slice(0, 1500));
      response = { status: res.status, statusText: res.statusText, type, example: shown.length > 4000 ? `${shown.slice(0, 4000)}\n…` : shown, fields: j.ok ? fieldTable(Array.isArray(j.value) ? (j.value[0] ?? {}) : j.value, 60, mode) : [] };
    }

    const raw = sampleRequest(d);
    const samples = opts.samples.map((lang) => ({ label: LANGUAGES.find((l) => l.id === lang)!.label, code: generate(lang, raw) }));

    const ep: DocEndpoint = {
      id,
      source: d.path,
      folder,
      name: d.name,
      method: raw.method,
      path: loc.path + (splitUrl(url).query ? `?${splitUrl(url).query}` : ""),
      description: (d.description ?? "").trim(),
      auth,
      params,
      body,
      response,
      tests: d.assertions.filter((a) => a.enabled).map(describeTest),
      samples,
    };
    folders.set(folder, [...(folders.get(folder) ?? []), ep]);
  }

  return {
    title: opts.title || i.name,
    intro: opts.intro.trim(),
    generated: now.toISOString().slice(0, 10),
    servers: [...servers],
    authSchemes: [...schemes],
    folders: [...folders].map(([name, endpoints]) => ({ name, endpoints })),
  };
}

export const missingDescriptions = (i: ExportInput) =>
  i.items.filter((x): x is Item & HttpItem => x.kind === "http" && x.path.startsWith(`${i.root}/`) && !(x.description ?? "").trim());

// ───────────────────────── Markdown ─────────────────────────

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ") || " ";
const fence = (code: string, lang = "") => {
  const ticks = code.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${code}\n${ticks}`;
};
const langOf = (type: string) => (/json/.test(type) ? "json" : /xml/.test(type) ? "xml" : "");
const folderTitle = (f: string) => f || "General";

export function docsMarkdown(m: DocModel): string {
  const out: string[] = [`# ${m.title}`, "", `Generated by Forge on ${m.generated}.`, ""];
  if (m.intro) out.push(m.intro, "");
  if (m.servers.length) out.push("## Base URLs", "", ...m.servers.map((s) => `- \`${s}\``), "");
  if (m.authSchemes.length) out.push("## Authentication", "", ...m.authSchemes.map((s) => `- ${s}`), "");
  out.push("## Endpoints", "");
  for (const f of m.folders) {
    out.push(`- **${folderTitle(f.name)}**`);
    for (const e of f.endpoints) out.push(`  - [${e.method} ${e.path}](#${e.id}) ${e.name}`);
  }
  out.push("");
  for (const f of m.folders) {
    out.push(`## ${folderTitle(f.name)}`, "");
    for (const e of f.endpoints) {
      out.push(`<a id="${e.id}"></a>`, "", `### ${e.name}`, "", `\`${e.method} ${e.path}\``, "");
      if (e.description) out.push(e.description, "");
      if (e.auth) out.push(`**Auth:** ${e.auth}`, "");
      if (e.params.length) {
        out.push("**Parameters**", "", "| Name | In | Required | Example |", "| --- | --- | --- | --- |");
        for (const p of e.params) out.push(`| \`${cell(p.name)}\` | ${p.in} | ${p.required ? "yes" : "no"} | ${p.example ? `\`${cell(p.example)}\`` : " "} |`);
        out.push("");
      }
      if (e.body) {
        out.push(`**Request body** (${e.body.type})`, "");
        if (e.body.example) out.push(fence(e.body.example, langOf(e.body.type)), "");
        if (e.body.fields.length) out.push(...fieldsMd(e.body.fields), "");
      }
      if (e.response) {
        out.push(`**Response** ${e.response.status} ${e.response.statusText}${e.response.type ? ` (${e.response.type})` : ""}`, "");
        if (e.response.fields.length) out.push(...fieldsMd(e.response.fields), "");
        out.push(fence(e.response.example, langOf(e.response.type)), "");
      }
      if (e.tests.length) out.push("**Checked behaviour**", "", ...e.tests.map((t) => `- ${t}`), "");
      for (const s of e.samples) out.push(`<details><summary>${s.label}</summary>`, "", fence(s.code), "", "</details>", "");
    }
  }
  return out.join("\n");
}

const fieldsMd = (fields: Field[]) => ["| Field | Type | Example |", "| --- | --- | --- |", ...fields.map((f) => `| \`${cell(f.path)}\` | ${f.type} | ${f.example ? `\`${cell(f.example)}\`` : " "} |`)];

// ───────────────────────── HTML ─────────────────────────

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Markdown for descriptions: paragraphs, lists, bold, italics, code and http(s) links. HTML is escaped, never passed through. */
export function mdToHtml(md: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) => `<a href="${u.replace(/"/g, "%22")}" rel="noopener noreferrer">${t}</a>`);
  const blocks: string[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  for (let k = 0; k < lines.length; ) {
    const line = lines[k];
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (k++; k < lines.length && !/^```/.test(lines[k]); k++) body.push(lines[k]);
      k++;
      blocks.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const li: string[] = [];
      for (; k < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[k]); k++) li.push(`<li>${inline(lines[k].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
      blocks.push(`<${ordered ? "ol" : "ul"}>${li.join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(`<h4>${inline(line.replace(/^#+\s/, ""))}</h4>`);
      k++;
    } else if (!line.trim()) k++;
    else {
      const para: string[] = [];
      for (; k < lines.length && lines[k].trim() && !/^(```|#{1,6}\s|\s*([-*]|\d+\.)\s)/.test(lines[k]); k++) para.push(lines[k]);
      blocks.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return blocks.join("\n");
}

const METHOD_CLASS = (m: string) => `m-${m.toLowerCase()}`;

export function docsHtml(m: DocModel): string {
  const nav = m.folders
    .map((f) => `<div class="nav-group"><div class="nav-title">${esc(folderTitle(f.name))}</div>${f.endpoints.map((e) => `<a href="#${e.id}" data-q="${esc(`${e.name} ${e.method} ${e.path}`.toLowerCase())}"><span class="method ${METHOD_CLASS(e.method)}">${esc(e.method)}</span>${esc(e.name)}</a>`).join("")}</div>`)
    .join("");
  const table = (head: string[], rows: string[][]) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const code = (s: string, label = "") => `<div class="code">${label ? `<div class="code-label">${esc(label)}</div>` : ""}<button class="copy" type="button">Copy</button><pre><code>${esc(s)}</code></pre></div>`;
  const fieldsTable = (fields: Field[]) => table(["Field", "Type", "Example"], fields.map((f) => [`<code>${esc(f.path)}</code>`, esc(f.type), f.example ? `<code>${esc(f.example)}</code>` : ""]));

  const sections = m.folders
    .map(
      (f) => `<section class="folder"><h2>${esc(folderTitle(f.name))}</h2>${f.endpoints
        .map(
          (e) => `<article class="endpoint" id="${e.id}">
<h3>${esc(e.name)}</h3>
<div class="route"><span class="method ${METHOD_CLASS(e.method)}">${esc(e.method)}</span><code>${esc(e.path)}</code></div>
${e.description ? `<div class="desc">${mdToHtml(e.description)}</div>` : ""}
${e.auth ? `<p class="meta"><b>Auth</b> ${mdToHtml(e.auth).replace(/^<p>|<\/p>$/g, "")}</p>` : ""}
${e.params.length ? `<h4>Parameters</h4>${table(["Name", "In", "Required", "Example"], e.params.map((p) => [`<code>${esc(p.name)}</code>`, p.in, p.required ? "yes" : "no", p.example ? `<code>${esc(p.example)}</code>` : ""]))}` : ""}
${e.body ? `<h4>Request body <span class="muted">${esc(e.body.type)}</span></h4>${e.body.fields.length ? fieldsTable(e.body.fields) : ""}${e.body.example ? code(e.body.example) : ""}` : ""}
${e.response ? `<h4>Response <span class="status s${String(e.response.status)[0]}">${e.response.status} ${esc(e.response.statusText)}</span> <span class="muted">${esc(e.response.type)}</span></h4>${e.response.fields.length ? fieldsTable(e.response.fields) : ""}${code(e.response.example)}` : ""}
${e.tests.length ? `<h4>Checked behaviour</h4><ul class="tests">${e.tests.map((t) => `<li>${mdToHtml(t).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}</ul>` : ""}
${e.samples.length ? `<h4>Code</h4><div class="samples">${e.samples.map((s) => code(s.code, s.label)).join("")}</div>` : ""}
</article>`,
        )
        .join("")}</section>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}</title>
<meta name="generator" content="Forge">
<style>
:root { color-scheme: light; --bg: #fff; --bg-2: #f6f7f9; --line: #e4e6ea; --fg: #14161a; --fg-2: #4b505a; --fg-3: #7a7f89; --accent: #2f6fdb; --code: #f3f4f6; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg: #0d0f12; --bg-2: #15181d; --line: #262a31; --fg: #eceef1; --fg-2: #b4b9c2; --fg-3: #858b96; --accent: #79a7f0; --code: #171a20; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
nav { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 20px 14px; border-right: 1px solid var(--line); background: var(--bg-2); }
nav .brand { font-weight: 650; font-size: 16px; padding: 0 8px 12px; }
nav input { width: 100%; padding: 7px 10px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; font-size: 13px; }
.nav-title { font-size: 12px; font-weight: 600; color: var(--fg-3); margin: 14px 8px 4px; }
nav a { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; border-radius: 5px; color: var(--fg-2); text-decoration: none; font-size: 13.5px; }
nav a:hover { background: var(--line); color: var(--fg); }
main { padding: 36px 48px 80px; max-width: 980px; }
h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -.02em; }
h2 { font-size: 21px; margin: 44px 0 0; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
h3 { font-size: 18px; margin: 0 0 8px; }
h4 { font-size: 14px; margin: 22px 0 8px; }
.lede { color: var(--fg-2); }
.muted { color: var(--fg-3); font-weight: 400; }
.endpoint { padding: 28px 0; border-bottom: 1px solid var(--line); }
.route { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.route code { font-size: 14px; word-break: break-all; }
.method { display: inline-block; min-width: 52px; font: 700 11px ui-monospace, Menlo, monospace; }
.route .method { padding: 3px 8px; border-radius: 4px; background: var(--code); text-align: center; }
.m-get { color: #1a8f4c; } .m-post { color: #b7791f; } .m-put { color: #2f6fdb; } .m-patch { color: #7c4dcc; } .m-delete { color: #c53030; }
.desc p { margin: 0 0 10px; }
.meta { color: var(--fg-2); }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-bottom: 8px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--fg-3); font-size: 12px; }
td code { background: var(--code); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
.code { position: relative; margin: 8px 0; }
.code-label { font-size: 12px; color: var(--fg-3); margin-bottom: 4px; }
.code pre { margin: 0; padding: 14px; background: var(--code); border: 1px solid var(--line); border-radius: 8px; overflow: auto; max-height: 420px; }
.copy { position: absolute; top: 6px; right: 6px; font: 12px inherit; padding: 3px 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); color: var(--fg-2); cursor: pointer; }
.code-label + .copy { top: 26px; }
.status { font-family: ui-monospace, Menlo, monospace; font-size: 12px; padding: 2px 7px; border-radius: 4px; background: var(--code); }
.s2 { color: #1a8f4c; } .s3 { color: #2f6fdb; } .s4, .s5 { color: #c53030; }
.tests li { color: var(--fg-2); }
footer { margin-top: 48px; color: var(--fg-3); font-size: 13px; }
@media (max-width: 860px) { .layout { grid-template-columns: 1fr; } nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); } main { padding: 24px 20px 60px; } }
</style>
</head>
<body>
<div class="layout">
<nav aria-label="Endpoints">
<div class="brand">${esc(m.title)}</div>
<input type="search" placeholder="Filter endpoints" aria-label="Filter endpoints" id="q">
${nav}
</nav>
<main>
<h1>${esc(m.title)}</h1>
<p class="muted">Generated by Forge on ${m.generated}.</p>
${m.intro ? `<div class="lede">${mdToHtml(m.intro)}</div>` : ""}
${m.servers.length ? `<h4>Base URLs</h4><ul>${m.servers.map((s) => `<li><code>${esc(s)}</code></li>`).join("")}</ul>` : ""}
${m.authSchemes.length ? `<h4>Authentication</h4><ul>${m.authSchemes.map((s) => `<li>${mdToHtml(s).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}</ul>` : ""}
${sections}
<footer>Made with <a href="https://forge.stellitron.com">Forge</a>.</footer>
</main>
</div>
<script>
document.querySelectorAll(".copy").forEach(function (b) { b.addEventListener("click", function () { navigator.clipboard.writeText(b.parentElement.querySelector("code").textContent); b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1200); }); });
document.getElementById("q").addEventListener("input", function (e) { var q = e.target.value.toLowerCase(); document.querySelectorAll("nav a").forEach(function (a) { a.style.display = a.dataset.q.indexOf(q) >= 0 ? "" : "none"; }); });
</script>
</body>
</html>
`;
}
