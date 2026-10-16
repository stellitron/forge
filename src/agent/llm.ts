import Anthropic from "@anthropic-ai/sdk";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { interpolate, tryJson } from "../lib/eval";
import { uid } from "../lib/ipc";
import { sendJson } from "../lib/request";
import { sendItem } from "../lib/sendItem";
import { logConsole, useConsole } from "../lib/devconsole";
import { effectiveItem } from "../lib/inherit";
import { PROVIDER_DEFAULTS, useStore, type ProviderId, type Settings } from "../lib/store";
import type { HttpItem, Item } from "../lib/types";

/** Provider-neutral view of one model turn, so the agent loop doesn't care who's behind it. */

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export interface Turn {
  text: string;
  calls: ToolCall[];
  stop: string;
  usage: { input: number; output: number };
  note?: string; // e.g. which model actually served the turn
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export interface NextOptions {
  /** Answer text as it streams in (providers that can't stream call it once with the whole text). */
  onText?: (delta: string) => void;
  /** Short progress notes the model writes between tool calls, where the provider offers them. */
  onProgress?: (delta: string) => void;
}

export interface LlmSession {
  next(opts?: NextOptions): Promise<Turn>;
  addResults(results: ToolResult[]): void;
  addUser(text: string): void;
}

/** Long agent runs pile up tool results; older ones are replaced once the history gets big (not for Anthropic, which clears them server-side). */
export const CLEARED = "[Older tool result cleared to keep the conversation small. Call the tool again if you still need it.]";

/** Replaces all but the newest `keep` tool results once the serialized history passes `maxChars`. */
export function clearOldToolResults(messages: any[], format: "openai" | "converse", keep = 6, maxChars = 300_000): number {
  if (JSON.stringify(messages).length < maxChars) return 0;
  const slots: { get(): string; set(v: string): void }[] = [];
  for (const m of messages) {
    if (format === "openai" && m.role === "tool") slots.push({ get: () => m.content, set: (v) => (m.content = v) });
    if (format === "converse" && m.role === "user" && Array.isArray(m.content))
      for (const b of m.content) if (b.toolResult) slots.push({ get: () => b.toolResult.content?.[0]?.text ?? "", set: (v) => (b.toolResult.content = [{ text: v }]) });
  }
  let n = 0;
  for (const slot of slots.slice(0, Math.max(0, slots.length - keep))) if (slot.get() !== CLEARED) (slot.set(CLEARED), n++);
  return n;
}

/** Models that return their between-tool-call progress notes as `thinking` summaries (beta). */
const PROGRESS_MODELS = new Set(["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5"]);

// Models that accept the server-side refusal fallback ("default" routing) on the Claude API.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

class AnthropicSession implements LlmSession {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[];

  constructor(
    apiKey: string,
    baseURL: string,
    private model: string,
    private effort: Settings["agent"]["effort"],
    private system: string,
    private tools: ToolSpec[],
    goal: string,
  ) {
    // Route through Tauri's HTTP plugin so requests come from Rust, not the webview.
    this.client = new Anthropic({ apiKey, baseURL, dangerouslyAllowBrowser: true, fetch: tauriFetch as typeof fetch });
    this.messages = [{ role: "user", content: goal }];
  }

  async next(opts: NextOptions = {}): Promise<Turn> {
    const fallback = FALLBACK_MODELS.has(this.model) && this.client.baseURL.includes("api.anthropic.com");
    const progress = PROGRESS_MODELS.has(this.model) && !!opts.onProgress;
    // Streamed, so long turns don't hit HTTP timeouts and the answer appears as it's written.
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: 32000,
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      ...(this.tools.length ? { tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as any })) } : {}),
      messages: this.messages,
      output_config: { effort: this.effort },
      ...(progress ? { thinking: { type: "adaptive" as const, display: "updates" as const } } : {}),
      // Old tool results are cleared server-side (safe with preserved thinking, unlike editing
      // history here), rarely and in large batches so the prompt cache isn't rewritten every turn.
      context_management: {
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 150_000 },
            keep: { type: "tool_uses", value: 8 },
            clear_at_least: { type: "input_tokens", value: 40_000 },
            exclude_tools: ["todo_write"],
          },
        ],
      },
      betas: ["context-management-2025-06-27", ...(progress ? ["thinking-display-updates-2026-08-18"] : []), ...(fallback ? ["server-side-fallback-2026-07-01"] : [])],
      ...(fallback ? { fallbacks: "default" as const } : {}),
    });
    if (opts.onText) stream.on("text", opts.onText);
    if (progress) stream.on("thinking", (delta: string) => opts.onProgress?.(delta));
    const res = await stream.finalMessage();
    // Append the full content (thinking blocks included) so history stays append-only.
    this.messages.push({ role: "assistant", content: res.content });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const calls = res.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : []));
    let stop: string = res.stop_reason ?? "end_turn";
    let note = res.model !== this.model ? `served by ${res.model}` : undefined;
    if (stop === "refusal") note = `Model declined (${res.stop_details?.category ?? "policy"}): ${res.stop_details?.explanation ?? ""}`;
    if (stop === "max_tokens" && calls.length) stop = "tool_use";
    return { text, calls, stop, note, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
  }

  addResults(results: ToolResult[]) {
    // All results for one turn go in a single user message.
    this.messages.push({
      role: "user",
      content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
    });
  }

  addUser(text: string) {
    this.messages.push({ role: "user", content: text });
  }
}

/** Chat Completions URL for an Azure OpenAI / AI Foundry endpoint in any of its usual forms. */
export function azureChatUrl(base: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (!b) throw new Error("Set your Azure endpoint as the base URL in Settings (e.g. https://my-resource.openai.azure.com).");
  if (/\/chat\/completions/.test(b)) return b;
  if (/\/deployments\/[^/]+$/.test(b)) return `${b}/chat/completions?api-version=2024-10-21`;
  if (/\/openai$/.test(b)) b += "/v1";
  else if (!/\/openai\/v1$/.test(b)) b += "/openai/v1";
  return `${b}/chat/completions`;
}

/** Accumulates OpenAI-style streamed chunks (`data: {...}` lines) into one assistant message. */
export class OpenAIStreamAccumulator {
  content = "";
  calls: { id: string; name: string; args: string }[] = [];
  finish = "";
  usage = { input: 0, output: 0 };
  private buffer = "";

  /** Feeds raw text; calls `onText` with content deltas. */
  push(chunk: string, onText?: (d: string) => void) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const m = /^data:\s?(.*)$/.exec(line.trim());
      if (!m || m[1] === "[DONE]" || !m[1]) continue;
      const j = tryJson(m[1]) as any;
      if (!j) continue;
      if (j.usage) this.usage = { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      if (typeof d.content === "string" && d.content) {
        this.content += d.content;
        onText?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === "number" ? tc.index : this.calls.length;
        const c = (this.calls[i] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (ch.finish_reason) this.finish = ch.finish_reason;
    }
  }

  message(): { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] } {
    const calls = this.calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } }));
    return { role: "assistant", content: this.content || null, ...(calls.length ? { tool_calls: calls } : {}) };
  }
}

class OpenAICompatSession implements LlmSession {
  private messages: any[];

  constructor(
    private url: string,
    private auth: { key: string; value: string } | null,
    private model: string,
    system: string,
    private tools: ToolSpec[],
    goal: string,
    /** Gemini's OpenAI endpoint keeps thought signatures only in whole replies, so it isn't streamed. */
    private streaming = true,
  ) {
    this.messages = [
      { role: "system", content: system },
      { role: "user", content: goal },
    ];
  }

  private payload() {
    return {
      model: this.model,
      messages: this.messages,
      ...(this.tools.length ? { tools: this.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })), tool_choice: "auto" } : {}),
    };
  }

  /** Streams the reply; servers that ignore `stream` and answer with plain JSON are handled too. */
  private async streamed(opts: NextOptions): Promise<Turn> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
    if (this.auth) headers[this.auth.key] = this.auth.value;
    const entry = logConsole({ kind: "http", level: "info", source: "LLM", title: `POST ${this.url}`, status: "…" });
    const t0 = performance.now();
    const res = await tauriFetch(this.url, { method: "POST", headers, body: JSON.stringify({ ...this.payload(), stream: true, stream_options: { include_usage: true } }) });
    useConsole.getState().patch(entry, { status: res.status, ms: performance.now() - t0, level: res.status >= 400 ? "error" : "info" });
    if (res.status >= 400) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 800)}`);
    if (!/event-stream/.test(res.headers.get("content-type") ?? "") || !res.body) {
      const raw = await res.text();
      return this.fromJson(tryJson(raw), res.status, opts, raw);
    }
    const acc = new OpenAIStreamAccumulator();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc.push(dec.decode(value, { stream: true }), opts.onText);
    }
    acc.push("\n");
    const msg = acc.message();
    this.messages.push(msg);
    const calls: ToolCall[] = (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: tryJson(c.function.arguments) ?? { _unparsed: c.function.arguments } }));
    return { text: acc.content, calls, stop: calls.length ? "tool_use" : acc.finish || "stop", usage: acc.usage };
  }

  async next(opts: NextOptions = {}): Promise<Turn> {
    clearOldToolResults(this.messages, "openai");
    if (this.streaming) return this.streamed(opts);
    const headers = this.auth ? [{ ...this.auth, enabled: true }] : [];
    const res = await sendJson("POST", this.url, this.payload(), headers, "LLM");
    return this.fromJson(tryJson(res.body), res.status, opts, res.body);
  }

  private fromJson(json: any, status: number, opts: NextOptions, raw: string): Turn {
    const res = { status, body: raw };
    if (res.status >= 400 || !json?.choices?.[0]) throw new Error(`LLM HTTP ${res.status}: ${res.body.slice(0, 800)}`);
    const msg = json.choices[0].message;
    // Some providers (Gemini) may omit call ids; the tool results must still be matched up.
    (msg.tool_calls ?? []).forEach((c: any, i: number) => (c.id ||= `call_${Date.now()}_${i}`));
    // Echo the message back as received, so provider extras (reasoning, thought signatures) survive.
    this.messages.push(msg);
    const calls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
      id: c.id,
      name: c.function.name,
      input: tryJson(c.function.arguments || "{}") ?? { _unparsed: c.function.arguments },
    }));
    const text = typeof msg.content === "string" ? msg.content : "";
    if (text) opts.onText?.(text);
    return {
      text,
      calls,
      stop: calls.length ? "tool_use" : (json.choices[0].finish_reason ?? "stop"),
      usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 },
    };
  }

  addResults(results: ToolResult[]) {
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
  }

  addUser(text: string) {
    this.messages.push({ role: "user", content: text });
  }
}

/** Amazon Bedrock Converse API with a Bedrock API key (bearer token). */
class BedrockSession implements LlmSession {
  private messages: any[];

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private system: string,
    private tools: ToolSpec[],
    goal: string,
  ) {
    this.messages = [{ role: "user", content: [{ text: goal }] }];
  }

  /** Converse needs strictly alternating roles; consecutive user content is merged. */
  private pushUser(content: any[]) {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user") last.content.push(...content);
    else this.messages.push({ role: "user", content });
  }

  async next(opts: NextOptions = {}): Promise<Turn> {
    clearOldToolResults(this.messages, "converse");
    const url = `${this.baseUrl.replace(/\/+$/, "")}/model/${encodeURIComponent(this.model)}/converse`;
    const res = await sendJson(
      "POST",
      url,
      {
        messages: this.messages,
        system: [{ text: this.system }],
        inferenceConfig: { maxTokens: 8192 },
        ...(this.tools.length ? { toolConfig: { tools: this.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.schema } } })) } } : {}),
      },
      [{ key: "Authorization", value: `Bearer ${this.apiKey}`, enabled: true }],
      "LLM",
    );
    const json = tryJson(res.body) as any;
    const msg = json?.output?.message;
    if (res.status >= 400 || !msg) throw new Error(`Bedrock HTTP ${res.status}: ${(json?.message ?? res.body).slice(0, 800)}`);
    // Empty text blocks are rejected when sent back.
    msg.content = (msg.content ?? []).filter((b: any) => !("text" in b) || b.text);
    if (!msg.content.length) msg.content = [{ text: "(no text)" }];
    this.messages.push(msg);
    const text = msg.content.flatMap((b: any) => (b.text ? [b.text] : [])).join("\n");
    const calls: ToolCall[] = msg.content.flatMap((b: any) => (b.toolUse ? [{ id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input ?? {} }] : []));
    const stop = calls.length ? "tool_use" : (json.stopReason ?? "end_turn");
    if (text) opts.onText?.(text);
    return { text, calls, stop, usage: { input: json.usage?.inputTokens ?? 0, output: json.usage?.outputTokens ?? 0 } };
  }

  addResults(results: ToolResult[]) {
    this.pushUser(results.map((r) => ({ toolResult: { toolUseId: r.id, content: [{ text: r.content || "(empty)" }], status: r.isError ? "error" : "success" } })));
  }

  addUser(text: string) {
    this.pushUser([{ text }]);
  }
}

export type WireFormat = "anthropic" | "converse" | "openai";

/** Which chat API a saved request speaks, from its JSON body and then its URL. */
export function detectFormat(url: string, body: any): WireFormat {
  if (body && typeof body === "object") {
    if ("anthropic_version" in body) return "anthropic";
    if ("inferenceConfig" in body || "toolConfig" in body) return "converse";
    const first = Array.isArray(body.messages) ? body.messages[0] : undefined;
    if (Array.isArray(first?.content) && first.content[0]) return "type" in first.content[0] ? "anthropic" : "converse";
    if (first?.role === "system" || "model" in body) return "openai";
  }
  if (/\/converse(-stream)?(\?|$)/.test(url)) return "converse";
  if (/chat\/completions/.test(url)) return "openai";
  return "anthropic";
}

/** A request's body with its {{variables}} filled in, parsed (undefined if it isn't JSON). */
const requestTemplate = (item: HttpItem): any => tryJson(interpolate(item.body, useStore.getState().vars()));

export const requestFormat = (item: HttpItem): WireFormat => detectFormat(item.url, requestTemplate(item));

/** A short name for the model behind a request: the Bedrock /model/<id> or Azure /deployments/<name> segment, the body's model, or the request name. */
export function requestModelLabel(item: HttpItem & { name: string }): string {
  const m = item.url.match(/\/(?:model|deployments)\/([^/?#]+)/);
  if (m) return decodeURIComponent(m[1]);
  const body = requestTemplate(item);
  return typeof body?.model === "string" && body.model ? body.model : item.name;
}

/** Makes a saved request the AI model ("From a request" provider). */
export function linkRequestAsModel(path: string) {
  const st = useStore.getState();
  const item = st.items[path];
  if (item?.kind !== "http") return;
  st.saveSettings({ agent: { ...st.settings.agent, provider: "request", request: path, model: requestModelLabel(item) } });
  st.notify(`AI now uses ${item.name}`);
}

type Part = { text: string } | { call: ToolCall };

/** Reads an Anthropic, Converse or OpenAI-style reply; gateways often answer in a different shape than they're called with. */
export function parseReply(json: any): { parts: Part[]; stop: string; usage: Turn["usage"] } | null {
  const conv = json?.output?.message;
  if (Array.isArray(conv?.content)) {
    const parts: Part[] = conv.content.flatMap((b: any): Part[] =>
      b.toolUse ? [{ call: { id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input ?? {} } }] : typeof b.text === "string" ? [{ text: b.text }] : [],
    );
    return { parts, stop: json.stopReason ?? "end_turn", usage: { input: json.usage?.inputTokens ?? 0, output: json.usage?.outputTokens ?? 0 } };
  }
  if (Array.isArray(json?.content)) {
    const parts: Part[] = json.content.flatMap((b: any): Part[] =>
      b.type === "tool_use" ? [{ call: { id: b.id, name: b.name, input: b.input ?? {} } }] : b.type === "text" ? [{ text: b.text }] : [],
    );
    return { parts, stop: json.stop_reason ?? "end_turn", usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 } };
  }
  const msg = json?.choices?.[0]?.message;
  if (msg) {
    const parts: Part[] = [
      ...(typeof msg.content === "string" ? [{ text: msg.content }] : []),
      ...(msg.tool_calls ?? []).map((c: any, i: number) => ({
        call: { id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, input: tryJson(c.function.arguments || "{}") ?? { _unparsed: c.function.arguments } },
      })),
    ];
    return { parts, stop: json.choices[0].finish_reason ?? "stop", usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 } };
  }
  return null;
}

/**
 * Sends each turn through a saved request, keeping its URL, headers and auth (so a company
 * gateway that works in Forge works for AI too). The conversation is written in the format the
 * request's body uses, over the top of its other fields.
 */
class RequestSession implements LlmSession {
  private messages: any[] = [];

  constructor(
    private path: string,
    private system: string,
    private tools: ToolSpec[],
    goal: string,
  ) {
    this.addUser(goal);
  }

  private item(): HttpItem & Item {
    const item = useStore.getState().items[this.path];
    if (item?.kind !== "http") throw new Error(`The request used as the AI model (${this.path}) isn't in this workspace. Pick another in Settings.`);
    return item;
  }

  private format(): WireFormat {
    return requestFormat(this.item());
  }

  /** Anthropic and Converse need alternating roles, so consecutive user content is merged. */
  private pushUser(content: any[]) {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push(...content);
    else this.messages.push({ role: "user", content });
  }

  private body(fmt: WireFormat, template: any): any {
    const base = template && typeof template === "object" && !Array.isArray(template) ? { ...template } : {};
    delete base.stream; // replies are read whole
    const { tools } = this;
    if (fmt === "anthropic") {
      delete base.tools;
      return {
        ...base,
        max_tokens: Math.max(Number(base.max_tokens) || 0, 8192),
        system: this.system,
        messages: this.messages,
        ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}),
      };
    }
    if (fmt === "converse") {
      delete base.toolConfig;
      return {
        ...base,
        inferenceConfig: { ...base.inferenceConfig, maxTokens: Math.max(Number(base.inferenceConfig?.maxTokens) || 0, 8192) },
        system: [{ text: this.system }],
        messages: this.messages,
        ...(tools.length ? { toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.schema } } })) } } : {}),
      };
    }
    delete base.tools;
    delete base.tool_choice;
    // A small limit that suits a one-off test request would cut agent turns short.
    for (const k of ["max_tokens", "max_completion_tokens"]) if (k in base) base[k] = Math.max(Number(base[k]) || 0, 4096);
    return {
      ...base,
      messages: [{ role: "system", content: this.system }, ...this.messages],
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })), tool_choice: "auto" } : {}),
    };
  }

  async next(opts: NextOptions = {}): Promise<Turn> {
    const item = this.item();
    // The request's own body is the user's template, so its {{variables}} are filled in;
    // the conversation written over it is sent as is.
    const template = requestTemplate(item);
    const fmt = detectFormat(item.url, template);
    // Anthropic-format history may carry thinking bound to the exact transcript, so it isn't trimmed.
    if (fmt !== "anthropic") clearOldToolResults(this.messages, fmt);
    const raw = JSON.stringify(this.body(fmt, template));
    // Folder headers and inherited auth apply, so a gateway's auth can live on the collection.
    const { res } = await sendItem({ ...effectiveItem(item), bodyMode: "json" }, uid(), "LLM", { interactive: true, rawBody: raw, vars: () => useStore.getState().varsFor(item.path) });
    const json = tryJson(res.body) as any;
    const reply = res.status < 400 ? parseReply(json) : null;
    if (!reply) throw new Error(`${item.name} HTTP ${res.status}: ${(json?.message ?? json?.error?.message ?? res.body).toString().slice(0, 800)}`);

    const text = reply.parts.flatMap((p) => ("text" in p && p.text ? [p.text] : [])).join("\n");
    const calls = reply.parts.flatMap((p) => ("call" in p ? [p.call] : []));
    // History is kept in the request's format; empty text blocks are rejected when sent back.
    if (fmt === "anthropic") {
      const content = [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))];
      this.messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no text)" }] });
    } else if (fmt === "converse") {
      const content = [...(text ? [{ text }] : []), ...calls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.input } }))];
      this.messages.push({ role: "assistant", content: content.length ? content : [{ text: "(no text)" }] });
    } else {
      this.messages.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
      });
    }
    if (text) opts.onText?.(text);
    return { text, calls, stop: calls.length ? "tool_use" : reply.stop, usage: reply.usage };
  }

  addResults(results: ToolResult[]) {
    const fmt = this.format();
    if (fmt === "anthropic") this.pushUser(results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content || "(empty)", is_error: r.isError })));
    else if (fmt === "converse") this.pushUser(results.map((r) => ({ toolResult: { toolUseId: r.id, content: [{ text: r.content || "(empty)" }], status: r.isError ? "error" : "success" } })));
    else for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
  }

  addUser(text: string) {
    const fmt = this.format();
    if (fmt === "anthropic") this.pushUser([{ type: "text", text }]);
    else if (fmt === "converse") this.pushUser([{ text }]);
    else this.messages.push({ role: "user", content: text });
  }
}

/** `effort` overrides the configured level for this session (sub-agents run lighter). */
export function createSession(settings: Settings, system: string, tools: ToolSpec[], goal: string, opts: { effort?: Settings["agent"]["effort"] } = {}): LlmSession {
  const { provider, model } = settings.agent;
  const effort = opts.effort ?? settings.agent.effort;
  if (!provider) throw new Error("Choose an AI provider in Settings first.");
  if (provider === "request") {
    if (!settings.agent.request) throw new Error("Pick a request to use as the AI model in Settings.");
    return new RequestSession(settings.agent.request, system, tools, goal);
  }
  const p = settings.providers[provider];
  const def = PROVIDER_DEFAULTS[provider as ProviderId];
  if (def.needsKey && !p.apiKey) throw new Error(`Add your ${def.label} API key in Settings first.`);
  if (!model) throw new Error("Choose a model in Settings.");
  if (provider === "anthropic") return new AnthropicSession(p.apiKey, p.baseUrl || def.baseUrl, model, effort, system, tools, goal);
  const base = (p.baseUrl || def.baseUrl).replace(/\/+$/, "");
  if (provider === "bedrock") return new BedrockSession(base, p.apiKey, model, system, tools, goal);
  if (provider === "azure") return new OpenAICompatSession(azureChatUrl(base), { key: "api-key", value: p.apiKey }, model, system, tools, goal);
  const auth = p.apiKey ? { key: "Authorization", value: `Bearer ${p.apiKey}` } : null;
  return new OpenAICompatSession(`${base}/chat/completions`, auth, model, system, tools, goal, provider !== "gemini");
}
