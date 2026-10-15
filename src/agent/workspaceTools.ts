import { useConsole, redactHeaders } from "../lib/devconsole";
import { formatBytes, interpolate } from "../lib/eval";
import { http, uid, type RawRequest } from "../lib/ipc";
import { COLLECTIONS, useStore } from "../lib/store";
import { defaults, type HttpItem, type Item } from "../lib/types";
import { runHttp } from "../panels/HttpPanel";
import { exportResponse } from "../lib/exporter";
import { FORMATS, type Format } from "../lib/report";
import { analyze, cell, describeShape, query as runQuery, type Query } from "../lib/shape";
import type { ToolSpec } from "./llm";
import { aiCreated, allow, checkEgress, type Outgoing, oauthOutgoing } from "./egress";
import { buildRequest } from "../lib/request";

/**
 * Tools over the open workspace. The in-app Ask chat and external clients (MCP, A2A) share
 * them, so Claude in VS Code sees exactly what the chat sees, and the same approval rules apply.
 */

export interface ToolCtx {
  /** Who is asking, shown in approval prompts: "Ask", "claude-code", "cursor"… */
  client: string;
  /** `always`: ask even if the user trusted this client for the session (used for secret/host checks). */
  approve(summary: string, opts?: { always?: boolean }): Promise<boolean>;
}

export interface WorkspaceTool {
  spec: ToolSpec;
  readOnly: boolean;
  run(input: any, ctx: ToolCtx): Promise<string>;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const clip = (s: string, n = 12000) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);
const st = () => useStore.getState();
const rel = (p: string) => p.replace(new RegExp(`^${COLLECTIONS}/`), "");

function httpItem(path: string): Item & HttpItem {
  const items = st().items;
  const it = items[path] ?? items[`${COLLECTIONS}/${path}`] ?? Object.values(items).find((i) => i.name.toLowerCase() === path.toLowerCase());
  if (!it) throw new Error(`No saved request "${path}". Call list_requests to see what exists.`);
  if (it.kind !== "http") throw new Error(`"${path}" is a ${it.kind} item; only HTTP requests can be run.`);
  return it as Item & HttpItem;
}

function describeResponse(res: { status: number; statusText?: string; timeMs: number; size: number; headers: { key: string; value: string }[]; body: string; bodyBase64?: boolean }) {
  return JSON.stringify(
    {
      status: res.status,
      timeMs: Math.round(res.timeMs),
      size: formatBytes(res.size),
      headers: Object.fromEntries(redactHeaders(res.headers).map((h) => [h.key, h.value])),
      body: res.bodyBase64 ? `<binary ${formatBytes(res.size)}>` : clip(res.body),
    },
    null,
    1,
  );
}

/**
 * A request the AI shaped (ad-hoc, or saved by it this session) must not quietly carry secrets to
 * unfamiliar places. Returns true when the user was asked and said yes (so callers skip `gate`).
 * Independent of the "approve writes" setting and of trusting a client.
 */
async function guardEgress(ctx: ToolCtx, method: string, raw: Outgoing, sent: Outgoing): Promise<boolean> {
  const v = checkEgress(raw, sent, { vars: st().vars() });
  if (!v.reason) return false;
  if (!(await ctx.approve(`${method} · ${v.reason}`, { always: true })))
    throw new Error("The user declined this request in Forge. Do not retry it or send it another way; ask the user what they want.");
  allow(v);
  return true;
}

/** Saved requests the user wrote are trusted; ones the AI saved this session get the same check as ad-hoc ones. */
async function guardSaved(ctx: ToolCtx, item: Item & HttpItem): Promise<boolean> {
  if (!aiCreated.has(item.path)) return false;
  const vars = st().vars();
  const req = buildRequest(item, vars);
  const rawReq = buildRequest(item, {});
  const body = (b: RawRequest["body"]) => (b?.type === "raw" ? b.content : b ? JSON.stringify(b) : undefined);
  const asked = await guardEgress(ctx, item.method, { url: rawReq.url, headers: rawReq.headers, body: body(rawReq.body) }, { url: req.url, headers: req.headers, body: body(req.body) });
  // OAuth fetches its token from another host first, sending the client secret or a password.
  const token = oauthOutgoing(item, vars);
  const askedToken = token ? await guardEgress(ctx, "OAuth token request", token.raw, token.sent) : false;
  return asked || askedToken;
}

/** Requests that change data, or every request when the user turned approvals up, need a yes in Forge. */
async function gate(ctx: ToolCtx, method: string, what: string) {
  if (SAFE.has(method.toUpperCase())) return;
  if (st().settings.server?.approveWrites === false) return;
  if (!(await ctx.approve(what))) throw new Error("The user declined this in Forge. Don't retry it; ask them or do something else.");
}

function latestJson(path: string) {
  const item = httpItem(String(path));
  const res = st().responses[item.path]?.res;
  if (!res) throw new Error(`No response yet for "${item.name}" in this session. Call run_request first.`);
  let data: unknown;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error("That response isn't JSON.");
  }
  return { item, res, data };
}

async function ensureFolder(full: string) {
  const parts = full.split("/");
  for (let i = 2; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (!st().dirs.includes(p)) await st().createFolder(p);
  }
}

export const WORKSPACE_TOOLS: WorkspaceTool[] = [
  {
    readOnly: true,
    spec: {
      name: "list_requests",
      description: "List saved items in the open Forge workspace: path, kind, method and URL. Use the path with other tools.",
      schema: { type: "object", properties: { filter: { type: "string", description: "Optional case-insensitive text to match in name, path or URL" } } },
    },
    async run({ filter }) {
      const f = String(filter ?? "").toLowerCase();
      const rows = Object.values(st().items)
        .filter((i) => !f || `${i.path} ${i.name} ${"url" in i ? i.url : ""}`.toLowerCase().includes(f))
        .map((i) => `${rel(i.path)} | ${i.kind}${i.kind === "http" ? ` | ${i.method} ${i.url}` : "url" in i && i.url ? ` | ${i.url}` : ""}`);
      return rows.length ? `${st().root ? `Workspace ${st().root}\n` : ""}${rows.join("\n")}` : "No saved items match.";
    },
  },
  {
    readOnly: true,
    spec: {
      name: "get_request",
      description: "Read a saved item's full definition (method, URL, params, headers, auth type, body, assertions). {{name}} placeholders are environment variables.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run({ path }) {
      const items = st().items;
      const it = items[path] ?? items[`${COLLECTIONS}/${path}`];
      if (!it) throw new Error(`No item "${path}"`);
      const copy: any = structuredClone(it);
      // Literal credentials in the file stay hidden; {{placeholders}} are kept.
      if (copy.headers) copy.headers = copy.headers.map((h: any) => (/\{\{/.test(h.value) ? h : redactHeaders([h])[0]));
      if (copy.auth?.token && !/\{\{/.test(copy.auth.token)) copy.auth.token = "(set, hidden)";
      if (copy.auth?.password && !/\{\{/.test(copy.auth.password)) copy.auth.password = "(set, hidden)";
      return clip(JSON.stringify(copy, null, 1), 20000);
    },
  },
  {
    readOnly: false,
    spec: {
      name: "run_request",
      description: "Send a saved HTTP request with the active environment, run its assertions, and return the response. Requests that change data need the user's approval in Forge.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run({ path }, ctx) {
      const item = httpItem(String(path));
      if (!(await guardSaved(ctx, item))) await gate(ctx, item.method, `Run ${item.method} ${item.name} (${rel(item.path)})`);
      const out = await runHttp(item, ctx.client);
      if ("error" in out) throw new Error(String(out.error));
      const tests = out.results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.label}${r.pass ? "" : ` (got ${r.actual})`}`);
      return `${describeResponse(out.res)}${tests.length ? `\nAssertions:\n${tests.join("\n")}` : ""}`;
    },
  },
  {
    readOnly: false,
    spec: {
      name: "run_folder",
      description: "Run every saved HTTP request in a folder (in order) and report status and assertion results for each.",
      schema: { type: "object", properties: { folder: { type: "string", description: "Folder path from list_requests, e.g. 'Demo API/Users'" } }, required: ["folder"] },
    },
    async run({ folder }, ctx) {
      const prefix = `${COLLECTIONS}/${String(folder).replace(/^collections\//, "").replace(/\/$/, "")}/`;
      const items = Object.values(st().items).filter((i): i is Item & HttpItem => i.kind === "http" && i.path.startsWith(prefix));
      if (!items.length) throw new Error(`No HTTP requests under "${folder}"`);
      for (const it of items) await guardSaved(ctx, it);
      const writes = items.filter((i) => !SAFE.has(i.method.toUpperCase()));
      if (writes.length) await gate(ctx, "POST", `Run ${items.length} requests in ${folder}, including ${writes.map((w) => `${w.method} ${w.name}`).join(", ")}`);
      const lines: string[] = [];
      let passed = 0;
      for (const it of items) {
        const out = await runHttp(it, ctx.client);
        if ("error" in out) {
          lines.push(`ERROR ${it.method} ${it.name}: ${out.error}`);
          continue;
        }
        const failed = out.results.filter((r) => !r.pass);
        if (!failed.length && out.res.status < 400) passed++;
        lines.push(`${failed.length ? "FAIL" : "ok  "} ${out.res.status} ${it.method} ${it.name} · ${Math.round(out.res.timeMs)} ms${failed.length ? ` · ${failed.map((f) => f.label).join("; ")}` : ""}`);
      }
      return `${passed}/${items.length} passed\n${lines.join("\n")}`;
    },
  },
  {
    readOnly: false,
    spec: {
      name: "http_request",
      description: "Send an ad-hoc HTTP request. {{name}} placeholders are filled from the active environment (values are never shown to you). Non-GET requests need the user's approval.",
      schema: {
        type: "object",
        properties: {
          method: { type: "string" },
          url: { type: "string", description: "Absolute URL, or a path starting with {{baseUrl}}" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { description: "JSON value or string" },
        },
        required: ["method", "url"],
      },
    },
    async run(inp, ctx) {
      const vars = st().vars();
      const method = String(inp.method ?? "GET").toUpperCase();
      const url = interpolate(String(inp.url), vars);
      const headers = Object.entries<any>(inp.headers ?? {}).map(([key, value]) => ({ key, value: interpolate(String(value), vars), enabled: true }));
      let body: RawRequest["body"] = { type: "none" };
      if (inp.body !== undefined && inp.body !== null) {
        body = { type: "raw", content: interpolate(typeof inp.body === "string" ? inp.body : JSON.stringify(inp.body), vars) };
        if (!headers.some((h) => h.key.toLowerCase() === "content-type")) headers.push({ key: "Content-Type", value: typeof inp.body === "string" ? "text/plain" : "application/json", enabled: true });
      }
      const raw: Outgoing = {
        url: String(inp.url),
        headers: Object.entries<any>(inp.headers ?? {}).map(([key, value]) => ({ key, value: String(value) })),
        body: inp.body === undefined || inp.body === null ? undefined : typeof inp.body === "string" ? inp.body : JSON.stringify(inp.body),
      };
      const asked = await guardEgress(ctx, method, raw, { url, headers, body: body.type === "raw" ? body.content : undefined });
      if (!asked) await gate(ctx, method, `${method} ${inp.url}`);
      return describeResponse(await http.send(uid(), { method, url, headers, body, timeoutMs: 60000 }, ctx.client));
    },
  },
  {
    readOnly: true,
    spec: {
      name: "last_response",
      description: "The most recent response received for a saved request in this session (status, headers, body, assertion results).",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run({ path }) {
      const p = st().items[path] ? path : `${COLLECTIONS}/${path}`;
      const r = st().responses[p];
      if (!r?.res) return r?.error ? `Last attempt failed: ${r.error}` : "No response yet in this session. Use run_request.";
      const tests = (r.results ?? []).map((x) => `${x.pass ? "PASS" : "FAIL"} ${x.label}`);
      return `${describeResponse(r.res)}${tests.length ? `\nAssertions:\n${tests.join("\n")}` : ""}`;
    },
  },
  {
    readOnly: true,
    spec: {
      name: "list_environments",
      description: "List environments, which one is active, and the variable names in each (values are not exposed).",
      schema: { type: "object", properties: {} },
    },
    async run() {
      const { envs, activeEnv } = st();
      if (!envs.length) return "No environments.";
      return envs
        .map((e) => `${e.path === activeEnv ? "* " : "  "}${e.name}: ${[...e.vars.map((v) => v.key), ...e.secrets.map((v) => `${v.key} (secret)`)].join(", ") || "(empty)"}`)
        .join("\n");
    },
  },
  {
    readOnly: true,
    spec: {
      name: "recent_traffic",
      description: "Recent entries from Forge's Console: HTTP exchanges, MCP messages, WebSocket frames and errors, newest last.",
      schema: { type: "object", properties: { limit: { type: "number", description: "Default 30, max 200" }, errorsOnly: { type: "boolean" } } },
    },
    async run({ limit, errorsOnly }) {
      const n = Math.min(200, Number(limit) || 30);
      const rows = useConsole
        .getState()
        .entries.filter((e) => !errorsOnly || e.level !== "info")
        .slice(-n)
        .map((e) => `${new Date(e.ts).toISOString().slice(11, 23)} ${e.kind} ${e.source} ${e.title}${e.status !== undefined ? ` → ${e.status}` : ""}${e.ms !== undefined ? ` ${Math.round(e.ms)}ms` : ""}`);
      return rows.join("\n") || "Console is empty.";
    },
  },
  {
    readOnly: false,
    spec: {
      name: "save_request",
      description: "Save a new HTTP request into the workspace so the user can reuse it. Use {{variables}} instead of literal secrets.",
      schema: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Folder path from list_requests, e.g. 'Demo API/Users'. Created if missing." },
          name: { type: "string" },
          method: { type: "string" },
          url: { type: "string" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { description: "JSON value or string" },
        },
        required: ["folder", "name", "method", "url"],
      },
    },
    async run(inp, ctx) {
      const folder = `${COLLECTIONS}/${String(inp.folder).replace(/^collections\//, "").replace(/\/$/, "")}`;
      if (st().settings.server?.approveWrites !== false && !(await ctx.approve(`Save "${inp.name}" (${inp.method} ${inp.url}) into ${rel(folder)}`)))
        throw new Error("The user declined saving this request.");
      const d = defaults.http();
      d.method = String(inp.method).toUpperCase();
      d.url = String(inp.url);
      d.headers = Object.entries<any>(inp.headers ?? {}).map(([key, value]) => ({ key, value: String(value), enabled: true }));
      if (inp.body !== undefined && inp.body !== null) {
        d.bodyMode = typeof inp.body === "string" ? "text" : "json";
        d.body = typeof inp.body === "string" ? inp.body : JSON.stringify(inp.body, null, 2);
      }
      await ensureFolder(folder);
      const path = await st().createItem(folder, "http", String(inp.name), d);
      aiCreated.add(path);
      return `Saved as ${rel(path)}`;
    },
  },
  {
    readOnly: true,
    spec: {
      name: "response_data",
      description:
        "Structure of the latest JSON response of a saved request, computed by Forge: datasets (tables found in it), columns with types and statistics, top-level facts, and a few sample rows. Use this instead of reading large bodies.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run({ path }) {
      return clip(describeShape(analyze(latestJson(path).data)), 16000);
    },
  },
  {
    readOnly: true,
    spec: {
      name: "query_data",
      description:
        "Filter, sort, group and aggregate a dataset in the latest response, computed exactly by Forge (no estimation). Returns a Markdown table. Column keys and dataset ids come from response_data.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          dataset: { type: "string", description: "Dataset id, e.g. $.products. Default: the main one." },
          columns: { type: "array", items: { type: "string" } },
          where: { type: "array", items: { type: "object", properties: { column: { type: "string" }, op: { enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "empty", "notEmpty"] }, value: {} }, required: ["column", "op"] } },
          sort: { type: "array", items: { type: "object", properties: { column: { type: "string" }, dir: { enum: ["asc", "desc"] } }, required: ["column"] } },
          groupBy: { type: "string" },
          aggregate: { type: "object", properties: { column: { type: "string" }, fn: { enum: ["sum", "avg", "min", "max"] } }, required: ["column", "fn"] },
          limit: { type: "number", description: "Max rows returned (default 50, max 200)" },
        },
        required: ["path"],
      },
    },
    async run(inp) {
      const shape = analyze(latestJson(inp.path).data);
      const ds = shape.datasets.find((d) => d.id === inp.dataset) ?? shape.datasets[0];
      if (!ds) throw new Error("No tabular data in that response.");
      const q: Query = { columns: inp.columns, where: inp.where, sort: inp.sort, groupBy: inp.groupBy, aggregate: inp.aggregate, limit: Math.min(200, Number(inp.limit) || 50) };
      const r = runQuery(ds, q);
      const head = `| ${r.columns.join(" | ")} |\n|${r.columns.map(() => " --- ").join("|")}|`;
      const rows = r.rows.map((x) => `| ${r.columns.map((c) => cell(x[c], 60).replace(/\|/g, "\\|")).join(" | ")} |`);
      return `${ds.label}: ${r.total} matching row(s)${r.total > r.rows.length ? `, showing ${r.rows.length}` : ""}\n${head}\n${rows.join("\n")}`;
    },
  },
  {
    readOnly: false,
    spec: {
      name: "create_report",
      description:
        "Create a PDF, Word (docx), PowerPoint (pptx), Excel (xlsx), CSV or Markdown file from the latest response of a saved request. Forge builds facts, highlights, charts and tables from the data itself; you may add a short summary paragraph and choose the dataset, columns, filters, sort or grouping. Saved to the workspace's reports/ folder.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          format: { enum: FORMATS.map((f) => f.id) },
          title: { type: "string" },
          summary: { type: "string", description: "Optional 2-5 sentence summary written by you, shown as 'AI-written'. Only state things supported by response_data/query_data results." },
          dataset: { type: "string" },
          columns: { type: "array", items: { type: "string" } },
          where: { type: "array", items: { type: "object" } },
          sort: { type: "array", items: { type: "object" } },
          groupBy: { type: "string" },
          aggregate: { type: "object" },
        },
        required: ["path", "format"],
      },
    },
    async run(inp) {
      const { item, res } = latestJson(inp.path);
      const saved = await exportResponse(item.name, { method: item.method, url: item.url }, res, inp.format as Format, {
        title: inp.title,
        summary: inp.summary,
        dataset: inp.dataset,
        query: { columns: inp.columns, where: inp.where, sort: inp.sort, groupBy: inp.groupBy, aggregate: inp.aggregate },
      });
      return `Saved ${saved}`;
    },
  },
  {
    readOnly: false,
    spec: {
      name: "create_folder",
      description: "Create a collection or folder, e.g. 'Shop API' or 'Shop API/Orders'.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run({ path }) {
      const full = `${COLLECTIONS}/${String(path).replace(/^collections\//, "").replace(/^\/+|\/+$/g, "")}`;
      await ensureFolder(full);
      return `Created ${rel(full)}`;
    },
  },
  {
    readOnly: false,
    spec: {
      name: "organize",
      description:
        "Move and/or rename saved items in one go (e.g. group requests into folders by resource). The user approves the whole plan once. Folders are created as needed.",
      schema: {
        type: "object",
        properties: {
          moves: {
            type: "array",
            items: { type: "object", properties: { path: { type: "string" }, folder: { type: "string", description: "Target folder, e.g. 'Shop API/Orders'. Omit to keep." }, name: { type: "string", description: "New name. Omit to keep." } }, required: ["path"] },
          },
        },
        required: ["moves"],
      },
    },
    async run({ moves }, ctx) {
      const plan = (moves as { path: string; folder?: string; name?: string }[]).map((m) => {
        const it = st().items[m.path] ?? st().items[`${COLLECTIONS}/${m.path}`];
        if (!it) throw new Error(`No item "${m.path}"`);
        const folder = m.folder ? `${COLLECTIONS}/${m.folder.replace(/^collections\//, "").replace(/^\/+|\/+$/g, "")}` : undefined;
        return { it, folder, name: m.name?.trim() };
      });
      const lines = plan.map((p) => `• ${p.it.name}${p.name && p.name !== p.it.name ? ` → "${p.name}"` : ""}${p.folder ? ` → ${rel(p.folder)}/` : ""}`);
      if (st().settings.server?.approveWrites !== false && !(await ctx.approve(`Reorganize ${plan.length} item(s):\n${lines.join("\n")}`))) throw new Error("The user declined this reorganization.");
      let path = "";
      for (const p of plan) {
        path = p.it.path;
        const fromAi = aiCreated.delete(path);
        if (p.name && p.name !== p.it.name) path = await st().renameItem(path, p.name);
        if (p.folder) {
          await ensureFolder(p.folder);
          path = await st().moveItem(path, p.folder);
        }
        if (fromAi) aiCreated.add(path);
      }
      return `Done:\n${lines.join("\n")}`;
    },
  },
];

export async function runTool(name: string, input: any, ctx: ToolCtx): Promise<string> {
  const tool = WORKSPACE_TOOLS.find((t) => t.spec.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  return tool.run(input ?? {}, ctx);
}

/** MCP tools/list shape. */
export const mcpToolDefs = () =>
  WORKSPACE_TOOLS.map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    inputSchema: t.spec.schema,
    annotations: { readOnlyHint: t.readOnly, openWorldHint: !t.readOnly && t.spec.name !== "save_request" },
  }));
