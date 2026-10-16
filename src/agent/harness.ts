import type { LlmSession, ToolResult, ToolSpec } from "./llm";

/**
 * The agent loop shared by Ask and its sub-agents: ask the model, run the tools it calls, feed the
 * results back, repeat until it answers without calling a tool.
 *
 * - Tools marked `parallel` (reads, and delegating to sub-agents) that the model calls in the same
 *   turn run concurrently; anything else runs in order, so approvals come one at a time.
 * - Results go back in one batch in the order the calls were made, failures as errors the model
 *   can react to, never dropped.
 * - The step budget ends a run gracefully: the caller can offer to continue.
 */

export interface LoopTool {
  spec: ToolSpec;
  /** Safe to run alongside other calls from the same turn. */
  parallel?: boolean;
  run(input: any): Promise<string>;
}

export type LoopEvent =
  | { type: "delta"; text: string }
  | { type: "turnEnd"; text: string }
  | { type: "progress"; text: string }
  | { type: "call"; id: string; name: string; input: any }
  | { type: "result"; id: string; output: string; isError: boolean; ms: number }
  | { type: "usage"; input: number; output: number }
  | { type: "note"; text: string };

export interface LoopResult {
  /** The last thing the model said. */
  text: string;
  stop: "done" | "budget" | "stopped";
  usage: { input: number; output: number };
}

export const MAX_TOOL_OUTPUT = 24_000;

const clip = (s: string) => (s.length > MAX_TOOL_OUTPUT ? `${s.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated ${s.length - MAX_TOOL_OUTPUT} characters; ask for less, e.g. with a filter]` : s);

/** Runs `fns` with at most `limit` in flight, keeping the results in order. */
export async function pool<T>(fns: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(fns.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, fns.length) }, async () => {
      while (next < fns.length) {
        const i = next++;
        out[i] = await fns[i]();
      }
    }),
  );
  return out;
}

export async function runLoop(opts: {
  session: LlmSession;
  tools: LoopTool[];
  emit: (e: LoopEvent) => void;
  maxSteps: number;
  isStopped: () => boolean;
  /** Parallel tool calls in flight at once. */
  concurrency?: number;
}): Promise<LoopResult> {
  const { session, tools, emit, maxSteps, isStopped } = opts;
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const usage = { input: 0, output: 0 };
  let text = "";

  const runOne = async (c: { id: string; name: string; input: any }): Promise<ToolResult> => {
    const t0 = performance.now();
    const done = (content: string, isError: boolean): ToolResult => {
      emit({ type: "result", id: c.id, output: content, isError, ms: performance.now() - t0 });
      return { id: c.id, content, isError: isError || undefined };
    };
    emit({ type: "call", id: c.id, name: c.name, input: c.input });
    if (isStopped()) return done("Stopped by the user.", true);
    const tool = byName.get(c.name);
    if (!tool) return done(`There's no tool named "${c.name}". Use one of: ${[...byName.keys()].join(", ")}.`, true);
    if (c.input && typeof c.input === "object" && "_unparsed" in c.input) return done("The arguments weren't valid JSON. Call the tool again with a JSON object that matches its schema.", true);
    try {
      return done(clip(await tool.run(c.input ?? {})), false);
    } catch (e) {
      return done(e instanceof Error ? e.message : String(e), true);
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    if (isStopped()) return { text, stop: "stopped", usage };
    const turn = await session.next({ onText: (d) => emit({ type: "delta", text: d }), onProgress: (d) => emit({ type: "progress", text: d }) });
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    emit({ type: "usage", ...usage });
    if (turn.note) emit({ type: "note", text: turn.note });
    if (turn.text.trim()) text = turn.text;
    emit({ type: "turnEnd", text: turn.text });
    if (!turn.calls.length) {
      if (turn.stop === "refusal") throw new Error(turn.note ?? "The model declined to continue.");
      return { text, stop: "done", usage };
    }

    // Consecutive parallel-safe calls run together; others in order. Results keep call order.
    const results: ToolResult[] = [];
    let i = 0;
    while (i < turn.calls.length) {
      const c = turn.calls[i];
      if (byName.get(c.name)?.parallel) {
        const group: typeof turn.calls = [];
        while (i < turn.calls.length && byName.get(turn.calls[i].name)?.parallel) group.push(turn.calls[i++]);
        results.push(...(await pool(group.map((g) => () => runOne(g)), opts.concurrency ?? 4)));
      } else {
        results.push(await runOne(c));
        i++;
      }
    }
    session.addResults(results);
  }
  return { text, stop: "budget", usage };
}
