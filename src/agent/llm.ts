import Anthropic from "@anthropic-ai/sdk";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { tryJson } from "../lib/eval";
import { sendJson } from "../lib/request";
import { PROVIDER_DEFAULTS, type ProviderId, type Settings } from "../lib/store";

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

export interface LlmSession {
  next(): Promise<Turn>;
  addResults(results: ToolResult[]): void;
  addUser(text: string): void;
}

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

  async next(): Promise<Turn> {
    const fallback = FALLBACK_MODELS.has(this.model) && this.client.baseURL.includes("api.anthropic.com");
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      ...(this.tools.length ? { tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as any })) } : {}),
      messages: this.messages,
      output_config: { effort: this.effort },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
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

class OpenAICompatSession implements LlmSession {
  private messages: any[];

  constructor(
    private url: string,
    private auth: { key: string; value: string } | null,
    private model: string,
    system: string,
    private tools: ToolSpec[],
    goal: string,
  ) {
    this.messages = [
      { role: "system", content: system },
      { role: "user", content: goal },
    ];
  }

  async next(): Promise<Turn> {
    const headers = this.auth ? [{ ...this.auth, enabled: true }] : [];
    const res = await sendJson(
      "POST",
      this.url,
      {
        model: this.model,
        messages: this.messages,
        ...(this.tools.length
          ? { tools: this.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })), tool_choice: "auto" }
          : {}),
      },
      headers,
      "LLM",
    );
    const json = tryJson(res.body) as any;
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
    return {
      text: typeof msg.content === "string" ? msg.content : "",
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

  async next(): Promise<Turn> {
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
    return { text, calls, stop, usage: { input: json.usage?.inputTokens ?? 0, output: json.usage?.outputTokens ?? 0 } };
  }

  addResults(results: ToolResult[]) {
    this.pushUser(results.map((r) => ({ toolResult: { toolUseId: r.id, content: [{ text: r.content || "(empty)" }], status: r.isError ? "error" : "success" } })));
  }

  addUser(text: string) {
    this.pushUser([{ text }]);
  }
}

export function createSession(settings: Settings, system: string, tools: ToolSpec[], goal: string): LlmSession {
  const { provider, model, effort } = settings.agent;
  if (!provider) throw new Error("Choose an AI provider in Settings first.");
  const p = settings.providers[provider];
  const def = PROVIDER_DEFAULTS[provider as ProviderId];
  if (def.needsKey && !p.apiKey) throw new Error(`Add your ${def.label} API key in Settings first.`);
  if (!model) throw new Error("Choose a model in Settings.");
  if (provider === "anthropic") return new AnthropicSession(p.apiKey, p.baseUrl || def.baseUrl, model, effort, system, tools, goal);
  const base = (p.baseUrl || def.baseUrl).replace(/\/+$/, "");
  if (provider === "bedrock") return new BedrockSession(base, p.apiKey, model, system, tools, goal);
  if (provider === "azure") return new OpenAICompatSession(azureChatUrl(base), { key: "api-key", value: p.apiKey }, model, system, tools, goal);
  const auth = p.apiKey ? { key: "Authorization", value: `Bearer ${p.apiKey}` } : null;
  return new OpenAICompatSession(`${base}/chat/completions`, auth, model, system, tools, goal);
}
