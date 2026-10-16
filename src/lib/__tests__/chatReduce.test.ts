import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
vi.mock("../ipc", () => ({ fs: {}, http: {}, uid: () => "x", afterSend: new Set() }));
import { reduce } from "../../components/ChatPanel";
import type { AssistantEvent } from "../../agent/assistant";

const play = (events: AssistantEvent[]) => events.reduce((m, e) => reduce(m, e), { role: "assistant" as const, text: "", parts: [] } as Parameters<typeof reduce>[0]);

describe("chat reply builder", () => {
  it("interleaves streamed text and steps, and nests sub-agent work under its delegate call", () => {
    const m = play([
      { type: "delta", text: "Let me " },
      { type: "delta", text: "check." },
      { type: "turnEnd", text: "Let me check." },
      { type: "call", id: "d1", name: "delegate", input: { title: "Tests for Orders", task: "…" } },
      { type: "delta", text: "Reading Orders", parent: "d1" },
      { type: "call", id: "s1", name: "list_requests", input: {}, parent: "d1" },
      { type: "result", id: "s1", output: "2 requests", isError: false, ms: 1, parent: "d1" },
      { type: "result", id: "d1", output: "Report: added 4 assertions", isError: false, ms: 9 },
      { type: "todos", todos: [{ content: "Write tests", status: "completed" }] },
      { type: "delta", text: "Done." },
      { type: "budget" },
    ]);
    expect(m.parts!.map((p) => (p.kind === "text" ? `text:${p.text}` : `step:${p.step.name}`))).toEqual(["text:Let me check.", "step:delegate", "text:Done."]);
    const d = m.parts![1].kind === "step" ? m.parts![1].step : null;
    expect(d).toMatchObject({ output: "Report: added 4 assertions", children: [{ id: "s1", name: "list_requests", output: "2 requests" }] });
    expect(d!.live).toBeUndefined();
    expect(m.todos).toEqual([{ content: "Write tests", status: "completed" }]);
    expect(m.paused).toBe(true);
  });

  it("shows progress notes until the next step or text, and keeps them short", () => {
    let m = play([{ type: "progress", text: "x".repeat(500) }]);
    expect(m.progress!.length).toBe(240);
    m = reduce(m, { type: "call", id: "c", name: "get_request", input: {} });
    expect(m.progress).toBeUndefined();
  });
});
