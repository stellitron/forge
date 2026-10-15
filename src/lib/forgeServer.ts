import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { Assistant } from "../agent/assistant";
import { mcpToolDefs, runTool } from "../agent/workspaceTools";
import { askApproval } from "./approvals";
import { logConsole } from "./devconsole";
import { uid } from "./ipc";
import { useStore, type Settings } from "./store";

/** Runs Forge's MCP + A2A server (Rust) and answers its calls with the workspace tools. */

export const DEFAULT_PORT = 7878;

export const newToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return `forge_${btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};

export const useServer = create<{ running: boolean; url: string | null; error: string | null }>(() => ({ running: false, url: null, error: null }));

interface BridgeCall {
  id: string;
  kind: "tool" | "a2a";
  name: string;
  args: any;
  client: string;
}

const INSTRUCTIONS =
  "Forge is the user's local API client. Use list_requests to see saved requests (path, method, URL), get_request to read one, run_request or run_folder to execute them with the active environment, last_response for what came back, and recent_traffic for Forge's console. " +
  "{{name}} placeholders are environment variables whose values stay inside Forge. Requests that change data wait for the user's approval in Forge.";

const card = () => ({
  protocolVersion: "0.3.0",
  name: "Forge",
  description: "The user's local API workspace. Ask about saved APIs, run requests and test collections, explain responses and errors.",
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "api-workspace",
      name: "API workspace assistant",
      description: "Answers questions about the APIs saved in Forge and runs requests or whole folders, reporting results.",
      tags: ["api", "testing", "http", "mcp"],
      examples: ["Which endpoints does the Users API have?", "Run the Users folder and tell me what failed", "Why does Create user return 400?"],
    },
  ],
});

const a2aChats = new Map<string, Assistant>();

async function handle(c: BridgeCall): Promise<unknown> {
  if (c.kind === "tool") {
    const out = await runTool(c.name, c.args, { client: c.client, approve: (s, o) => askApproval(c.client, s, o?.always) });
    return { content: [{ type: "text", text: out }] };
  }
  const msg = c.args?.message ?? {};
  const text = (msg.parts ?? []).filter((p: any) => p.kind === "text" || p.type === "text").map((p: any) => p.text).join("\n");
  if (!text) throw new Error("Send a text part");
  const contextId: string = msg.contextId ?? uid();
  let chat = a2aChats.get(contextId);
  if (!chat) {
    if (a2aChats.size > 20) a2aChats.delete(a2aChats.keys().next().value!);
    chat = new Assistant("A2A client");
    a2aChats.set(contextId, chat);
  }
  const answer = await chat.ask(text, () => {}, false);
  return { kind: "message", role: "agent", messageId: uid(), contextId, parts: [{ kind: "text", text: answer || "(no answer)" }] };
}

let current = "";

async function apply(server: Settings["server"]) {
  const key = JSON.stringify(server ?? null);
  if (key === current) return;
  current = key;
  try {
    if (!server?.enabled) {
      await invoke("server_stop");
      useServer.setState({ running: false, url: null, error: null });
      return;
    }
    const st = await invoke<{ running: boolean; url: string }>("server_start", {
      config: { port: server.port, token: server.token, tools: mcpToolDefs(), card: card(), instructions: INSTRUCTIONS },
    });
    useServer.setState({ running: true, url: st.url, error: null });
    logConsole({ kind: "server", level: "info", source: "Forge server", title: `Listening on ${st.url} (MCP ${st.url}/mcp · A2A ${st.url}/a2a)` });
  } catch (e) {
    current = "";
    useServer.setState({ running: false, url: null, error: String(e) });
    logConsole({ kind: "server", level: "error", source: "Forge server", title: String(e) });
  }
}

export function installServerBridge() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  listen<BridgeCall>("forge-server-call", async ({ payload: c }) => {
    const t0 = performance.now();
    const label = c.kind === "tool" ? `${c.name}(${JSON.stringify(c.args ?? {}).slice(0, 160)})` : `A2A ${c.name}`;
    const entry = logConsole({ kind: "server", level: "info", source: c.client, title: label, status: "…", detail: c.args });
    let ok = true;
    let value: unknown;
    try {
      value = await handle(c);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // Tool failures are results the model can read; A2A failures are JSON-RPC errors.
      if (c.kind === "tool") value = { content: [{ type: "text", text: m }], isError: true };
      else (ok = false), (value = m);
    }
    const failed = !ok || (value as any)?.isError;
    const { useConsole } = await import("./devconsole");
    useConsole.getState().patch(entry, { status: failed ? "error" : "ok", level: failed ? "warn" : "info", ms: performance.now() - t0, detail: { args: c.args, result: value } });
    await invoke("server_reply", { id: c.id, ok, value });
  }).catch(() => {});
  apply(useStore.getState().settings.server);
  useStore.subscribe((s) => apply(s.settings.server));
}
