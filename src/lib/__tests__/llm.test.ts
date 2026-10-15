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
vi.mock("@tauri-apps/plugin-http", () => ({ fetch }));
vi.mock("../ipc", () => ({ fs: {}, http: {}, uid: () => "x" }));

import { azureChatUrl, createSession } from "../../agent/llm";
import type { ProviderId, Settings } from "../store";

const tool = { name: "list_requests", description: "List", schema: { type: "object", properties: {} } };
const settings = (provider: ProviderId, model: string, baseUrl = ""): Settings =>
  ({ providers: { [provider]: { apiKey: "KEY", baseUrl } }, agent: { provider, model, effort: "high" } }) as any;

beforeEach(() => ((calls.length = 0), (replies = [])));

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
