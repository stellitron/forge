import { http, onHttpStream, uid } from "./ipc";
import { SseParser, tryJson } from "./eval";
import { sendJson } from "./request";
import type { KV } from "./types";

/** Agent-to-Agent (A2A) protocol client: agent card discovery + JSON-RPC message/send & message/stream. */

export const CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"];

export interface AgentCard {
  name?: string;
  description?: string;
  url?: string;
  version?: string;
  protocolVersion?: string;
  capabilities?: { streaming?: boolean; pushNotifications?: boolean };
  skills?: { id: string; name: string; description?: string; tags?: string[]; examples?: string[] }[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  [k: string]: unknown;
}

export async function fetchCard(baseUrl: string, headers: KV[]): Promise<{ card: AgentCard; cardUrl: string }> {
  const base = baseUrl.replace(/\/+$/, "");
  const candidates = /\.json$/.test(base) ? [base] : CARD_PATHS.map((p) => base + p);
  let lastErr = "";
  for (const url of candidates) {
    try {
      const res = await http.send(uid(), { method: "GET", url, headers, timeoutMs: 20000 }, "A2A card");
      const card = tryJson(res.body) as AgentCard | undefined;
      if (res.status < 300 && card) return { card, cardUrl: url };
      lastErr = `${url} → HTTP ${res.status}`;
    } catch (e) {
      lastErr = `${url} → ${e}`;
    }
  }
  throw new Error(`No agent card found. Last attempt: ${lastErr}`);
}

export function userMessage(text: string, contextId?: string, taskId?: string) {
  return {
    kind: "message",
    role: "user",
    messageId: crypto.randomUUID(),
    parts: [{ kind: "text", text }],
    ...(contextId ? { contextId } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

export function rpc(method: string, params: unknown) {
  return { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };
}

export async function call(endpoint: string, method: string, params: unknown, headers: KV[]) {
  const res = await sendJson("POST", endpoint, rpc(method, params), headers, "A2A");
  const json = tryJson(res.body) as any;
  if (!json) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 500)}`);
  return json;
}

/** Streams `message/stream`; calls onEvent for each JSON-RPC event. Returns a cancel function. */
export async function stream(
  endpoint: string,
  params: unknown,
  headers: KV[],
  onEvent: (e: any) => void,
  onDone: (err?: string) => void,
): Promise<() => void> {
  const id = uid();
  const parser = new SseParser();
  const un = await onHttpStream((e) => {
    if (e.streamId !== id) return;
    if (e.kind === "chunk") for (const ev of parser.feed(e.data)) onEvent(tryJson(ev.data) ?? ev.data);
    if (e.kind === "head" && e.status >= 400) onDone(`HTTP ${e.status}`);
    if (e.kind === "end" || e.kind === "error") {
      un();
      onDone(e.kind === "error" ? e.message : undefined);
    }
  });
  http
    .stream(id, {
      method: "POST",
      url: endpoint,
      headers: [
        ...headers,
        { key: "Content-Type", value: "application/json", enabled: true },
        { key: "Accept", value: "text/event-stream", enabled: true },
      ],
      body: { type: "raw", content: JSON.stringify(rpc("message/stream", params)) },
    })
    .catch((err) => {
      un();
      onDone(String(err));
    });
  return () => {
    http.cancel(id);
    un();
  };
}

/** Pulls human-readable text out of any A2A result shape (Message, Task, status/artifact updates). */
export function textOf(x: any): string {
  if (!x || typeof x !== "object") return "";
  const parts = (p: any[] | undefined) =>
    (p ?? []).map((pt) => (pt.kind === "text" || pt.text ? pt.text : pt.kind === "data" ? JSON.stringify(pt.data) : `[${pt.kind}]`)).join("");
  if (x.kind === "message" || x.parts) return parts(x.parts);
  if (x.kind === "artifact-update") return parts(x.artifact?.parts);
  if (x.kind === "status-update") return parts(x.status?.message?.parts);
  if (x.kind === "task" || x.status) {
    const fromArtifacts = (x.artifacts ?? []).map((a: any) => parts(a.parts)).join("\n");
    return fromArtifacts || parts(x.status?.message?.parts);
  }
  return "";
}
