import { stringify as toYaml } from "yaml";
import { displayUrl, pathVarNames, splitUrl } from "./urlParams";
import { redact, redactText } from "./redact";
import type { Assertion, Auth, Environment, HttpItem, HttpResponse, Item, KV } from "./types";

/**
 * Exports a collection or folder for other tools: Postman v2.1 (with tests turned into
 * pm.test scripts) and OpenAPI 3.0. Only HTTP requests are exported; MCP, A2A, WebSocket, web
 * checks and agent tests have no equivalent in these formats and are counted as skipped.
 */

export interface ExportInput {
  name: string;
  /** Folder path the export starts at, e.g. "collections/Demo API". */
  root: string;
  items: Item[];
  /** Variables used to resolve a {{baseUrl}} into an OpenAPI server, when known. Never exported as values. */
  vars?: Record<string, string>;
  /** Last responses, used as OpenAPI examples. */
  responses?: Record<string, HttpResponse | undefined>;
}

const under = (root: string, path: string) => path.startsWith(`${root}/`);
const rel = (root: string, path: string) => path.slice(root.length + 1);
const httpItems = (i: ExportInput) => i.items.filter((x): x is Item & HttpItem => x.kind === "http" && under(i.root, x.path));

export function exportSummary(i: ExportInput) {
  const inside = i.items.filter((x) => under(i.root, x.path));
  const http = inside.filter((x) => x.kind === "http").length;
  return { http, skipped: inside.length - http };
}

// ───────────────────────── Postman v2.1 ─────────────────────────

const pv = (key: string, value: string | boolean | number) => ({ key, value, type: typeof value === "boolean" ? "boolean" : "string" });

function postmanAuth(a: Auth): Record<string, unknown> | undefined {
  switch (a.type) {
    case "none":
      return { type: "noauth" };
    case "bearer":
      return { type: "bearer", bearer: [pv("token", a.token)] };
    case "basic":
      return { type: "basic", basic: [pv("username", a.username), pv("password", a.password)] };
    case "apikey":
      return { type: "apikey", apikey: [pv("key", a.key), pv("value", a.value), pv("in", a.in)] };
    case "digest":
      return { type: "digest", digest: [pv("username", a.username), pv("password", a.password)] };
    case "awsv4":
      return { type: "awsv4", awsv4: [pv("accessKey", a.accessKey), pv("secretKey", a.secretKey), pv("sessionToken", a.sessionToken), pv("region", a.region), pv("service", a.service)] };
    case "hawk":
      return { type: "hawk", hawk: [pv("authId", a.id), pv("authKey", a.key), pv("algorithm", a.algorithm), pv("extraData", a.ext)] };
    case "jwt":
      return {
        type: "jwt",
        jwt: [pv("algorithm", a.algorithm), pv(a.algorithm.startsWith("HS") ? "secret" : "privateKey", a.secret), pv("payload", a.payload), pv("headerPrefix", a.prefix), pv("addTokenTo", "header")],
      };
    case "oauth2":
      return {
        type: "oauth2",
        oauth2: [
          pv("grant_type", a.grant === "authorization_code" ? (a.pkce ? "authorization_code_with_pkce" : "authorization_code") : a.grant === "password" ? "password_credentials" : "client_credentials"),
          pv("authUrl", a.authUrl),
          pv("accessTokenUrl", a.tokenUrl),
          pv("clientId", a.clientId),
          pv("clientSecret", a.clientSecret),
          pv("scope", a.scope),
          pv("redirect_uri", a.redirectUri),
          pv("username", a.username),
          pv("password", a.password),
          pv("client_authentication", a.clientAuth === "basic" ? "header" : "body"),
          pv("tokenName", a.tokenVar),
          pv("addTokenTo", "header"),
        ],
      };
  }
}

function postmanBody(d: HttpItem): Record<string, unknown> | undefined {
  switch (d.bodyMode) {
    case "json":
    case "xml":
    case "text":
      return { mode: "raw", raw: d.body, options: { raw: { language: d.bodyMode } } };
    case "form":
      return { mode: "urlencoded", urlencoded: d.form.map((f) => ({ key: f.key, value: f.value, disabled: !f.enabled })) };
    case "multipart":
      return { mode: "formdata", formdata: d.multipart.map((f) => (f.file ? { key: f.key, type: "file", src: f.value, disabled: !f.enabled } : { key: f.key, value: f.value, type: "text", disabled: !f.enabled })) };
    case "graphql":
      return { mode: "graphql", graphql: { query: d.graphql.query, variables: d.graphql.variables } };
    case "binary":
      return { mode: "file", file: { src: d.body } };
    default:
      return undefined;
  }
}

/** Forge assertions and captures as a Postman test script. Values compare as text, like Forge. */
export function postmanTests(assertions: Assertion[], extractions: HttpItem["extractions"]): string[] {
  const on = assertions.filter((a) => a.enabled);
  const caps = extractions.filter((e) => e.enabled && e.variable);
  if (!on.length && !caps.length) return [];
  const lines: string[] = [];
  const needsJson = on.some((a) => a.source === "jsonpath") || caps.some((c) => c.source === "jsonpath");
  if (needsJson) {
    lines.push(
      "// JSONPath subset used by Forge: $.a.b[0].c",
      "function jp(obj, path) {",
      "  return path.replace(/^\\$\\.?/, '').split(/\\.|\\[(\\d+)\\]/).filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);",
      "}",
      "let json; try { json = pm.response.json(); } catch (e) { json = undefined; }",
    );
  }
  const actual = (a: Pick<Assertion, "source" | "path">) =>
    a.source === "status" ? "pm.response.code"
    : a.source === "header" ? `pm.response.headers.get(${JSON.stringify(a.path)})`
    : a.source === "jsonpath" ? `jp(json, ${JSON.stringify(a.path || "$")})`
    : a.source === "time" ? "pm.response.responseTime"
    : a.source === "size" ? "pm.response.responseSize"
    : "pm.response.text()";
  const show = (x: string) => `(typeof ${x} === 'object' && ${x} !== null ? JSON.stringify(${x}) : String(${x}))`;
  for (const a of on) {
    const x = actual(a);
    const v = JSON.stringify(a.value);
    const name = JSON.stringify(`${a.source}${a.path ? ` ${a.path}` : ""} ${a.op} ${a.value}`.trim());
    const check =
      a.op === "eq" ? `pm.expect(${show("v")}).to.eql(${v})`
      : a.op === "neq" ? `pm.expect(${show("v")}).to.not.eql(${v})`
      : a.op === "contains" ? `pm.expect(${show("v")}).to.include(${v})`
      : a.op === "notContains" ? `pm.expect(${show("v")}).to.not.include(${v})`
      : a.op === "gt" ? `pm.expect(Number(v)).to.be.above(Number(${v}))`
      : a.op === "lt" ? `pm.expect(Number(v)).to.be.below(Number(${v}))`
      : a.op === "exists" ? "pm.expect(v).to.exist"
      : a.op === "notExists" ? "pm.expect(v == null).to.be.true"
      : `pm.expect(${show("v")}).to.match(new RegExp(${v}))`;
    lines.push(`pm.test(${name}, function () { const v = ${x}; ${check}; });`);
  }
  for (const c of caps) lines.push(`pm.environment.set(${JSON.stringify(c.variable)}, ${actual({ source: c.source, path: c.path })});`);
  return lines;
}

export function toPostman(i: ExportInput): string {
  type Folder = { name: string; item: unknown[] };
  const top: Folder = { name: i.name, item: [] };
  const folders = new Map<string, Folder>([["", top]]);
  const folderFor = (relDir: string): Folder => {
    if (folders.has(relDir)) return folders.get(relDir)!;
    const parent = folderFor(relDir.includes("/") ? relDir.slice(0, relDir.lastIndexOf("/")) : "");
    const f: Folder = { name: relDir.split("/").pop()!, item: [] };
    parent.item.push(f);
    folders.set(relDir, f);
    return f;
  };
  for (const d of httpItems(i).sort((a, b) => a.path.localeCompare(b.path))) {
    const r = rel(i.root, d.path);
    const dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
    const raw = displayUrl(d.url, d.params);
    const { base } = splitUrl(raw);
    const exec = postmanTests(d.assertions, d.extractions);
    folderFor(dir).item.push({
      name: d.name,
      request: {
        method: d.method,
        ...(d.description?.trim() ? { description: d.description.trim() } : {}),
        header: d.headers.filter((h) => h.key).map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled })),
        url: {
          raw,
          ...(d.params.length ? { query: d.params.map((p) => ({ key: p.key, value: p.value, disabled: !p.enabled })) } : {}),
          ...(pathVarNames(base).length ? { variable: pathVarNames(base).map((key) => ({ key, value: d.pathVars?.find((v) => v.key === key)?.value ?? "" })) } : {}),
        },
        auth: postmanAuth(d.auth),
        ...(postmanBody(d) ? { body: postmanBody(d) } : {}),
      },
      ...(exec.length ? { event: [{ listen: "test", script: { type: "text/javascript", exec } }] } : {}),
    });
  }
  return JSON.stringify({ info: { name: i.name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json", description: "Exported from Forge (https://forge.stellitron.com)" }, item: top.item }, null, 2);
}

/** Postman environment. Secret values are left empty unless asked for, so a shared file can't leak them. */
export function toPostmanEnv(env: Environment, includeSecretValues: boolean): string {
  const values = [
    ...env.vars.map((v: KV) => ({ key: v.key, value: v.value, enabled: v.enabled, type: "default" })),
    ...env.secrets.map((v: KV) => ({ key: v.key, value: includeSecretValues ? v.value : "", enabled: v.enabled, type: "secret" })),
  ];
  return JSON.stringify({ name: env.name, values, _postman_variable_scope: "environment" }, null, 2);
}

// ───────────────────────── OpenAPI 3.0 ─────────────────────────

const LEAD_VAR = /^\{\{\s*([\w.-]+)\s*\}\}/;

/** Splits a Forge URL into a server and an OpenAPI path with {param} placeholders. */
export function openApiLocation(url: string, vars: Record<string, string> = {}): { server: string; path: string; pathParams: string[] } {
  const { base } = splitUrl(url.trim());
  let server = "";
  let rest = base;
  const lead = base.match(LEAD_VAR);
  if (lead) {
    server = vars[lead[1]] ?? `{${lead[1]}}`;
    rest = base.slice(lead[0].length);
  } else {
    const m = base.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i);
    if (m) {
      server = m[0];
      rest = base.slice(m[0].length);
    }
  }
  const pathParams: string[] = [];
  const path = (`/${rest.replace(/^\/+/, "")}`)
    .replace(/\/:([A-Za-z_][\w-]*)/g, (_, n: string) => (pathParams.push(n), `/{${n}}`))
    .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, n: string) => (pathParams.push(n), `{${n}}`));
  return { server: server.replace(/\/+$/, ""), path: path === "/" || path.length === 1 ? "/" : path.replace(/\/+$/, ""), pathParams: [...new Set(pathParams)] };
}

const example = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const slug = (s: string) => s.replace(/[^\w]+/g, " ").trim().split(/\s+/).map((w, k) => (k ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join("") || "operation";
const SKIP_HEADERS = new Set(["authorization", "content-type", "accept", "user-agent", "content-length"]);

function securityScheme(a: Auth): [string, Record<string, unknown>] | null {
  switch (a.type) {
    case "bearer":
      return ["bearerAuth", { type: "http", scheme: "bearer" }];
    case "basic":
      return ["basicAuth", { type: "http", scheme: "basic" }];
    case "digest":
      return ["digestAuth", { type: "http", scheme: "digest" }];
    case "apikey":
      return [`apiKey_${a.key.replace(/[^\w-]/g, "_")}`, { type: "apiKey", in: a.in, name: a.key }];
    case "jwt":
      return ["bearerJwt", { type: "http", scheme: "bearer", bearerFormat: "JWT" }];
    case "oauth2": {
      const scopes = Object.fromEntries(a.scope.split(/\s+/).filter(Boolean).map((s) => [s, ""]));
      const flow =
        a.grant === "authorization_code" ? { authorizationCode: { authorizationUrl: a.authUrl, tokenUrl: a.tokenUrl, scopes } }
        : a.grant === "password" ? { password: { tokenUrl: a.tokenUrl, scopes } }
        : { clientCredentials: { tokenUrl: a.tokenUrl, scopes } };
      return [`oauth2_${a.grant}`, { type: "oauth2", flows: flow }];
    }
    default:
      return null;
  }
}

export function toOpenApi(i: ExportInput, format: "yaml" | "json"): string {
  const paths: Record<string, Record<string, unknown>> = {};
  const servers = new Set<string>();
  const schemes: Record<string, unknown> = {};
  const ids = new Set<string>();

  for (const d of httpItems(i).sort((a, b) => a.path.localeCompare(b.path))) {
    const loc = openApiLocation(d.url, i.vars);
    if (loc.server) servers.add(loc.server);
    const r = rel(i.root, d.path);
    const tag = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
    let operationId = slug(d.name);
    for (let n = 2; ids.has(operationId); n++) operationId = `${slug(d.name)}${n}`;
    ids.add(operationId);

    const parameters: Record<string, unknown>[] = [
      ...loc.pathParams.map((name) => ({ name, in: "path", required: true, schema: { type: "string" }, ...(d.pathVars?.find((v) => v.key === name)?.value && !d.pathVars!.find((v) => v.key === name)!.value.includes("{{") ? { example: d.pathVars!.find((v) => v.key === name)!.value } : {}) })),
      ...d.params.filter((p) => p.key).map((p) => ({ name: p.key, in: "query", required: false, schema: { type: "string" }, ...(p.value && !p.value.includes("{{") ? { example: p.value } : {}) })),
      ...d.headers.filter((h) => h.key && !SKIP_HEADERS.has(h.key.toLowerCase())).map((h) => ({ name: h.key, in: "header", required: false, schema: { type: "string" }, ...(h.value && !h.value.includes("{{") ? { example: h.value } : {}) })),
    ];

    let requestBody: Record<string, unknown> | undefined;
    if (d.bodyMode === "json" || d.bodyMode === "graphql") requestBody = { content: { "application/json": { example: d.bodyMode === "json" ? example(d.body) : { query: d.graphql.query, variables: example(d.graphql.variables) } } } };
    else if (d.bodyMode === "xml" || d.bodyMode === "text") requestBody = { content: { [d.bodyMode === "xml" ? "application/xml" : "text/plain"]: { example: d.body } } };
    else if (d.bodyMode === "form" || d.bodyMode === "multipart") {
      const fields = d.bodyMode === "form" ? d.form : d.multipart;
      requestBody = {
        content: {
          [d.bodyMode === "form" ? "application/x-www-form-urlencoded" : "multipart/form-data"]: {
            schema: { type: "object", properties: Object.fromEntries(fields.filter((f) => f.key).map((f) => [f.key, "file" in f && f.file ? { type: "string", format: "binary" } : { type: "string" }])) },
          },
        },
      };
    } else if (d.bodyMode === "binary") requestBody = { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } };

    const last = i.responses?.[d.path];
    const statusAssert = d.assertions.find((a) => a.enabled && a.source === "status" && a.op === "eq")?.value;
    const status = String(last?.status ?? statusAssert ?? 200);
    const ctype = last?.headers.find((h) => h.key.toLowerCase() === "content-type")?.value.split(";")[0];
    // Examples leave Forge in the spec: secrets hidden and personal data replaced with sample values.
    const parsed = last && ctype?.includes("json") ? example(last.body) : undefined;
    const sampleExample = last ? (typeof parsed === "object" && parsed !== null ? redact(parsed) : redactText(last.body.slice(0, 2000))) : undefined;
    const responses = { [status]: { description: last?.statusText || "Response", ...(last && ctype && !last.bodyBase64 ? { content: { [ctype]: { example: sampleExample } } } : {}) } };

    const sec = securityScheme(d.auth);
    if (sec) schemes[sec[0]] = sec[1];
    const op = {
      summary: d.name,
      ...(d.description?.trim() ? { description: d.description.trim() } : {}),
      operationId,
      ...(tag ? { tags: [tag] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
      ...(sec ? { security: [{ [sec[0]]: d.auth.type === "oauth2" ? d.auth.scope.split(/\s+/).filter(Boolean) : [] }] } : {}),
    };
    (paths[loc.path] ??= {})[d.method.toLowerCase()] = op;
  }

  const doc = {
    openapi: "3.0.3",
    info: { title: i.name, version: "1.0.0", description: "Exported from Forge (https://forge.stellitron.com)." },
    ...(servers.size
      ? {
          servers: [...servers].map((url) => ({
            url,
            ...([...url.matchAll(/\{([\w.-]+)\}/g)].length ? { variables: Object.fromEntries([...url.matchAll(/\{([\w.-]+)\}/g)].map((m) => [m[1], { default: "https://api.example.com", description: `Forge variable {{${m[1]}}}` }])) } : {}),
          })),
        }
      : {}),
    paths,
    ...(Object.keys(schemes).length ? { components: { securitySchemes: schemes } } : {}),
  };
  return format === "json" ? JSON.stringify(doc, null, 2) : toYaml(doc, { lineWidth: 0 });
}
