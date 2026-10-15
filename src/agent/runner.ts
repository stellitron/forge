import * as A2A from "../lib/a2a";
import { interpolate, tryJson } from "../lib/eval";
import { allow, checkEgress, hostOf } from "./egress";
import { http, mcp, splitArgs, uid, type McpConfig, type RawRequest } from "../lib/ipc";
import type { Settings } from "../lib/store";
import type { A2AItem, AgentItem, Item, McpItem } from "../lib/types";
import { createSession, type ToolCall, type ToolResult, type ToolSpec } from "./llm";
import { operation, summarize } from "./openapi";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "thought"; text: string }
  | { type: "call"; id: string; name: string; input: any; request?: RawRequest }
  | { type: "result"; id: string; output: string; isError: boolean; ms: number }
  | { type: "approval"; id: string; summary: string; decide: (ok: boolean) => void }
  | { type: "finding"; severity: Severity; title: string; description: string; evidence?: string }
  | { type: "test"; name: string; passed: boolean; details: string }
  | { type: "usage"; input: number; output: number }
  | { type: "done"; summary: string }
  | { type: "error"; message: string };

const MAX_BODY = 8000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const clip = (s: string, n = MAX_BODY) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

export interface AgentContext {
  item: AgentItem;
  settings: Settings;
  vars: Record<string, string>;
  mcpItem?: Item & McpItem;
  a2aItem?: Item & A2AItem;
}

export class AgentRun {
  private stopped = false;
  private mcpId: string | null = null;
  private spec: any = null;
  private a2aEndpoint = "";
  private contextId?: string;

  constructor(
    private ctx: AgentContext,
    private emit: (e: AgentEvent) => void,
  ) {}

  stop() {
    this.stopped = true;
  }

  private tools(): ToolSpec[] {
    const { item, mcpItem, a2aItem } = this.ctx;
    const t: ToolSpec[] = [
      {
        name: "http_request",
        description:
          "Send an HTTP request and get status, headers, timing and body (body truncated to 8000 chars). " +
          "Relative URLs are resolved against the base URL. {{var}} placeholders are replaced with environment values.",
        schema: {
          type: "object",
          properties: {
            method: { type: "string", description: "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS" },
            url: { type: "string" },
            headers: { type: "object", additionalProperties: { type: "string" } },
            body: { description: "String, or a JSON value that will be serialised" },
          },
          required: ["method", "url"],
        },
      },
      {
        name: "record_test",
        description: "Record one executed test case and whether the API behaved as expected.",
        schema: {
          type: "object",
          properties: { name: { type: "string" }, passed: { type: "boolean" }, details: { type: "string" } },
          required: ["name", "passed", "details"],
        },
      },
      {
        name: "record_finding",
        description: "Record a bug, security issue, spec mismatch or notable observation, with evidence.",
        schema: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
            title: { type: "string" },
            description: { type: "string" },
            evidence: { type: "string", description: "Request/response excerpt that proves it" },
          },
          required: ["severity", "title", "description"],
        },
      },
      {
        name: "finish",
        description: "End the session with a concise summary report of coverage, results and key risks.",
        schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      },
    ];
    if (item.specUrl)
      t.push(
        { name: "openapi_overview", description: "List every operation in the OpenAPI spec.", schema: { type: "object", properties: {} } },
        {
          name: "openapi_operation",
          description: "Full definition (parameters, body schema, responses) of one operation, $refs resolved.",
          schema: { type: "object", properties: { method: { type: "string" }, path: { type: "string" } }, required: ["method", "path"] },
        },
      );
    if (mcpItem)
      t.push(
        { name: "mcp_list_tools", description: "List tools exposed by the MCP server under test.", schema: { type: "object", properties: {} } },
        {
          name: "mcp_call_tool",
          description: "Call a tool on the MCP server under test.",
          schema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] },
        },
        { name: "mcp_list_resources", description: "List resources on the MCP server.", schema: { type: "object", properties: {} } },
        {
          name: "mcp_read_resource",
          description: "Read one resource by URI.",
          schema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
        },
        { name: "mcp_list_prompts", description: "List prompts on the MCP server.", schema: { type: "object", properties: {} } },
        {
          name: "mcp_raw_request",
          description: "Send any raw JSON-RPC request to the MCP server (for protocol edge cases, invalid params, unknown methods).",
          schema: { type: "object", properties: { method: { type: "string" }, params: {} }, required: ["method"] },
        },
      );
    if (a2aItem)
      t.push(
        { name: "a2a_get_card", description: "Fetch the A2A agent card of the agent under test.", schema: { type: "object", properties: {} } },
        {
          name: "a2a_send_message",
          description: "Send a text message to the A2A agent (message/send). Reuses the conversation context unless new_context is true.",
          schema: {
            type: "object",
            properties: { text: { type: "string" }, new_context: { type: "boolean" } },
            required: ["text"],
          },
        },
        {
          name: "a2a_rpc",
          description: "Send any raw A2A JSON-RPC method (e.g. tasks/get, tasks/cancel, or invalid input).",
          schema: { type: "object", properties: { method: { type: "string" }, params: {} }, required: ["method"] },
        },
      );
    return t;
  }

  private system(): string {
    const { item, vars, mcpItem, a2aItem } = this.ctx;
    const targets = [
      item.baseUrl && `- HTTP API base URL: ${item.baseUrl}`,
      item.specUrl && `- OpenAPI spec loaded from ${item.specUrl} (use openapi_overview / openapi_operation)`,
      mcpItem && `- MCP server "${mcpItem.name}" (connected; use mcp_* tools)`,
      a2aItem && `- A2A agent "${a2aItem.name}" at ${a2aItem.url} (use a2a_* tools)`,
    ].filter(Boolean);
    const varNames = Object.keys(vars);
    return [
      "You are Forge's autonomous API test engineer. You design and execute tests against real systems using the tools provided, then report what you found.",
      "",
      "Targets:",
      ...(targets.length ? targets : ["- None configured beyond what the goal describes."]),
      "",
      varNames.length
        ? `Environment variables you can reference as {{name}} in any request (values are substituted for you and hidden from you): ${varNames.join(", ")}`
        : "No environment variables are defined.",
      "",
      "How to work:",
      "1. Discover first: read the spec / list tools / fetch the agent card before testing.",
      "2. Cover the happy path, then validation (missing/invalid/boundary inputs), auth (missing/wrong credentials), error handling, and contract conformance (status codes, response shape vs spec).",
      "3. After each meaningful check call record_test. Call record_finding for anything wrong, with concrete evidence from the actual response.",
      "4. Base every conclusion on observed responses. Never invent results.",
      "5. Avoid destructive or irreversible operations unless the goal explicitly asks for them; clean up data you create when possible.",
      "6. When you have covered the goal, call finish with a short report: what was covered, pass/fail counts, top risks.",
      `You have a budget of ${item.maxSteps} model turns.`,
    ].join("\n");
  }

  private async approve(summary: string): Promise<boolean> {
    return new Promise((resolve) => this.emit({ type: "approval", id: uid(), summary, decide: resolve }));
  }

  private async exec(call: ToolCall): Promise<{ out: string; done?: string }> {
    const { item, vars, a2aItem } = this.ctx;
    const inp = call.input ?? {};
    const sub = (s: string) => interpolate(s, vars);
    switch (call.name) {
      case "http_request": {
        const method = String(inp.method ?? "GET").toUpperCase();
        let url = sub(String(inp.url ?? ""));
        if (!/^https?:\/\//i.test(url)) url = item.baseUrl.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
        const headers = Object.entries<any>(inp.headers ?? {}).map(([key, value]) => ({ key, value: sub(String(value)), enabled: true }));
        let body: RawRequest["body"] = { type: "none" };
        if (inp.body !== undefined && inp.body !== null) {
          const content = typeof inp.body === "string" ? inp.body : JSON.stringify(inp.body);
          body = { type: "raw", content: sub(content) };
          if (!headers.some((h) => h.key.toLowerCase() === "content-type"))
            headers.push({ key: "Content-Type", value: typeof inp.body === "string" ? "text/plain" : "application/json", enabled: true });
        }
        const req: RawRequest = { method, url, headers, body, timeoutMs: 60000 };
        // Secrets may only go where the test or the saved requests already send them (see egress.ts).
        let rawUrl = String(inp.url ?? "");
        if (!/^(https?:\/\/|\{\{)/i.test(rawUrl)) rawUrl = item.baseUrl.replace(/\/+$/, "") + "/" + rawUrl.replace(/^\/+/, "");
        const verdict = checkEgress(
          { url: rawUrl, headers: Object.entries<any>(inp.headers ?? {}).map(([key, value]) => ({ key, value: String(value) })), body: body.type === "raw" ? (typeof inp.body === "string" ? inp.body : JSON.stringify(inp.body)) : undefined },
          { url, headers, body: body.type === "raw" ? body.content : undefined },
          { vars, extraHosts: [hostOf(sub(item.baseUrl)), hostOf(sub(item.specUrl))] },
        );
        if (verdict.reason) {
          if (!(await this.approve(`${method} · ${verdict.reason}`))) return { out: "The user denied this request. Do not retry it or send it another way; continue with other tests." };
          allow(verdict);
        } else if (item.approveMutations && !SAFE_METHODS.has(method) && !(await this.approve(`${method} ${inp.url}`)))
          return { out: "The user denied this request. Do not retry it; continue with other tests." };
        const res = await http.send(uid(), req, "agent");
        const hdrs = Object.fromEntries(res.headers.map((h) => [h.key, h.value]));
        return {
          out: JSON.stringify({ status: res.status, timeMs: Math.round(res.timeMs), headers: hdrs, body: clip(res.bodyBase64 ? `<binary ${res.size} bytes>` : res.body) }, null, 1),
        };
      }
      case "openapi_overview":
        return { out: clip(summarize(this.spec), 30000) };
      case "openapi_operation":
        return { out: clip(JSON.stringify(operation(this.spec, inp.method, inp.path), null, 1), 20000) };
      case "mcp_list_tools":
        return { out: clip(JSON.stringify(await mcp.request(this.mcpId!, "tools/list", {}), null, 1), 30000) };
      case "mcp_call_tool": {
        if (item.approveMutations) {
          const list = await mcp.request(this.mcpId!, "tools/list", {});
          const tool = list.result?.tools?.find((x: any) => x.name === inp.name);
          if (!tool?.annotations?.readOnlyHint && !(await this.approve(`MCP tool ${inp.name}(${JSON.stringify(inp.arguments ?? {})})`)))
            return { out: "The user denied this tool call. Do not retry it." };
        }
        const r = await mcp.request(this.mcpId!, "tools/call", { name: inp.name, arguments: inp.arguments ?? {} });
        return { out: clip(JSON.stringify(r, null, 1)) };
      }
      case "mcp_list_resources":
        return { out: clip(JSON.stringify(await mcp.request(this.mcpId!, "resources/list", {}), null, 1)) };
      case "mcp_read_resource":
        return { out: clip(JSON.stringify(await mcp.request(this.mcpId!, "resources/read", { uri: inp.uri }), null, 1)) };
      case "mcp_list_prompts":
        return { out: clip(JSON.stringify(await mcp.request(this.mcpId!, "prompts/list", {}), null, 1)) };
      case "mcp_raw_request":
        return { out: clip(JSON.stringify(await mcp.request(this.mcpId!, inp.method, inp.params), null, 1)) };
      case "a2a_get_card":
        return { out: clip(JSON.stringify((await A2A.fetchCard(a2aItem!.url, a2aItem!.headers)).card, null, 1)) };
      case "a2a_send_message": {
        if (inp.new_context) this.contextId = undefined;
        const r = await A2A.call(this.a2aEndpoint, "message/send", { message: A2A.userMessage(sub(inp.text), this.contextId) }, a2aItem!.headers);
        this.contextId = r.result?.contextId ?? this.contextId;
        return { out: clip(JSON.stringify(r, null, 1)) };
      }
      case "a2a_rpc":
        return { out: clip(JSON.stringify(await A2A.call(this.a2aEndpoint, inp.method, inp.params ?? {}, a2aItem!.headers), null, 1)) };
      case "record_test":
        this.emit({ type: "test", name: String(inp.name), passed: !!inp.passed, details: String(inp.details ?? "") });
        return { out: "recorded" };
      case "record_finding":
        this.emit({
          type: "finding",
          severity: (["critical", "high", "medium", "low", "info"].includes(inp.severity) ? inp.severity : "info") as Severity,
          title: String(inp.title),
          description: String(inp.description ?? ""),
          evidence: inp.evidence ? String(inp.evidence) : undefined,
        });
        return { out: "recorded" };
      case "finish":
        return { out: "ok", done: String(inp.summary ?? "") };
      default:
        throw new Error(`Unknown tool ${call.name}`);
    }
  }

  private async setup() {
    const { item, vars, mcpItem, a2aItem } = this.ctx;
    if (item.specUrl) {
      this.emit({ type: "status", text: `Loading OpenAPI spec ${item.specUrl}` });
      const res = await http.send(uid(), { method: "GET", url: interpolate(item.specUrl, vars), headers: [] });
      this.spec = tryJson(res.body);
      if (!this.spec?.paths) throw new Error("Spec URL did not return OpenAPI JSON (YAML specs are not supported yet).");
    }
    if (mcpItem) {
      this.emit({ type: "status", text: `Connecting to MCP server ${mcpItem.name}` });
      this.mcpId = `agent-${uid()}`;
      const sub = (s: string) => interpolate(s, vars);
      const cfg: McpConfig =
        mcpItem.transport === "stdio"
          ? { transport: "stdio", command: sub(mcpItem.command), args: splitArgs(sub(mcpItem.args)), env: mcpItem.env.map((e) => ({ ...e, value: sub(e.value) })), cwd: mcpItem.cwd || undefined }
          : { transport: mcpItem.transport, url: sub(mcpItem.url), headers: mcpItem.headers.map((h) => ({ ...h, value: sub(h.value) })) };
      await mcp.connect(this.mcpId, cfg);
    }
    if (a2aItem) {
      this.emit({ type: "status", text: `Discovering A2A agent ${a2aItem.name}` });
      const { card } = await A2A.fetchCard(a2aItem.url, a2aItem.headers);
      this.a2aEndpoint = card.url || a2aItem.url;
    }
  }

  async run() {
    const { item, settings } = this.ctx;
    let usage = { input: 0, output: 0 };
    try {
      await this.setup();
      const session = createSession(settings, this.system(), this.tools(), item.goal || "Explore and test the configured targets thoroughly.");
      this.emit({ type: "status", text: `Running with ${settings.agent.provider} · ${settings.agent.model}` });
      for (let step = 0; step < item.maxSteps; step++) {
        if (this.stopped) return this.emit({ type: "done", summary: "Stopped by user." });
        const turn = await session.next();
        usage = { input: usage.input + turn.usage.input, output: usage.output + turn.usage.output };
        this.emit({ type: "usage", ...usage });
        if (turn.note) this.emit({ type: "status", text: turn.note });
        if (turn.text.trim()) this.emit({ type: "thought", text: turn.text });
        if (!turn.calls.length) {
          if (turn.stop === "refusal") return this.emit({ type: "error", message: turn.note ?? "Model refused" });
          // Model stopped without calling finish: nudge once, then accept its text as the summary.
          if (step < item.maxSteps - 1 && !turn.text.trim()) {
            session.addUser("Continue testing, or call finish with your report.");
            continue;
          }
          return this.emit({ type: "done", summary: turn.text });
        }
        const results: ToolResult[] = [];
        let finished: string | undefined;
        for (const call of turn.calls) {
          if (this.stopped) {
            results.push({ id: call.id, content: "Stopped by user", isError: true });
            continue;
          }
          this.emit({ type: "call", id: call.id, name: call.name, input: call.input });
          const t0 = performance.now();
          try {
            const { out, done } = await this.exec(call);
            results.push({ id: call.id, content: out });
            this.emit({ type: "result", id: call.id, output: out, isError: false, ms: performance.now() - t0 });
            if (done !== undefined) finished = done;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            results.push({ id: call.id, content: msg, isError: true });
            this.emit({ type: "result", id: call.id, output: msg, isError: true, ms: performance.now() - t0 });
          }
        }
        session.addResults(results);
        if (finished !== undefined) return this.emit({ type: "done", summary: finished });
      }
      this.emit({ type: "done", summary: `Reached the ${item.maxSteps}-turn budget.` });
    } catch (e) {
      this.emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.mcpId) mcp.disconnect(this.mcpId).catch(() => {});
    }
  }
}
