import { askApproval } from "../lib/approvals";
import { COLLECTIONS, useStore } from "../lib/store";
import { createSession, type LlmSession, type ToolResult } from "./llm";
import { WORKSPACE_TOOLS, runTool } from "./workspaceTools";

export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "call"; id: string; name: string; input: any }
  | { type: "result"; id: string; output: string; isError: boolean }
  | { type: "note"; text: string };

const MAX_STEPS = 24;

function system(): string {
  const s = useStore.getState();
  const items = Object.values(s.items);
  const lines = items.slice(0, 200).map((i) => `- ${i.path.replace(`${COLLECTIONS}/`, "")} (${i.kind}${i.kind === "http" ? ` ${i.method} ${i.url}` : ""})`);
  const env = s.envs.find((e) => e.path === s.activeEnv);
  return [
    "You are Forge's built-in API assistant. Forge is the user's local API client (HTTP, GraphQL, MCP, A2A, WebSocket).",
    "Help the user understand and use their APIs: explain endpoints, request/response data, status codes and errors; work out how to call things; write example code; run requests and summarise results.",
    "Look things up with the tools instead of guessing. Base every claim about the API on definitions or responses you actually read.",
    "Environment variable values are secret and never shown to you; refer to them as {{name}}. Never ask the user to paste tokens or passwords.",
    "Requests that change data need the user's approval in Forge; if they decline, accept it.",
    "Answer concisely in Markdown. Use fenced code blocks for code, JSON and commands.",
    "",
    "Working with response data:",
    "- Call response_data first; it describes the tables, columns and statistics Forge found. Don't read or retype large bodies.",
    "- For numbers, counts, filters, rankings and group-bys use query_data. Forge computes them exactly. Never do arithmetic over rows yourself.",
    "- For tables in chat, show query_data's Markdown table. For files (PDF, Word, PowerPoint, Excel, CSV), call create_report; Forge builds the charts and tables from the data. Add a summary only if it is grounded in tool results.",
    "",
    "Organising the workspace: use create_folder and organize (moves and renames in one approved batch). Group requests by resource or feature, name them like 'List orders', 'Create order'.",
    "",
    `Workspace: ${s.root ?? "(none open)"} with ${items.length} saved items${items.length > 200 ? " (first 200 listed)" : ""}:`,
    ...lines,
    "",
    env ? `Active environment: ${env.name} (variables: ${[...env.vars, ...env.secrets].map((v) => v.key).join(", ") || "none"})` : "No active environment.",
  ].join("\n");
}

/** What the user is looking at, prepended to each message so "this request" makes sense. */
function focus(): string {
  const s = useStore.getState();
  const it = s.active ? s.items[s.active] : undefined;
  if (!it) return "";
  const r = s.responses[it.path];
  const res = r?.res ? ` Last response: ${r.res.status} in ${Math.round(r.res.timeMs)} ms${r.results?.length ? `, ${r.results.filter((x) => x.pass).length}/${r.results.length} assertions passed` : ""}.` : r?.error ? ` Last attempt failed: ${r.error}.` : "";
  return `[Open in Forge: ${it.path.replace(`${COLLECTIONS}/`, "")} (${it.kind}${it.kind === "http" ? ` ${it.method} ${it.url}` : ""}).${res}]\n\n`;
}

/** A multi-turn chat over the workspace tools. One instance per conversation. */
export class Assistant {
  private session: LlmSession | null = null;
  private stopped = false;

  constructor(private client = "Ask") {}

  stop() {
    this.stopped = true;
  }

  async ask(text: string, emit: (e: AssistantEvent) => void = () => {}, withFocus = true): Promise<string> {
    this.stopped = false;
    const msg = (withFocus ? focus() : "") + text;
    const settings = useStore.getState().settings;
    if (!this.session) this.session = createSession(settings, system(), WORKSPACE_TOOLS.map((t) => t.spec), msg);
    else this.session.addUser(msg);
    let answer = "";
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.stopped) return answer || "(stopped)";
      const turn = await this.session.next();
      if (turn.note) emit({ type: "note", text: turn.note });
      if (turn.text.trim()) {
        answer = turn.text;
        emit({ type: "text", text: turn.text });
      }
      if (!turn.calls.length) {
        if (turn.stop === "refusal") throw new Error(turn.note ?? "The model declined to answer.");
        return answer;
      }
      const results: ToolResult[] = [];
      for (const c of turn.calls) {
        emit({ type: "call", id: c.id, name: c.name, input: c.input });
        try {
          const out = this.stopped ? "Stopped by user" : await runTool(c.name, c.input, { client: this.client, approve: (s, o) => askApproval(this.client, s, o?.always) });
          results.push({ id: c.id, content: out });
          emit({ type: "result", id: c.id, output: out, isError: false });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          results.push({ id: c.id, content: m, isError: true });
          emit({ type: "result", id: c.id, output: m, isError: true });
        }
      }
      this.session.addResults(results);
    }
    return `${answer}\n\n(Stopped after ${MAX_STEPS} steps.)`;
  }
}
