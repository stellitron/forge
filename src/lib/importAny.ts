import { parse as parseYaml } from "yaml";
import { importCurl, importPostman, importPostmanEnv, type Imported } from "./importers";
import { defaults, kv, type AssertOp, type Assertion, type Auth, type HttpItem, type KV } from "./types";
import { skeleton } from "../components/ui";

/**
 * One importer for everything: detects Postman, Insomnia (v4 JSON / v5 YAML), Bruno
 * (.bru folders or JSON export), OpenAPI 3 / Swagger 2 (JSON or YAML), HAR and cURL.
 */

export interface Source {
  path: string; // relative path, e.g. "My API/users/list.bru"; "pasted" for pasted text
  content: string;
}

export interface ImportedCollection {
  name: string;
  format: string;
  items: Imported[];
}

export interface ImportedEnv {
  name: string;
  /** Shared values, committed with the workspace (URLs, ids, flags). */
  vars: KV[];
  /** Credentials, kept in the gitignored <env>.local.json. */
  secrets: KV[];
}

export interface ImportResult {
  collections: ImportedCollection[];
  envs: ImportedEnv[];
  /** Base URL found in an OpenAPI spec; set as {{baseUrl}} in the active environment. */
  baseUrl?: string;
  skipped: string[];
}

const SECRET_KEY = /(token|secret|passw(or)?d|pwd|api[-_]?key|apikey|auth|credential|session|cookie|private|jwt|bearer|signature|client[-_]?key|access[-_]?key)/i;

/** Looks like a credential value: a JWT, a "Bearer …", or a long random-looking string. */
function secretValue(v: string): boolean {
  if (/^eyJ[\w-]+\.[\w-]+\./.test(v) || /^(bearer|basic)\s+\S{8,}/i.test(v)) return true;
  if (v.length < 24 || /\s|^https?:\/\/|\{\{/.test(v)) return false;
  return /[a-z]/.test(v) && /[A-Z0-9]/.test(v) && /^[\w\-+/=.~]+$/.test(v);
}

/**
 * Splits imported variables: credentials (by name, by value, or flagged secret by the source tool)
 * go to the local secrets file; everything else stays shared so teammates can use the collection.
 */
export function splitEnv(name: string, all: (KV & { secret?: boolean })[]): ImportedEnv {
  const vars: KV[] = [];
  const secrets: KV[] = [];
  for (const { secret, ...v } of all) (secret || SECRET_KEY.test(v.key) || secretValue(v.value) ? secrets : vars).push(v);
  return { name, vars, secrets };
}

const str = (x: unknown): string => (typeof x === "string" ? x : x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x));
const basename = (p: string) => p.split("/").pop()!.replace(/\.[^.]+$/, "");

/** Insomnia writes `{{ _.name }}` / `{{_['name']}}`; everyone else writes `{{name}}`. */
const vars = (s: string) => s.replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, "{{$1}}").replace(/\{\{\s*_\[['"]([^'"]+)['"]\]\s*\}\}/g, "{{$1}}");

function setBody(d: HttpItem, mime: string, text: string) {
  d.body = text;
  d.bodyMode = /json/i.test(mime) || (!mime && /^\s*[[{]/.test(text)) ? "json" : /xml/i.test(mime) ? "xml" : "text";
  if (mime && !d.headers.some((h) => h.key.toLowerCase() === "content-type")) d.headers.push(kv("Content-Type", mime));
}

function splitUrl(d: HttpItem, url: string) {
  const q = url.indexOf("?");
  if (q < 0 || url.slice(q).includes("{{")) return void (d.url = url);
  d.url = url.slice(0, q);
  d.params = [...d.params, ...Array.from(new URLSearchParams(url.slice(q + 1))).map(([k, v]) => kv(k, v))];
}

// ───────────────────────── OpenAPI / Swagger ─────────────────────────

export function fromOpenApi(spec: any): { name: string; items: Imported[]; baseUrl: string } {
  if (!spec?.paths) throw new Error("Not an OpenAPI document (no paths)");
  const resolve = (n: any, d = 0): any => {
    if (!n || typeof n !== "object" || d > 8) return n;
    if (typeof n.$ref === "string" && n.$ref.startsWith("#/"))
      return resolve(n.$ref.slice(2).split("/").map((k: string) => k.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((o: any, k: string) => o?.[k], spec), d + 1);
    if (Array.isArray(n)) return n.map((x) => resolve(x, d + 1));
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, resolve(v, d + 1)]));
  };
  const server = spec.servers?.[0];
  let baseUrl = server?.url ?? (spec.host ? `${spec.schemes?.[0] ?? "https"}://${spec.host}${spec.basePath ?? ""}` : "");
  for (const [k, v] of Object.entries<any>(server?.variables ?? {})) baseUrl = baseUrl.replace(`{${k}}`, str(v.default));
  const security = (op: any) => {
    const req = op.security ?? spec.security;
    const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
    const name = req?.[0] && Object.keys(req[0])[0];
    const s = name && resolve(schemes[name]);
    if (!s) return { type: "none" } as Auth;
    if ((s.type === "http" && s.scheme === "bearer") || s.type === "oauth2" || s.type === "openIdConnect") return { type: "bearer", token: "{{token}}" } as Auth;
    if ((s.type === "http" && s.scheme === "basic") || s.type === "basic") return { type: "basic", username: "{{username}}", password: "{{password}}" } as Auth;
    if (s.type === "apiKey" && s.in !== "cookie") return { type: "apikey", key: s.name, value: "{{apiKey}}", in: s.in === "query" ? "query" : "header" } as Auth;
    return { type: "none" } as Auth;
  };
  const items: Imported[] = [];
  for (const [path, ops] of Object.entries<any>(spec.paths)) {
    for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const op = ops[m];
      if (!op) continue;
      const d = defaults.http();
      d.method = m.toUpperCase();
      d.url = `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, "{{$1}}")}`;
      d.auth = security(op);
      const params = [...(ops.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(p));
      const ex = (p: any) => str(p.example ?? p.schema?.example ?? p.schema?.default ?? p.default ?? "");
      d.params = params.filter((p) => p.in === "query").map((p) => kv(p.name, ex(p), !!p.required));
      d.headers = params.filter((p) => p.in === "header").map((p) => kv(p.name, ex(p), !!p.required));
      const content = resolve(op.requestBody)?.content ?? {};
      const swaggerBody = params.find((p) => p.in === "body");
      const swaggerForm = params.filter((p) => p.in === "formData");
      const json = content["application/json"] ?? Object.entries<any>(content).find(([k]) => /json/.test(k))?.[1];
      const form = content["application/x-www-form-urlencoded"];
      const multi = content["multipart/form-data"];
      if (json || swaggerBody) {
        const src = json ?? swaggerBody;
        const example = src.example ?? Object.values<any>(src.examples ?? {})[0]?.value;
        setBody(d, "application/json", JSON.stringify(example ?? skeleton(src.schema), null, 2));
      } else if (form || multi) {
        const props = Object.entries<any>((form ?? multi).schema?.properties ?? {});
        if (multi) {
          d.bodyMode = "multipart";
          d.multipart = props.map(([k, s]) => ({ ...kv(k, s.format === "binary" ? "" : str(s.example ?? "")), file: s.format === "binary" }));
        } else {
          d.bodyMode = "form";
          d.form = props.map(([k, s]) => kv(k, str(s.example ?? "")));
        }
      } else if (swaggerForm.length) {
        const file = swaggerForm.some((p) => p.type === "file");
        d.bodyMode = file ? "multipart" : "form";
        if (file) d.multipart = swaggerForm.map((p) => ({ ...kv(p.name, ex(p), !!p.required), file: p.type === "file" }));
        else d.form = swaggerForm.map((p) => kv(p.name, ex(p), !!p.required));
      }
      const ok = Object.keys(op.responses ?? {}).find((c) => /^2/.test(c));
      if (ok) d.assertions = [{ enabled: true, source: "status", path: "", op: "eq", value: ok }];
      items.push({ name: op.summary || op.operationId || `${d.method} ${path}`, folder: op.tags?.[0] ?? "", data: d });
    }
  }
  return { name: spec.info?.title || "OpenAPI", items, baseUrl };
}

// ───────────────────────── Insomnia ─────────────────────────

function insomniaAuth(a: any): Auth {
  if (!a || a.disabled) return { type: "none" };
  if (a.type === "bearer") return { type: "bearer", token: vars(str(a.token)) };
  if (a.type === "basic") return { type: "basic", username: vars(str(a.username)), password: vars(str(a.password)) };
  if (a.type === "apikey") return { type: "apikey", key: vars(str(a.key)), value: vars(str(a.value)), in: a.addTo === "queryParams" ? "query" : "header" };
  if (a.type === "oauth2" && a.accessTokenUrl) return { type: "bearer", token: "{{token}}" };
  return { type: "none" };
}

function insomniaRequest(r: any): HttpItem {
  const d = defaults.http();
  d.method = str(r.method || "GET").toUpperCase();
  d.headers = (r.headers ?? []).map((h: any) => kv(str(h.name), vars(str(h.value)), !h.disabled));
  d.params = (r.parameters ?? []).map((p: any) => kv(str(p.name), vars(str(p.value)), !p.disabled));
  splitUrl(d, vars(str(r.url)));
  d.auth = insomniaAuth(r.authentication);
  const b = r.body ?? {};
  const mime = str(b.mimeType);
  if (mime === "application/x-www-form-urlencoded") {
    d.bodyMode = "form";
    d.form = (b.params ?? []).map((p: any) => kv(str(p.name), vars(str(p.value)), !p.disabled));
  } else if (mime === "multipart/form-data") {
    d.bodyMode = "multipart";
    d.multipart = (b.params ?? []).map((p: any) => ({ ...kv(str(p.name), p.type === "file" ? str(p.fileName) : vars(str(p.value)), !p.disabled), file: p.type === "file" }));
  } else if (mime === "application/graphql") {
    const g = JSON.parse(b.text || "{}");
    d.bodyMode = "graphql";
    d.graphql = { query: str(g.query), variables: JSON.stringify(g.variables ?? {}, null, 2) };
  } else if (b.fileName) {
    d.bodyMode = "binary";
    d.body = str(b.fileName);
  } else if (b.text != null) setBody(d, mime, vars(str(b.text)));
  return d;
}

/** Insomnia v4 export (JSON or YAML with `_type: export`). */
function fromInsomnia4(doc: any): ImportResult {
  const res: any[] = doc.resources ?? [];
  const byId = new Map(res.map((r) => [r._id, r]));
  const out: ImportResult = { collections: [], envs: [], skipped: [] };
  const workspaces = res.filter((r) => r._type === "workspace");
  const colOf = new Map<string, ImportedCollection>();
  for (const w of workspaces.length ? workspaces : [{ _id: "", name: "Insomnia" }]) {
    const c = { name: str(w.name) || "Insomnia", format: "Insomnia", items: [] };
    colOf.set(w._id, c);
    out.collections.push(c);
  }
  // Walk up parentIds to find the folder path and owning workspace.
  const locate = (r: any) => {
    const parts: string[] = [];
    let p = byId.get(r.parentId);
    while (p && p._type === "request_group") {
      parts.unshift(str(p.name));
      p = byId.get(p.parentId);
    }
    return { folder: parts.join("/"), col: colOf.get(p?._id) ?? out.collections[0] };
  };
  for (const r of res) {
    if (r._type === "request" || r._type === "grpc_request" || r._type === "websocket_request") {
      if (r._type !== "request") {
        out.skipped.push(`${r.name} (${r._type.replace("_request", "")})`);
        continue;
      }
      const { folder, col } = locate(r);
      col.items.push({ name: str(r.name) || "Request", folder, data: insomniaRequest(r) });
    } else if (r._type === "environment" && r.data && Object.keys(r.data).length) {
      const parent = byId.get(r.parentId);
      const name = parent?._type === "environment" ? str(r.name) : `${str(r.name) || "Base"}${parent?.name ? ` (${parent.name})` : ""}`;
      out.envs.push(splitEnv(name, flatten(r.data)));
    }
  }
  return out;
}

/** Insomnia v5 YAML (`type: collection.insomnia.rest/5.0`). */
function fromInsomnia5(doc: any): ImportResult {
  const col: ImportedCollection = { name: str(doc.name) || "Insomnia", format: "Insomnia", items: [] };
  const out: ImportResult = { collections: [col], envs: [], skipped: [] };
  const walk = (list: any[], folder: string) => {
    for (const n of list ?? []) {
      if (Array.isArray(n.children)) walk(n.children, folder ? `${folder}/${n.name}` : str(n.name));
      else if (n.url !== undefined || n.method) col.items.push({ name: str(n.name) || "Request", folder, data: insomniaRequest(n) });
    }
  };
  walk(doc.collection ?? [], "");
  const env = doc.environments;
  if (env) {
    if (env.data && Object.keys(env.data).length) out.envs.push(splitEnv(`${col.name} base`, flatten(env.data)));
    for (const s of env.subEnvironments ?? []) out.envs.push(splitEnv(str(s.name) || "Environment", flatten(s.data ?? {})));
  }
  return out;
}

const flatten = (data: Record<string, unknown>, prefix = ""): KV[] =>
  Object.entries(data).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? flatten(v as any, `${prefix}${k}.`) : [kv(prefix + k, str(v))]));

// ───────────────────────── Bruno ─────────────────────────

interface BruBlock {
  name: string;
  text: string; // raw body for text blocks
  dict: KV[]; // key: value lines for dictionary blocks (~ prefix = disabled)
}

/** Parses the .bru markup: `name {` … `}` blocks, with 2-space indented contents. */
export function parseBru(src: string): BruBlock[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: BruBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w:.-]+)\s*([{[])\s*$/);
    if (!m) continue;
    const close = m[2] === "{" ? "}" : "]";
    const body: string[] = [];
    while (++i < lines.length && lines[i] !== close) body.push(lines[i]);
    const text = body.map((l) => l.replace(/^ {2}/, "")).join("\n");
    const dict = body
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        if (close === "]") return kv(l.replace(/^~/, "").replace(/,$/, ""), "", !l.startsWith("~"));
        const c = l.indexOf(":");
        const key = c < 0 ? l : l.slice(0, c).trim();
        return kv(key.replace(/^~/, ""), c < 0 ? "" : l.slice(c + 1).trim(), !key.startsWith("~"));
      });
    blocks.push({ name: m[1], text, dict });
  }
  return blocks;
}

const BRU_OPS: Record<string, AssertOp> = { eq: "eq", neq: "neq", gt: "gt", gte: "gt", lt: "lt", lte: "lt", contains: "contains", notContains: "notContains", matches: "matches", isDefined: "exists", isUndefined: "notExists" };

function bruAssertion(k: string, v: string, enabled: boolean): Assertion | null {
  const [opName, ...rest] = v.split(/\s+/);
  const op = BRU_OPS[opName];
  if (!op) return null;
  const value = rest.join(" ").replace(/^["']|["']$/g, "");
  if (k === "res.status") return { enabled, source: "status", path: "", op, value };
  if (k === "res.responseTime") return { enabled, source: "time", path: "", op, value };
  if (k.startsWith("res.headers.")) return { enabled, source: "header", path: k.slice(12), op, value };
  if (k === "res.body") return { enabled, source: "body", path: "", op, value };
  if (k.startsWith("res.body")) return { enabled, source: "jsonpath", path: `$${k.slice(8)}`, op, value };
  return null;
}

function bruAuth(blocks: BruBlock[], mode: string): Auth {
  const get = (name: string, key: string) => blocks.find((b) => b.name === name)?.dict.find((x) => x.key === key)?.value ?? "";
  if (mode === "bearer") return { type: "bearer", token: get("auth:bearer", "token") };
  if (mode === "basic") return { type: "basic", username: get("auth:basic", "username"), password: get("auth:basic", "password") };
  if (mode === "apikey") return { type: "apikey", key: get("auth:apikey", "key"), value: get("auth:apikey", "value"), in: get("auth:apikey", "placement") === "queryparams" ? "query" : "header" };
  return { type: "none" };
}

const BRU_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace", "connect"];

export function bruRequest(src: string): { name: string; seq: number; data: HttpItem } | null {
  const blocks = parseBru(src);
  const meta = blocks.find((b) => b.name === "meta");
  const type = meta?.dict.find((x) => x.key === "type")?.value;
  const verb = blocks.find((b) => BRU_METHODS.includes(b.name));
  if (!verb || (type && type !== "http" && type !== "graphql")) return null;
  const d = defaults.http();
  const v = (k: string) => verb.dict.find((x) => x.key === k)?.value ?? "";
  d.method = verb.name.toUpperCase();
  d.url = v("url");
  const qi = d.url.indexOf("?");
  if (qi >= 0) d.url = d.url.slice(0, qi); // params:query block holds the same params
  const block = (n: string) => blocks.find((b) => b.name === n);
  d.params = block("params:query")?.dict ?? [];
  for (const p of block("params:path")?.dict ?? []) d.url = d.url.replace(`:${p.key}`, p.value || `{{${p.key}}}`);
  d.headers = block("headers")?.dict ?? [];
  d.auth = bruAuth(blocks, v("auth"));
  const bodyMode = v("body");
  if (type === "graphql" || bodyMode === "graphql") {
    d.bodyMode = "graphql";
    d.graphql = { query: block("body:graphql")?.text ?? "", variables: block("body:graphql:vars")?.text || "{}" };
  } else if (bodyMode === "json" || bodyMode === "xml" || bodyMode === "text") {
    d.bodyMode = bodyMode;
    d.body = block(`body:${bodyMode}`)?.text ?? "";
  } else if (bodyMode === "formUrlEncoded" || bodyMode === "form-urlencoded") {
    d.bodyMode = "form";
    d.form = block("body:form-urlencoded")?.dict ?? [];
  } else if (bodyMode === "multipartForm" || bodyMode === "multipart-form") {
    d.bodyMode = "multipart";
    d.multipart = (block("body:multipart-form")?.dict ?? []).map((f) => {
      const file = f.value.match(/^@file\((.*)\)$/);
      return { ...f, value: file ? file[1].split("|")[0] : f.value, file: !!file };
    });
  }
  d.assertions = (block("assert")?.dict ?? []).map((a) => bruAssertion(a.key, a.value, a.enabled)).filter((a): a is Assertion => !!a);
  return { name: meta?.dict.find((x) => x.key === "name")?.value || "Request", seq: Number(meta?.dict.find((x) => x.key === "seq")?.value ?? 0), data: d };
}

/** A Bruno collection folder: bruno.json at its root, requests as .bru files, environments/*.bru. */
function fromBrunoFiles(files: Source[]): ImportResult {
  const out: ImportResult = { collections: [], envs: [], skipped: [] };
  // Each bruno.json marks a collection root; loose .bru files go under their top folder.
  const roots = files.filter((f) => f.path.endsWith("bruno.json")).map((f) => f.path.slice(0, -"bruno.json".length));
  const rootOf = (p: string) => roots.filter((r) => p.startsWith(r)).sort((a, b) => b.length - a.length)[0] ?? (p.includes("/") ? p.slice(0, p.indexOf("/") + 1) : "");
  const cols = new Map<string, ImportedCollection>();
  const col = (root: string) => {
    if (!cols.has(root)) {
      const cfg = files.find((f) => f.path === `${root}bruno.json`);
      let name = root.replace(/\/$/, "").split("/").pop() || "Bruno";
      try {
        name = JSON.parse(cfg?.content ?? "{}").name || name;
      } catch {
        /* keep folder name */
      }
      cols.set(root, { name, format: "Bruno", items: [] });
    }
    return cols.get(root)!;
  };
  const pending: { col: ImportedCollection; folder: string; seq: number; item: Imported }[] = [];
  for (const f of files.filter((f) => f.path.endsWith(".bru"))) {
    const root = rootOf(f.path);
    const rel = f.path.slice(root.length);
    if (rel.startsWith("environments/")) {
      const vars = parseBru(f.content).flatMap((b) => (b.name === "vars" ? b.dict : b.name === "vars:secret" ? b.dict.map((x) => ({ ...x, value: "", secret: true })) : []));
      out.envs.push(splitEnv(basename(rel), vars));
      continue;
    }
    if (/(^|\/)(folder|collection)\.bru$/.test(rel)) continue;
    const r = bruRequest(f.content);
    if (!r) {
      out.skipped.push(f.path);
      continue;
    }
    const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    pending.push({ col: col(root), folder, seq: r.seq, item: { name: r.name, folder, data: r.data } });
  }
  for (const p of pending.sort((a, b) => a.seq - b.seq)) p.col.items.push(p.item);
  out.collections = [...cols.values()];
  return out;
}

/** Bruno "Export → Bruno Collection" JSON. */
function fromBrunoJson(doc: any): ImportResult {
  const col: ImportedCollection = { name: str(doc.name) || "Bruno", format: "Bruno", items: [] };
  const out: ImportResult = { collections: [col], envs: [], skipped: [] };
  const walk = (list: any[], folder: string) => {
    for (const it of [...(list ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
      if (it.type === "folder") walk(it.items, folder ? `${folder}/${it.name}` : str(it.name));
      else if (it.type === "http-request" || it.type === "graphql-request") {
        const r = it.request ?? {};
        const d = defaults.http();
        d.method = str(r.method || "GET").toUpperCase();
        const q = str(r.url).indexOf("?");
        d.url = q >= 0 ? str(r.url).slice(0, q) : str(r.url);
        const params = r.params ?? [];
        d.params = params.filter((p: any) => p.type !== "path").map((p: any) => kv(p.name, str(p.value), p.enabled !== false));
        for (const p of params.filter((p: any) => p.type === "path")) d.url = d.url.replace(`:${p.name}`, str(p.value) || `{{${p.name}}}`);
        d.headers = (r.headers ?? []).map((h: any) => kv(h.name, str(h.value), h.enabled !== false));
        const a = r.auth ?? {};
        d.auth =
          a.mode === "bearer" ? { type: "bearer", token: str(a.bearer?.token) }
          : a.mode === "basic" ? { type: "basic", username: str(a.basic?.username), password: str(a.basic?.password) }
          : a.mode === "apikey" ? { type: "apikey", key: str(a.apikey?.key), value: str(a.apikey?.value), in: a.apikey?.placement === "queryparams" ? "query" : "header" }
          : { type: "none" };
        const b = r.body ?? {};
        if (it.type === "graphql-request" || b.mode === "graphql") {
          d.bodyMode = "graphql";
          d.graphql = { query: str(b.graphql?.query), variables: str(b.graphql?.variables) || "{}" };
        } else if (["json", "xml", "text"].includes(b.mode)) {
          d.bodyMode = b.mode;
          d.body = str(b[b.mode]);
        } else if (b.mode === "formUrlEncoded") {
          d.bodyMode = "form";
          d.form = (b.formUrlEncoded ?? []).map((f: any) => kv(f.name, str(f.value), f.enabled !== false));
        } else if (b.mode === "multipartForm") {
          d.bodyMode = "multipart";
          d.multipart = (b.multipartForm ?? []).map((f: any) => ({ ...kv(f.name, Array.isArray(f.value) ? str(f.value[0]) : str(f.value), f.enabled !== false), file: f.type === "file" }));
        }
        d.assertions = (r.assertions ?? []).map((x: any) => bruAssertion(x.name, str(x.value), x.enabled !== false)).filter(Boolean);
        col.items.push({ name: str(it.name) || "Request", folder, data: d });
      } else out.skipped.push(`${it.name} (${it.type})`);
    }
  };
  walk(doc.items, "");
  for (const e of doc.environments ?? []) out.envs.push(splitEnv(str(e.name), (e.variables ?? []).map((v: any) => ({ ...kv(v.name, v.secret ? "" : str(v.value), v.enabled !== false), secret: !!v.secret }))));
  return out;
}

// ───────────────────────── HAR ─────────────────────────

function fromHar(doc: any, name: string): ImportResult {
  const col: ImportedCollection = { name: name || "HAR import", format: "HAR", items: [] };
  const seen = new Set<string>();
  for (const e of doc.log.entries ?? []) {
    const r = e.request ?? {};
    const d = defaults.http();
    d.method = str(r.method || "GET").toUpperCase();
    let host = "";
    try {
      const u = new URL(str(r.url));
      host = u.host;
      d.url = `${u.origin}${u.pathname}`;
    } catch {
      d.url = str(r.url);
    }
    d.params = (r.queryString ?? []).map((q: any) => kv(str(q.name), str(q.value)));
    // Drop HTTP/2 pseudo-headers and ones the client computes itself.
    d.headers = (r.headers ?? []).filter((h: any) => !/^(:|content-length$|host$|connection$|accept-encoding$)/i.test(h.name)).map((h: any) => kv(str(h.name), str(h.value)));
    const p = r.postData;
    if (p?.params?.length) {
      const multi = /multipart/.test(str(p.mimeType));
      d.bodyMode = multi ? "multipart" : "form";
      if (multi) d.multipart = p.params.map((x: any) => ({ ...kv(str(x.name), str(x.fileName ?? x.value)), file: !!x.fileName }));
      else d.form = p.params.map((x: any) => kv(str(x.name), str(x.value)));
      d.headers = d.headers.filter((h) => h.key.toLowerCase() !== "content-type" || !multi);
    } else if (p?.text) setBody(d, str(p.mimeType).split(";")[0], str(p.text));
    const key = `${d.method} ${d.url}`;
    if (seen.has(key)) continue; // pages repeat the same call; keep the first
    seen.add(key);
    const path = d.url.replace(/^https?:\/\/[^/]+/, "") || "/";
    col.items.push({ name: `${d.method} ${path}`.slice(0, 80), folder: host, data: d });
  }
  return { collections: [col], envs: [], skipped: [] };
}

// ───────────────────────── cURL ─────────────────────────

/** One or more curl commands (separated by blank lines, `;`, or simply starting a new `curl`). */
function fromCurl(text: string, name: string): ImportResult {
  const cmds = text
    .replace(/\\\r?\n/g, " ")
    .split(/\n(?=\s*curl\s)|;\s*(?=curl\s)/)
    .map((c) => c.trim())
    .filter((c) => c.startsWith("curl"));
  const col: ImportedCollection = { name: name || "cURL import", format: "cURL", items: [] };
  for (const c of cmds) {
    const d = importCurl(c);
    col.items.push({ name: `${d.method} ${d.url.replace(/^https?:\/\/[^/]+/, "") || "/"}`.slice(0, 80), folder: "", data: d });
  }
  return { collections: [col], envs: [], skipped: [] };
}

// ───────────────────────── detection ─────────────────────────

function parseDoc(text: string): any {
  const t = text.replace(/^﻿/, "").trim();
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through: YAML is a superset of JSON and gives better errors */
    }
  }
  return parseYaml(t, { maxAliasCount: 1000 });
}

/** Names the format of a parsed document, or null if it isn't one we know. */
export function detect(doc: any): string | null {
  if (!doc || typeof doc !== "object") return null;
  if (doc.info && Array.isArray(doc.item)) return "Postman";
  if (Array.isArray(doc.values) && (doc._postman_variable_scope || doc.name !== undefined)) return "Postman environment";
  if (doc.openapi || doc.swagger) return "OpenAPI";
  if (doc._type === "export" && Array.isArray(doc.resources)) return "Insomnia";
  if (typeof doc.type === "string" && doc.type.startsWith("collection.insomnia.rest")) return "Insomnia";
  if (typeof doc.type === "string" && doc.type.startsWith("environment.insomnia.rest")) return "Insomnia environment";
  if (doc.log && Array.isArray(doc.log.entries)) return "HAR";
  if (Array.isArray(doc.items) && doc.version && doc.name !== undefined) return "Bruno";
  return null;
}

const merge = (a: ImportResult, b: ImportResult): ImportResult => ({
  collections: [...a.collections, ...b.collections],
  envs: [...a.envs, ...b.envs],
  baseUrl: a.baseUrl ?? b.baseUrl,
  skipped: [...a.skipped, ...b.skipped],
});

export function importAny(sources: Source[]): ImportResult {
  let out: ImportResult = { collections: [], envs: [], skipped: [] };
  const bru = sources.filter((s) => s.path.endsWith(".bru") || s.path.endsWith("bruno.json"));
  if (bru.some((s) => s.path.endsWith(".bru"))) out = merge(out, fromBrunoFiles(bru));
  const rest = bru.some((s) => s.path.endsWith(".bru")) ? sources.filter((s) => !bru.includes(s)) : sources;
  const problems: string[] = [];

  for (const s of rest) {
    const label = s.path === "pasted" ? "Pasted text" : s.path;
    const name = s.path === "pasted" ? "" : basename(s.path);
    if (/^\s*curl\s/.test(s.content)) {
      out = merge(out, fromCurl(s.content, name));
      continue;
    }
    let doc: any;
    try {
      doc = parseDoc(s.content);
    } catch (e) {
      problems.push(`${label}: not JSON, YAML or a curl command (${(e as Error).message.split("\n")[0]})`);
      continue;
    }
    const kind = detect(doc);
    try {
      if (kind === "Postman") {
        const p = importPostman(doc);
        out = merge(out, { collections: [{ name: p.name, format: "Postman", items: p.items }], envs: p.variables.length ? [splitEnv(`${p.name} variables`, p.variables)] : [], skipped: [] });
      } else if (kind === "Postman environment") {
        const e = importPostmanEnv(doc);
        // Postman marks credentials with type "secret".
        out.envs.push(splitEnv(e.name, e.vars.map((v, i) => ({ ...v, secret: doc.values[i]?.type === "secret" }))));
      } else if (kind === "OpenAPI") {
        const o = fromOpenApi(doc);
        out = merge(out, { collections: [{ name: o.name, format: "OpenAPI", items: o.items }], envs: [], baseUrl: o.baseUrl || undefined, skipped: [] });
      } else if (kind === "Insomnia") out = merge(out, doc._type === "export" ? fromInsomnia4(doc) : fromInsomnia5(doc));
      else if (kind === "Insomnia environment") out.envs.push(splitEnv(str(doc.name) || name, flatten(doc.data ?? {})));
      else if (kind === "HAR") out = merge(out, fromHar(doc, name));
      else if (kind === "Bruno") out = merge(out, fromBrunoJson(doc));
      else if (s.path !== "pasted" && sources.length > 1) continue; // unrelated file inside a picked folder
      else problems.push(`${label}: not a recognised collection format`);
    } catch (e) {
      problems.push(`${label}: ${(e as Error).message}`);
    }
  }
  out.collections = out.collections.filter((c) => c.items.length);
  if (!out.collections.length && !out.envs.length) throw new Error(problems[0] ?? "Nothing importable found");
  out.skipped.push(...problems);
  return out;
}
