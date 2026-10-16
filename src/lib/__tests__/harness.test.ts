import { describe, expect, it } from "vitest";
import { MAX_TOOL_OUTPUT, pool, runLoop, type LoopEvent, type LoopTool } from "../../agent/harness";
import type { LlmSession, ToolResult, Turn } from "../../agent/llm";

/** A model that plays back scripted turns and records what it was sent. */
function scripted(turns: Partial<Turn>[]) {
  const sent: ToolResult[][] = [];
  const session: LlmSession = {
    async next(opts) {
      const t = turns.shift() ?? { text: "done" };
      if (t.text) opts?.onText?.(t.text);
      return { text: t.text ?? "", calls: t.calls ?? [], stop: t.stop ?? (t.calls?.length ? "tool_use" : "end_turn"), usage: { input: 10, output: 5 }, note: t.note };
    },
    addResults: (r) => void sent.push(r),
    addUser: () => {},
  };
  return { session, sent };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("agent loop", () => {
  it("runs parallel-safe calls together, others in order, and returns results in call order", async () => {
    let inFlight = 0;
    let peak = 0;
    const log: string[] = [];
    const read: LoopTool = {
      spec: { name: "read", description: "", schema: {} },
      parallel: true,
      run: async ({ n }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(20 - n * 5);
        inFlight--;
        log.push(`read${n}`);
        return `r${n}`;
      },
    };
    const write: LoopTool = { spec: { name: "write", description: "", schema: {} }, run: async ({ n }) => (log.push(`write${n}`), `w${n}`) };
    const { session, sent } = scripted([
      { calls: [{ id: "a", name: "read", input: { n: 1 } }, { id: "b", name: "read", input: { n: 2 } }, { id: "c", name: "read", input: { n: 3 } }, { id: "d", name: "write", input: { n: 1 } }, { id: "e", name: "write", input: { n: 2 } }] },
      { text: "All done." },
    ]);
    const r = await runLoop({ session, tools: [read, write], emit: () => {}, maxSteps: 5, isStopped: () => false });
    expect(r).toMatchObject({ text: "All done.", stop: "done", usage: { input: 20, output: 10 } });
    expect(peak).toBe(3);
    // The reads finished out of order, the writes ran after them, one at a time.
    expect(log).toEqual(["read3", "read2", "read1", "write1", "write2"]);
    expect(sent[0].map((x) => [x.id, x.content])).toEqual([["a", "r1"], ["b", "r2"], ["c", "r3"], ["d", "w1"], ["e", "w2"]]);
  });

  it("turns failures, unknown tools and unparsable arguments into errors the model can react to", async () => {
    const boom: LoopTool = { spec: { name: "boom", description: "", schema: {} }, run: async () => { throw new Error("declined by user"); } };
    const { session, sent } = scripted([{ calls: [{ id: "1", name: "boom", input: {} }, { id: "2", name: "nope", input: {} }, { id: "3", name: "boom", input: { _unparsed: "{bad" } }] }, { text: "ok" }]);
    await runLoop({ session, tools: [boom], emit: () => {}, maxSteps: 3, isStopped: () => false });
    expect(sent[0]).toEqual([
      { id: "1", content: "declined by user", isError: true },
      { id: "2", content: 'There\'s no tool named "nope". Use one of: boom.', isError: true },
      { id: "3", content: expect.stringContaining("weren't valid JSON"), isError: true },
    ]);
  });

  it("stops at the step budget, on request, and on a refusal", async () => {
    const t: LoopTool = { spec: { name: "t", description: "", schema: {} }, run: async () => "x" };
    const forever = () => scripted(Array.from({ length: 50 }, () => ({ text: "working", calls: [{ id: "i", name: "t", input: {} }] })));
    expect((await runLoop({ session: forever().session, tools: [t], emit: () => {}, maxSteps: 3, isStopped: () => false })).stop).toBe("budget");
    let n = 0;
    expect((await runLoop({ session: forever().session, tools: [t], emit: () => {}, maxSteps: 30, isStopped: () => ++n > 2 })).stop).toBe("stopped");
    await expect(runLoop({ session: scripted([{ stop: "refusal", note: "Model declined (cyber)" }]).session, tools: [], emit: () => {}, maxSteps: 3, isStopped: () => false })).rejects.toThrow("Model declined (cyber)");
  });

  it("clips huge tool output and streams events in order", async () => {
    const big: LoopTool = { spec: { name: "big", description: "", schema: {} }, run: async () => "x".repeat(MAX_TOOL_OUTPUT + 500) };
    const events: LoopEvent["type"][] = [];
    const { session, sent } = scripted([{ text: "Reading.", calls: [{ id: "1", name: "big", input: {} }] }, { text: "Done." }]);
    await runLoop({ session, tools: [big], emit: (e) => events.push(e.type), maxSteps: 3, isStopped: () => false });
    expect(sent[0][0].content.length).toBeLessThan(MAX_TOOL_OUTPUT + 200);
    expect(sent[0][0].content).toMatch(/truncated 500 characters/);
    expect(events).toEqual(["delta", "usage", "turnEnd", "call", "result", "delta", "usage", "turnEnd"]);
  });

  it("caps how many parallel calls are in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await pool(Array.from({ length: 10 }, (_, i) => async () => (inFlight++, (peak = Math.max(peak, inFlight)), await sleep(5), inFlight--, i)), 3);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(3);
  });
});
