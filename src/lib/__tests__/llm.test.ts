// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { url: string; body: any; headers: { key: string; value: string }[] }[] = [];
let replies: any[] = [];
vi.mock("../request", () => ({
  sendJson: async (_m: string, url: string, body: any, headers: any[]) => {
    calls.push({ url, body: structuredClone(body), headers });
    const r = replies.shift();
    return { status: r.status ?? 200, body: JSON.stringify(r.json) };
  },
}));
// Streaming providers call fetch directly. A reply with `sse` answers as a stream (split into
// awkward chunks); otherwise as plain JSON, like servers that ignore `stream`.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const headers = Object.entries(init.headers)
      .filter(([k]) => !/^(content-type|accept)$/i.test(k))
      .map(([key, value]) => ({ key, value, enabled: true }));
    calls.push({ url, body: JSON.parse(init.body), headers });
    const r = replies.shift();
    if (r.sse) {
      const text = r.sse.map((e: unknown) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
      const chunks = text.match(/[\s\S]{1,7}/g) ?? [];
      const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  },
}));
const itemSends: { item: any; rawBody?: string }[] = [];
vi.mock("../sendItem", () => ({
  sendItem: async (item: any, _id: string, _src: string, opts: { rawBody?: string }) => {
    itemSends.push({ item, rawBody: opts.rawBody });
    const r = replies.shift();
    return { req: {}, res: { status: r.status ?? 200, body: JSON.stringify(r.json) } };
  },
}));
vi.mock("../ipc", () => ({ fs: {}, http: {}, uid: () => "x" }));

import { CLEARED, azureChatUrl, clearOldToolResults, createSession, detectFormat, requestModelLabel } from "../../agent/llm";
import { useStore, type ProviderId, type Settings } from "../store";
import { defaults } from "../types";

const tool = { name: "list_requests", description: "List", schema: { type: "object", properties: {} } };
const settings = (provider: ProviderId, model: string, baseUrl = ""): Settings =>
  ({ providers: { [provider]: { apiKey: "KEY", baseUrl } }, agent: { provider, model, effort: "high" } }) as any;

beforeEach(() => ((calls.length = 0), (itemSends.length = 0), (replies = [])));

describe("providers", () => {
  it("Bedrock speaks Converse, with tool round-trips and alternating roles", async () => {
    replies = [
      { json: { output: { message: { role: "assistant", content: [{ text: "" }, { toolUse: { toolUseId: "t1", name: "list_requests", input: {} } }] } }, stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } } },
      { json: { output: { message: { role: "assistant", content: [{ text: "You have 2 requests." }] } }, stopReason: "end_turn" } },
    ];
    const s = createSession(settings("bedrock", "us.anthropic.claude-x:0", "https://bedrock-runtime.eu-west-1.amazonaws.com/"), "SYS", [tool], "hi");
    const t1 = await s.next();
    expect(calls[0].url).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com/model/us.anthropic.claude-x%3A0/converse");
    expect(calls[0].headers).toContainEqual(expect.objectContaining({ key: "Authorization", value: "Bearer KEY" }));
    expect(calls[0].body.system).toEqual([{ text: "SYS" }]);
    expect(calls[0].body.toolConfig.tools[0].toolSpec.inputSchema.json).toEqual(tool.schema);
    expect(t1.calls).toEqual([{ id: "t1", name: "list_requests", input: {} }]);
    expect(t1.usage).toEqual({ input: 10, output: 5 });
    s.addResults([{ id: "t1", content: "" }]);
    s.addUser("also this");
    const t2 = await s.next();
    const msgs = calls[1].body.messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toEqual([{ toolUse: { toolUseId: "t1", name: "list_requests", input: {} } }]); // empty text dropped
    expect(msgs[2].content[0]).toEqual({ toolResult: { toolUseId: "t1", content: [{ text: "(empty)" }], status: "success" } });
    expect(msgs[2].content[1]).toEqual({ text: "also this" });
    expect(t2).toMatchObject({ text: "You have 2 requests.", stop: "end_turn", calls: [] });
  });

  it("Bedrock errors are readable", async () => {
    replies = [{ status: 403, json: { message: "Authentication failed: invalid API key" } }];
    await expect(createSession(settings("bedrock", "m", "https://bedrock-runtime.us-east-1.amazonaws.com"), "S", [], "hi").next()).rejects.toThrow(/403.*invalid API key/);
  });

  it.each([
    ["https://res.openai.azure.com", "https://res.openai.azure.com/openai/v1/chat/completions"],
    ["https://res.openai.azure.com/openai", "https://res.openai.azure.com/openai/v1/chat/completions"],
    ["https://res.services.ai.azure.com/openai/v1/", "https://res.services.ai.azure.com/openai/v1/chat/completions"],
    ["https://res.openai.azure.com/openai/deployments/gpt", "https://res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21"],
  ])("Azure endpoint %s", (base, want) => expect(azureChatUrl(base)).toBe(want));

  it("Azure sends the key as api-key and the deployment as model", async () => {
    replies = [{ json: { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] } }];
    await createSession(settings("azure", "my-gpt", "https://res.openai.azure.com"), "S", [], "hi").next();
    expect(calls[0].headers).toEqual([{ key: "api-key", value: "KEY", enabled: true }]);
    expect(calls[0].body.model).toBe("my-gpt");
    expect(calls[0].body.tools).toBeUndefined();
  });

  it("streams OpenAI-style replies, including tool calls whose arguments arrive in pieces", async () => {
    replies = [
      {
        sse: [
          { choices: [{ delta: { role: "assistant", content: "Let me " } }] },
          { choices: [{ delta: { content: "check." } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "list_requests", arguments: '{"fil' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ter":"user"}' } }, { index: 1, id: "c2", function: { name: "list_environments", arguments: "{}" } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
          "[DONE]",
        ],
      },
      { sse: [{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }, "[DONE]"] },
    ];
    const s = createSession(settings("openai", "gpt-x", "https://api.openai.test/v1"), "S", [tool], "hi");
    const deltas: string[] = [];
    const t = await s.next({ onText: (d) => deltas.push(d) });
    expect(deltas.join("")).toBe("Let me check.");
    expect(t.calls).toEqual([
      { id: "c1", name: "list_requests", input: { filter: "user" } },
      { id: "c2", name: "list_environments", input: {} },
    ]);
    expect(t.usage).toEqual({ input: 120, output: 30 });
    expect(calls[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    s.addResults([{ id: "c1", content: "[]" }, { id: "c2", content: "[]" }]);
    expect((await s.next()).text).toBe("Done.");
    const sent = calls[1].body.messages;
    expect(sent[2]).toMatchObject({ role: "assistant", content: "Let me check.", tool_calls: [{ id: "c1" }, { id: "c2" }] });
    expect(sent.slice(3).map((m: any) => m.tool_call_id)).toEqual(["c1", "c2"]);
  });

  it("falls back to a plain JSON reply when a server ignores streaming", async () => {
    replies = [{ json: { choices: [{ message: { role: "assistant", content: "plain" }, finish_reason: "stop" }] } }];
    const deltas: string[] = [];
    const t = await createSession(settings("custom", "local", "http://localhost:1234/v1"), "S", [], "hi").next({ onText: (d) => deltas.push(d) });
    expect(t.text).toBe("plain");
    expect(deltas).toEqual(["plain"]);
  });

  it("clears old tool results only once the history is large, keeping the newest", () => {
    const msgs = [{ role: "user", content: "x" }, ...Array.from({ length: 10 }, (_, i) => ({ role: "tool", tool_call_id: `t${i}`, content: "r".repeat(50_000) }))];
    expect(clearOldToolResults(msgs.slice(0, 3), "openai")).toBe(0);
    expect(clearOldToolResults(msgs, "openai", 6)).toBe(4);
    expect(msgs.slice(1, 5).every((m: any) => m.content === CLEARED)).toBe(true);
    expect(msgs.slice(5).every((m: any) => m.content.length === 50_000)).toBe(true);
    const conv = [{ role: "user", content: Array.from({ length: 8 }, () => ({ toolResult: { toolUseId: "x", content: [{ text: "r".repeat(60_000) }] } })) }];
    expect(clearOldToolResults(conv, "converse", 2)).toBe(6);
  });

  it("Gemini uses its OpenAI-compatible endpoint and survives missing call ids", async () => {
    replies = [
      { json: { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "list_requests", arguments: "{}" } }] }, finish_reason: "tool_calls" }] } },
      { json: { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] } },
    ];
    const s = createSession({ ...settings("gemini", "gemini-2.5-flash"), providers: { gemini: { apiKey: "KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" } } } as any, "S", [tool], "hi");
    const t = await s.next();
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(t.calls[0].id).toBeTruthy();
    s.addResults([{ id: t.calls[0].id, content: "[]" }]);
    await s.next();
    const [, , assistant, toolMsg] = calls[1].body.messages;
    expect(toolMsg.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it("asks for missing settings", () => {
    expect(() => createSession(settings("azure", "", "x"), "S", [], "hi")).toThrow(/model/i);
    expect(() => createSession({ providers: { bedrock: { apiKey: "", baseUrl: "" } }, agent: { provider: "bedrock", model: "m" } } as any, "S", [], "hi")).toThrow(/API key/);
  });
});

describe("a saved request as the model", () => {
  const gateway = {
    ...defaults.http(),
    name: "Haiku gateway",
    path: "llm/haiku.json",
    method: "POST",
    url: "https://gw.example.com/model/us.anthropic.claude-haiku-4-5-20251001-v1:0",
    bodyMode: "json" as const,
    body: `{"anthropic_version": "bedrock-2023-05-31", "max_tokens": 1024, "temperature": {{temp}}, "messages": [{"role": "user", "content": [{"type": "text", "text": "x"}]}]}`,
  };
  const reqSettings = { providers: {}, agent: { provider: "request", model: "", effort: "high", request: gateway.path } } as any;
  const converseReply = (content: any[], stopReason = "end_turn") => ({ json: { metrics: { latencyMs: 5 }, output: { message: { role: "assistant", content } }, stopReason, usage: { inputTokens: 3, outputTokens: 2 } } });

  beforeEach(() => useStore.setState({ items: { [gateway.path]: gateway as any }, envs: [], activeEnv: null, sessionVars: { temp: "0.5", secret: "S3CRET" } }));

  it("detects the body format and model", () => {
    expect(detectFormat(gateway.url, { anthropic_version: "bedrock-2023-05-31" })).toBe("anthropic");
    expect(detectFormat("https://x/model/m/converse", {})).toBe("converse");
    expect(detectFormat("https://x/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] })).toBe("openai");
    expect(requestModelLabel(gateway)).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("writes the conversation over the request's Anthropic body and reads a Converse-shaped reply", async () => {
    replies = [converseReply([{ text: "" }, { toolUse: { toolUseId: "t1", name: "list_requests", input: {} } }], "tool_use"), converseReply([{ text: "Two requests, {{secret}} stays a placeholder." }])];
    const s = createSession(reqSettings, "SYS", [tool], "hi {{secret}}");
    const t1 = await s.next();
    const b1 = JSON.parse(itemSends[0].rawBody!);
    expect(b1).toMatchObject({ anthropic_version: "bedrock-2023-05-31", temperature: 0.5, max_tokens: 8192, system: "SYS" });
    expect(b1.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi {{secret}}" }] }]);
    expect(b1.tools[0]).toEqual({ name: "list_requests", description: "List", input_schema: tool.schema });
    expect(itemSends[0].item.url).toBe(gateway.url);
    expect(t1.calls).toEqual([{ id: "t1", name: "list_requests", input: {} }]);
    expect(t1.usage).toEqual({ input: 3, output: 2 });

    s.addResults([{ id: "t1", content: "[]" }]);
    s.addUser("more");
    const t2 = await s.next();
    const msgs = JSON.parse(itemSends[1].rawBody!).messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toEqual([{ type: "tool_use", id: "t1", name: "list_requests", input: {} }]);
    expect(msgs[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "[]" }, { type: "text", text: "more" }]);
    expect(t2.stop).toBe("end_turn");
    expect(itemSends.every((x) => !x.rawBody!.includes("S3CRET"))).toBe(true);
  });

  it("speaks OpenAI chat to an Azure-style deployment and lifts a small max_tokens", async () => {
    const azure = {
      ...gateway,
      name: "GPT gateway",
      path: "llm/gpt.json",
      url: "https://gw.example.com/openai-chat/openai/deployments/gpt-35-turbo/chat/completions?api-version=2024-10-21",
      body: JSON.stringify({ messages: [{ role: "user", content: "a long example" }], temperature: 0.8, max_tokens: 60, stop: null }),
    };
    useStore.setState({ items: { [azure.path]: azure as any } });
    expect(requestModelLabel(azure)).toBe("gpt-35-turbo");
    replies = [{ json: { choices: [{ message: { role: "assistant", content: "C2020021111" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 4 } } }];
    const t = await createSession({ ...reqSettings, agent: { ...reqSettings.agent, request: azure.path } }, "SYS", [tool], "hi").next();
    const b = JSON.parse(itemSends[0].rawBody!);
    expect(b.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]);
    expect(b).toMatchObject({ temperature: 0.8, max_tokens: 4096, tool_choice: "auto" });
    expect(t).toMatchObject({ text: "C2020021111", usage: { input: 9, output: 4 } });
  });

  it("reports gateway errors and a missing request", async () => {
    replies = [{ status: 403, json: { message: "Forbidden" } }];
    await expect(createSession(reqSettings, "S", [], "hi").next()).rejects.toThrow("Haiku gateway HTTP 403: Forbidden");
    useStore.setState({ items: {} });
    expect(() => createSession(reqSettings, "S", [], "hi")).toThrow(/isn't in this workspace/);
  });
});
