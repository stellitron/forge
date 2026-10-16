import { secretValues } from "./egress";
import type { Outgoing } from "./egress";
import type { ToolCtx, WorkspaceTool } from "./workspaceTools";
import { headerDiff, jsonDiff, lineDiff } from "../lib/diff";
import { tryJson } from "../lib/eval";
import { exampleFromResponse, uniqueExampleName, STATUS_TEXT } from "../lib/examples";
import { loadSchema } from "../lib/graphqlSchema";
import { historyOf, maskEntry, useHistory } from "../lib/history";
import { importAny } from "../lib/importAny";
import { http, uid } from "../lib/ipc";
import { mockRoutes, startMock, stopMock, useMocks } from "../lib/mock";
import { saveCollections, safeName } from "../lib/saveImport";
import { COLLECTIONS, slug, useStore } from "../lib/store";
import { emptyFolder, kv, type Assertion, type Auth, type FolderSettings, type HttpItem, type HttpResponse, type Item, type KV } from "../lib/types";

/**
 * Tools that let the assistant do the work a person would do in the UI: edit requests and folder
 * settings, set variables, save examples, run the mock server, read history, compare responses,
 * import collections and load GraphQL schemas. Every change goes through the user's approval, and
 * what the AI changes stops vouching for its hosts (see trust.ts).
 */

export interface Helpers {
  httpItem(path: string): Item & HttpItem;
  ensureFolder(full: string): Promise<void>;
  guardEgress(ctx: ToolCtx, method: string, raw: Outgoing, sent: Outgoing): Promise<boolean>;
  guardSaved(ctx: ToolCtx, item: Item & HttpItem): Promise<boolean>;
  rel(p: string): string;
  clip(s: string, n?: number): string;
}

const st = () => useStore.getState();
const AUTH_TYPES = ["inherit", "none", "bearer", "basic", "apikey", "oauth2", "awsv4", "digest", "hawk", "jwt"];
const SOURCES = ["status", "header", "jsonpath", "body", "time", "size"];
const OPS = ["eq", "neq", "contains", "notContains", "gt", "lt", "exists", "notExists", "matches"];
const BODY_MODES = ["none", "json", "text", "xml", "form", "multipart", "graphql", "binary"];

const kvList = (v: unknown, what: string): KV[] => {
  if (!Array.isArray(v)) throw new Error(`${what} must be a list of { key, value, enabled? }`);
  return v.map((x: any) => kv(String(x?.key ?? ""), String(x?.value ?? ""), x?.enabled !== false));
};

/** A typed-in credential would be saved into a committed file. */
const literalSecret = (s: unknown) => typeof s === "string" && s.trim().length >= 6 && !s.includes("{{");

function checkAuth(a: any): Auth {
  if (!a || !AUTH_TYPES.includes(a.type)) throw new Error(`auth.type must be one of ${AUTH_TYPES.join(", ")}`);
  for (const k of ["token", "password", "secret", "secretKey", "clientSecret", "value", "key"].filter((k) => k in a))
    if (literalSecret(a[k]) && !(a.type === "apikey" && k === "key") && !(a.type === "hawk" && k === "id"))
      throw new Error(`auth.${k} looks like a literal secret. Put the value in a variable with set_variable (secret: true) and use {{name}} here.`);
  return a as Auth;
}

const checkAssertions = (v: unknown): Assertion[] =>
  kvSafe(v, "assertions").map((a: any) => {
    if (!SOURCES.includes(a.source)) throw new Error(`assertion source must be one of ${SOURCES.join(", ")}`);
    if (!OPS.includes(a.op)) throw new Error(`assertion op must be one of ${OPS.join(", ")}`);
    return { enabled: a.enabled !== false, source: a.source, path: String(a.path ?? ""), op: a.op, value: String(a.value ?? "") };
  });

function kvSafe(v: unknown, what: string): any[] {
  if (!Array.isArray(v)) throw new Error(`${what} must be a list`);
  return v;
}

const folderPath = (p: string) => `${COLLECTIONS}/${String(p).replace(/^collections\//, "").replace(/^\/+|\/+$/g, "")}`;

async function approve(ctx: ToolCtx, summary: string) {
  if (st().settings.server?.approveWrites === false) return;
  if (!(await ctx.approve(summary))) throw new Error("The user declined this in Forge. Don't retry it; ask them what they want instead.");
}

export function moreTools(h: Helpers): WorkspaceTool[] {
  return [
    {
      readOnly: false,
      spec: {
        name: "update_request",
        description:
          "Change a saved HTTP request. Pass only the fields to change in `set`; lists (headers, params, assertions, extractions) replace the whole list, so read the request with get_request first. Use {{variables}} for anything secret. The user approves the change.",
        schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            set: {
              type: "object",
              properties: {
                name: { type: "string" },
                method: { type: "string" },
                url: { type: "string" },
                params: { type: "array", items: { type: "object" }, description: "[{ key, value, enabled? }]" },
                headers: { type: "array", items: { type: "object" }, description: "[{ key, value, enabled? }]" },
                auth: { type: "object", description: `{ type: ${AUTH_TYPES.join("|")}, ...fields }; "inherit" uses the folder's auth` },
                bodyMode: { type: "string", enum: BODY_MODES },
                body: { type: "string", description: "Raw body text (JSON as a string for json mode)" },
                graphql: { type: "object", properties: { query: { type: "string" }, variables: { type: "string" } } },
                assertions: { type: "array", items: { type: "object" }, description: `[{ source: ${SOURCES.join("|")}, path, op: ${OPS.join("|")}, value }]` },
                extractions: { type: "array", items: { type: "object" }, description: "[{ variable, source: jsonpath|header, path }]" },
                preScript: { type: "string", description: "JavaScript run before sending (Postman pm API)" },
                postScript: { type: "string", description: "JavaScript run after the response (pm.test, pm.expect…)" },
                description: { type: "string", description: "Markdown docs for the request" },
              },
            },
          },
          required: ["path", "set"],
        },
      },
      async run({ path, set }, ctx) {
        const item = h.httpItem(String(path));
        const s = set ?? {};
        const patch: Partial<HttpItem> = {};
        if (s.method) patch.method = String(s.method).toUpperCase();
        if (s.url !== undefined) patch.url = String(s.url);
        if (s.params) patch.params = kvList(s.params, "params");
        if (s.headers) {
          patch.headers = kvList(s.headers, "headers");
          const lit = patch.headers.find((x) => /^(authorization|cookie|x-api-key|api-key)$/i.test(x.key) && literalSecret(x.value));
          if (lit) throw new Error(`${lit.key} looks like a literal secret. Use a {{variable}} (set_variable with secret: true).`);
        }
        if (s.auth) patch.auth = checkAuth(s.auth);
        if (s.bodyMode) {
          if (!BODY_MODES.includes(s.bodyMode)) throw new Error(`bodyMode must be one of ${BODY_MODES.join(", ")}`);
          patch.bodyMode = s.bodyMode;
        }
        if (s.body !== undefined) patch.body = typeof s.body === "string" ? s.body : JSON.stringify(s.body, null, 2);
        if (s.graphql) patch.graphql = { query: String(s.graphql.query ?? item.graphql.query), variables: String(s.graphql.variables ?? item.graphql.variables) };
        if (s.assertions) patch.assertions = checkAssertions(s.assertions);
        if (s.extractions) patch.extractions = kvSafe(s.extractions, "extractions").map((x: any) => ({ enabled: x.enabled !== false, variable: String(x.variable ?? ""), source: x.source === "header" ? "header" : "jsonpath", path: String(x.path ?? "") }));
        for (const k of ["preScript", "postScript", "description"] as const) if (typeof s[k] === "string") patch[k] = s[k];
        const fields = [...Object.keys(patch), ...(s.name ? ["name"] : [])];
        if (!fields.length) throw new Error("Nothing to change: pass fields in `set`.");
        await approve(ctx, `Change ${fields.join(", ")} of "${item.name}" (${h.rel(item.path)})`);
        // An AI edit: the request stops vouching for its host until the user edits or trusts it.
        st().updateItem(item.path, patch, { trusted: false });
        let p = item.path;
        if (s.name && s.name !== item.name) p = await st().renameItem(p, String(s.name));
        return `Updated ${fields.join(", ")} of ${h.rel(p)}.`;
      },
    },
    {
      readOnly: false,
      spec: {
        name: "delete_items",
        description: "Delete saved items (requests, MCP servers…). Always asks the user first. Prefer organize to move things.",
        schema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
      },
      async run({ paths }, ctx) {
        const items = (paths as string[]).map((p) => st().items[p] ?? st().items[`${COLLECTIONS}/${p}`]).filter(Boolean) as Item[];
        if (!items.length) throw new Error("None of those paths exist. Call list_requests.");
        // Deleting is never covered by "don't ask for writes".
        if (!(await ctx.approve(`Delete ${items.length} item(s):\n${items.map((i) => `• ${h.rel(i.path)}`).join("\n")}`, { always: true }))) throw new Error("The user declined deleting these.");
        for (const it of items) await st().deleteItem(it.path);
        return `Deleted ${items.length} item(s).`;
      },
    },
    {
      readOnly: false,
      spec: {
        name: "folder_settings",
        description:
          "Read or change what a collection or folder passes to every request inside: auth, headers, variables and scripts. Without `set` it returns the current settings. Requests whose auth is 'inherit' use the folder's auth. Variables are committed with the collection; keep secrets in environments.",
        schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Folder path, e.g. 'Shop API' or 'Shop API/Orders'" },
            set: {
              type: "object",
              properties: {
                auth: { type: "object" },
                headers: { type: "array", items: { type: "object" } },
                vars: { type: "array", items: { type: "object" }, description: "[{ key, value }]; no secrets" },
                preScript: { type: "string" },
                postScript: { type: "string" },
              },
            },
          },
          required: ["path"],
        },
      },
      async run({ path, set }, ctx) {
        const full = folderPath(path);
        if (!st().dirs.includes(full)) throw new Error(`No folder "${path}". Call list_requests to see folders.`);
        const cur = st().folders[full] ?? emptyFolder();
        if (!set) return JSON.stringify(cur, null, 1);
        const next: FolderSettings = { ...cur };
        if (set.auth) next.auth = checkAuth(set.auth);
        if (set.headers) next.headers = kvList(set.headers, "headers");
        if (set.vars) {
          next.vars = kvList(set.vars, "vars");
          const bad = next.vars.find((v) => /token|secret|password|key/i.test(v.key) && literalSecret(v.value));
          if (bad) throw new Error(`"${bad.key}" looks secret. Folder variables are committed; put it in an environment with set_variable (secret: true).`);
        }
        for (const k of ["preScript", "postScript"] as const) if (typeof set[k] === "string") next[k] = set[k];
        await approve(ctx, `Change ${Object.keys(set).join(", ")} in the settings of ${h.rel(full)}`);
        await st().saveFolder(full, next, { trusted: false });
        return `Updated the settings of ${h.rel(full)}.`;
      },
    },
    {
      readOnly: false,
      spec: {
        name: "set_variable",
        description:
          "Set a variable in the active environment (or a named one). secret: true keeps it in the gitignored local file; use that for tokens, passwords and keys. You never get variable values back.",
        schema: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "string" }, secret: { type: "boolean" }, environment: { type: "string", description: "Environment name; default the active one" } },
          required: ["name", "value"],
        },
      },
      async run({ name, value, secret, environment }, ctx) {
        const key = String(name).trim();
        if (!/^[\w.-]+$/.test(key)) throw new Error("Variable names use letters, digits, _ . and -");
        const s = st();
        let env = environment ? s.envs.find((e) => e.name.toLowerCase() === String(environment).toLowerCase()) : s.envs.find((e) => e.path === s.activeEnv);
        if (environment && !env) throw new Error(`No environment "${environment}".`);
        const isSecret = !!secret || /token|secret|password|passwd|apikey|api_key|credential|cookie/i.test(key);
        await approve(ctx, `Set {{${key}}}${isSecret ? " (secret, kept out of git)" : ` = ${String(value).slice(0, 120)}`} in ${env?.name ?? "a new Local environment"}`);
        if (!env) {
          await s.createEnv("Local", isSecret ? [] : [kv(key, String(value))], isSecret ? [kv(key, String(value))] : [], { trusted: false });
          return `Created the Local environment with {{${key}}}.`;
        }
        const list = isSecret ? "secrets" : "vars";
        const other = isSecret ? "vars" : "secrets";
        env = { ...env, [list]: [...env[list].filter((v) => v.key !== key), kv(key, String(value))], [other]: env[other].filter((v) => v.key !== key) };
        // Not passed as trusted: a URL the AI put in a variable doesn't count as one of the user's hosts.
        await s.saveEnv(env);
        return `Set {{${key}}}${isSecret ? " as a secret" : ""} in ${env.name}.`;
      },
    },
    {
      readOnly: false,
      spec: {
        name: "save_example",
        description: "Save a request's latest response as an example (shown in docs, served by the mock server). Secret values become {{placeholders}}.",
        schema: { type: "object", properties: { path: { type: "string" }, name: { type: "string" } }, required: ["path"] },
      },
      async run({ path, name }, ctx) {
        const item = h.httpItem(String(path));
        const res = st().responses[item.path]?.res;
        if (!res) throw new Error("No response yet for this request in this session. Run it first.");
        const ex = exampleFromResponse(res, uniqueExampleName(String(name || `${res.status} ${res.statusText || STATUS_TEXT[res.status] || ""}`).trim(), item.examples), secretValues());
        await approve(ctx, `Save the ${res.status} response of "${item.name}" as example "${ex.name}"`);
        st().updateItem(item.path, { examples: [...(item.examples ?? []), ex] });
        return `Saved example "${ex.name}" on ${h.rel(item.path)}.`;
      },
    },
    {
      readOnly: false,
      spec: {
        name: "mock_server",
        description:
          "Start, stop or check the local mock server for a folder. It serves each request's saved examples on 127.0.0.1 so a frontend can be built before the backend exists. Requests without examples answer 501.",
        schema: { type: "object", properties: { folder: { type: "string" }, action: { type: "string", enum: ["start", "stop", "status"] }, port: { type: "number" } }, required: ["folder", "action"] },
      },
      async run({ folder, action, port }, ctx) {
        const full = folderPath(folder);
        if (!st().dirs.includes(full)) throw new Error(`No folder "${folder}".`);
        const routes = mockRoutes(Object.values(st().items), full);
        const summary = routes.map((r) => `${r.method} ${r.path} · ${r.examples.length ? r.examples.map((e) => `${e.status} ${e.name}`).join(", ") : "no examples (501)"}`).join("\n");
        if (action === "stop") return (await stopMock(full), `Stopped the mock for ${h.rel(full)}.`);
        if (action === "status") {
          const url = useMocks.getState().running[full];
          return `${url ? `Running at ${url}` : "Not running"}.\nRoutes:\n${summary || "(none)"}`;
        }
        await approve(ctx, `Start a mock server for ${h.rel(full)} (${routes.length} routes) on this computer`);
        const url = await startMock(full, Number(port) || 4010);
        return `Mock running at ${url}. Clients choose a response with "Prefer: example=Name" or "Prefer: code=404".\nRoutes:\n${summary || "(none)"}`;
      },
    },
    {
      readOnly: true,
      spec: {
        name: "history",
        description: "Recent sends, newest first, optionally for one saved request: id, time, environment, status, duration. Use an id with compare_responses.",
        schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } },
      },
      async run({ path, limit }) {
        const item = path ? h.httpItem(String(path)) : undefined;
        const list = (item ? historyOf(item.path) : useHistory.getState().entries).slice(0, Math.min(100, Number(limit) || 20));
        if (!list.length) return "No history yet.";
        return list.map((e) => `${e.id} · ${new Date(e.ts).toISOString().slice(0, 19).replace("T", " ")} · ${e.env ?? "no env"} · ${e.req.method} ${e.name} · ${e.res ? `${e.res.status} in ${Math.round(e.res.timeMs)} ms` : `error: ${e.error}`}`).join("\n");
      },
    },
    {
      readOnly: true,
      spec: {
        name: "compare_responses",
        description:
          "What changed between a request's latest response and an earlier one from history (by default the previous send; pass a history id, e.g. a send made with another environment). JSON is compared field by field.",
        schema: { type: "object", properties: { path: { type: "string" }, baseline: { type: "string", description: "History id from the history tool" } }, required: ["path"] },
      },
      async run({ path, baseline }) {
        const item = h.httpItem(String(path));
        const r = st().responses[item.path];
        if (!r?.res) throw new Error("No response yet for this request in this session. Run it first.");
        const earlier = historyOf(item.path).filter((e) => e.id !== r.historyId);
        const base = baseline ? earlier.find((e) => e.id === baseline) : earlier[0];
        if (!base?.res) throw new Error(baseline ? `No history entry ${baseline} with a response for this request.` : "There's no earlier response to compare with. Send it again later, or with another environment.");
        const now = maskEntry({ id: "", ts: 0, name: "", source: "", req: { method: "", url: "", headers: [] }, res: r.res }, secretValues()).res as HttpResponse;
        const lines = [`Status ${base.res.status} → ${now.status} · time ${Math.round(base.res.timeMs)} → ${Math.round(now.timeMs)} ms · baseline ${base.env ?? "no env"} at ${new Date(base.ts).toISOString().slice(0, 19)}`];
        const a = tryJson(base.res.body);
        const b = tryJson(now.body);
        if (a !== undefined && b !== undefined && typeof a === "object" && typeof b === "object") {
          const d = jsonDiff(a, b, 60);
          lines.push(d.changes.length ? `${d.changes.length}${d.more ? "+" : ""} body changes:` : "Body: no differences.");
          for (const c of d.changes) lines.push(`${c.kind === "added" ? "+" : c.kind === "removed" ? "-" : "~"} ${c.path}${c.kind === "changed" ? `: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}` : `: ${JSON.stringify(c.kind === "added" ? c.after : c.before)}`}`.slice(0, 300));
        } else {
          const ops = lineDiff(base.res.body.split("\n"), now.body.split("\n"));
          lines.push(ops ? `Body: ${ops.filter((o) => o.op === "add").length} lines added, ${ops.filter((o) => o.op === "del").length} removed.` : "Body: too different to compare line by line.");
        }
        const hd = headerDiff(base.res.headers, now.headers);
        lines.push(hd.length ? `Header changes: ${hd.map((c) => `${c.kind} ${c.path}`).join(", ")}` : "Headers: no differences (ignoring ones that always change).");
        return h.clip(lines.join("\n"), 12000);
      },
    },
    {
      readOnly: false,
      spec: {
        name: "import_collection",
        description:
          "Import a Postman, Insomnia, Bruno, OpenAPI/Swagger, HAR or cURL document into a new collection, from text or a URL (e.g. an OpenAPI spec URL). Imports start untrusted. The user approves.",
        schema: { type: "object", properties: { content: { type: "string" }, url: { type: "string" }, name: { type: "string", description: "Collection name if the document has none" } } },
      },
      async run({ content, url, name }, ctx) {
        let text = typeof content === "string" ? content : "";
        if (!text && url) {
          const target = String(url);
          const raw: Outgoing = { url: target, headers: [] };
          const asked = await h.guardEgress(ctx, "GET", raw, raw);
          if (!asked) await approve(ctx, `Download ${target} to import it`);
          const res = await http.send(uid(), { method: "GET", url: target, headers: [{ key: "Accept", value: "application/json, application/yaml, text/yaml, */*", enabled: true }], timeoutMs: 60000 }, ctx.client);
          if (res.status >= 400) throw new Error(`Downloading failed: HTTP ${res.status}`);
          text = res.body;
        }
        if (!text.trim()) throw new Error("Pass the document as `content`, or a `url` to download it from.");
        const result = importAny([{ path: name ? `${safeName(String(name))}.json` : "pasted", content: text }]);
        const reqs = result.collections.reduce((n, c) => n + c.items.length, 0);
        await approve(ctx, `Import ${reqs} request(s) into ${result.collections.map((c) => c.name).join(", ")}${result.envs.length ? ` and ${result.envs.length} environment(s)` : ""}`);
        const { n, bases } = await saveCollections(result, { untrusted: true });
        for (const e of result.envs) await st().createEnv(safeName(e.name), e.vars, e.secrets, { trusted: false }).catch(() => {});
        return `Imported ${n} request(s) into ${bases.map((b) => b.name).join(", ")}.${result.skipped.length ? ` Skipped: ${result.skipped.slice(0, 5).join("; ")}` : ""} They aren't trusted yet; the user can trust them from the sidebar.`;
      },
    },
    {
      readOnly: false,
      spec: {
        name: "graphql_schema",
        description: "Load a GraphQL endpoint's schema by introspection (with the request's auth) and list its query and mutation fields with arguments and return types.",
        schema: { type: "object", properties: { path: { type: "string", description: "A saved GraphQL request" }, filter: { type: "string", description: "Only fields whose name contains this" } }, required: ["path"] },
      },
      async run({ path, filter }, ctx) {
        const item = h.httpItem(String(path));
        await h.guardSaved(ctx, item);
        const state = await loadSchema(item);
        if (!state.schema) throw new Error(state.error ?? "Couldn't load the schema.");
        const q = String(filter ?? "").toLowerCase();
        const out: string[] = [`${state.types} types.`];
        for (const [label, type] of [["Query", state.schema.getQueryType()], ["Mutation", state.schema.getMutationType()], ["Subscription", state.schema.getSubscriptionType()]] as const) {
          if (!type) continue;
          const fields = Object.values(type.getFields()).filter((f) => !q || f.name.toLowerCase().includes(q));
          if (!fields.length) continue;
          out.push(`${label}:`);
          for (const f of fields) out.push(`  ${f.name}${f.args.length ? `(${f.args.map((a) => `${a.name}: ${a.type}`).join(", ")})` : ""}: ${f.type}`);
        }
        return h.clip(out.join("\n"), 14000);
      },
    },
  ];
}

export const _test = { checkAuth, checkAssertions, slug };
