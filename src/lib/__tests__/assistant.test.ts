import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmSession, NextOptions, ToolSpec, Turn } from "../../agent/llm";

/** Every session the assistant creates, with how it was configured and a scripted model behind it. */
const created: { system: string; tools: string[]; goal: string; effort?: string }[] = [];
let active = 0;
let peak = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function orchestratorScript(): Partial<Turn>[] {
  return [
    {
      text: "I'll split this up.",
      calls: [
        { id: "plan", name: "todo_write", input: { todos: [{ content: "Check A–D", status: "in_progress" }, { content: "Summarise", status: "pending" }] } },
        ...["A", "B", "C", "D"].map((x) => ({ id: `d-${x}`, name: "delegate", input: { title: `Check ${x}`, task: `Look at area ${x} and report.` } })),
      ],
    },
    { text: "All four areas checked.", calls: [{ id: "plan2", name: "todo_write", input: { todos: [{ content: "Check A–D", status: "completed" }, { content: "Summarise", status: "completed" }] } }] },
    { text: "Summary: A, B, C and D are fine." },
  ];
}

function subScript(goal: string): Partial<Turn>[] {
  const area = /area (\w)/.exec(goal)?.[1] ?? "?";
  return [{ text: `Looking at ${area}.`, calls: [{ id: `l-${area}`, name: "list_requests", input: {} }] }, { text: `Report for ${area}: 2 requests, all fine.` }];
}

vi.mock("../../agent/llm", async (orig) => ({
  ...(await orig<typeof import("../../agent/llm")>()),
  createSession: (_settings: unknown, system: string, tools: ToolSpec[], goal: string, opts: { effort?: string } = {}): LlmSession => {
    const isSub = system.startsWith("You are a sub-agent");
    created.push({ system, tools: tools.map((t) => t.name), goal, effort: opts.effort });
    const turns = isSub ? subScript(goal) : orchestratorScript();
    return {
      async next(o?: NextOptions) {
        if (isSub) {
          active++;
          peak = Math.max(peak, active);
          await sleep(15);
          active--;
        }
        const t = turns.shift() ?? { text: "" };
        if (t.text) o?.onText?.(t.text);
        return { text: t.text ?? "", calls: t.calls ?? [], stop: t.calls?.length ? "tool_use" : "end_turn", usage: { input: 1, output: 1 } };
      },
      addResults: (r) => isSub || orchestratorResults.push(...r),
      addUser: () => {},
    };
  },
}));
vi.mock("../ipc", () => ({ fs: { write: async () => {}, writeSettings: async () => {}, readAppData: async () => "", writeAppData: async () => {} }, http: {}, uid: () => "x", afterSend: new Set() }));
vi.stubGlobal("window", globalThis);

const orchestratorResults: { id: string; content: string; isError?: boolean }[] = [];
import { Assistant, type AssistantEvent } from "../../agent/assistant";
import { useStore } from "../store";
import { defaults, type Item } from "../types";

beforeEach(() => {
  created.length = 0;
  orchestratorResults.length = 0;
  active = peak = 0;
  const items = ["collections/Shop/a.json", "collections/Shop/b.json"].map((path) => ({ ...defaults.http(), name: path, path, url: "{{baseUrl}}/x" }) as Item);
  useStore.setState({ root: "/ws", items: Object.fromEntries(items.map((i) => [i.path, i])), envs: [], folders: {}, activeEnv: null, settings: { ...useStore.getState().settings, agent: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" } } });
});

describe("Ask as an orchestrator", () => {
  it("plans, runs sub-agents in parallel (at most three at once) and gets their reports back", async () => {
    const events: AssistantEvent[] = [];
    const answer = await new Assistant().ask("Check every area of the Shop API", (e) => events.push(e), false);
    expect(answer).toBe("Summary: A, B, C and D are fine.");

    // One orchestrator plus four sub-agents; sub-agents can't delegate or plan, and run lighter.
    expect(created).toHaveLength(5);
    const subs = created.filter((c) => c.system.startsWith("You are a sub-agent"));
    expect(subs).toHaveLength(4);
    expect(subs.every((s) => !s.tools.includes("delegate") && !s.tools.includes("todo_write") && s.tools.includes("update_request"))).toBe(true);
    expect(subs.every((s) => s.effort === "medium")).toBe(true);
    expect(created[0].tools).toEqual(expect.arrayContaining(["delegate", "todo_write", "list_requests"]));
    // Every sub-agent sees the workspace and its own task.
    expect(subs.every((s) => s.goal.includes("collections/Shop") || s.goal.includes("Shop/a.json"))).toBe(true);
    expect(peak).toBe(3);

    // Reports go back to the orchestrator as the delegate results, in call order.
    const reports = orchestratorResults.filter((r) => r.id.startsWith("d-"));
    expect(reports.map((r) => r.content)).toEqual(["Report for A: 2 requests, all fine.", "Report for B: 2 requests, all fine.", "Report for C: 2 requests, all fine.", "Report for D: 2 requests, all fine."]);

    // Sub-agent progress is tagged with its own delegate call, so the chat can nest it.
    const subCalls = events.filter((e): e is Extract<AssistantEvent, { type: "call" }> => e.type === "call" && !!e.parent);
    expect(subCalls.map((e) => [e.parent, e.id]).sort()).toEqual([["d-A", "l-A"], ["d-B", "l-B"], ["d-C", "l-C"], ["d-D", "l-D"]]);
    const todos = events.filter((e): e is Extract<AssistantEvent, { type: "todos" }> => e.type === "todos");
    expect(todos.at(-1)?.todos.every((t) => t.status === "completed")).toBe(true);
  });

  it("asks to continue when it runs out of steps instead of stopping silently", async () => {
    // A model that never stops calling tools.
    const a = new Assistant();
    const events: AssistantEvent[] = [];
    const llm = await import("../../agent/llm");
    const spy = vi.spyOn(llm, "createSession").mockImplementation(() => ({
      next: async () => ({ text: "still going", calls: [{ id: `x${Math.random()}`, name: "list_requests", input: {} }], stop: "tool_use", usage: { input: 1, output: 1 } }),
      addResults: () => {},
      addUser: () => {},
    }));
    await a.ask("loop", (e) => events.push(e), false);
    expect(events.at(-1)).toEqual({ type: "budget" });
    spy.mockRestore();
  });
});
