import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logConsole, useConsole } from "./devconsole";
import type { HttpResponse, KV } from "./types";

export type RawBody =
  | { type: "none" }
  | { type: "raw"; content: string }
  | { type: "form"; fields: KV[] }
  | { type: "multipart"; fields: (KV & { file?: boolean })[] }
  | { type: "binary"; path: string };

export interface RawRequest {
  method: string;
  url: string;
  headers: KV[];
  body?: RawBody;
  timeoutMs?: number;
  followRedirects?: boolean;
  insecure?: boolean;
  /** Paths to PEM files for mutual TLS. */
  clientCert?: { cert: string; key: string; ca?: string };
}

export const uid = () => crypto.randomUUID();

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Called after every request the engine sends (e.g. to save cookies the response set). */
export const afterSend = new Set<() => void>();

/** Sends through the Rust HTTP engine and records the exchange in the Console. */
async function send(id: string, request: RawRequest, source = "app"): Promise<HttpResponse> {
  const entry = logConsole({ kind: "http", level: "info", source, title: `${request.method} ${request.url}`, status: "…", request });
  try {
    const res = await invoke<HttpResponse>("http_send", { id, request });
    useConsole.getState().patch(entry, { status: res.status, ms: res.timeMs, size: res.size, response: res, level: res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info" });
    afterSend.forEach((f) => f());
    return res;
  } catch (e) {
    useConsole.getState().patch(entry, { status: "failed", level: "error", detail: String(e) });
    throw e;
  }
}

export const http = {
  send,
  stream: (id: string, request: RawRequest) => invoke<void>("http_stream", { id, request }),
  cancel: (id: string) => invoke<boolean>("http_cancel", { id }),
  resetCookies: () => invoke<void>("http_reset_cookies"),
};

export type StreamEvent =
  | { kind: "head"; streamId: string; status: number; headers: KV[]; ttfbMs: number }
  | { kind: "chunk"; streamId: string; data: string }
  | { kind: "end"; streamId: string; timeMs: number }
  | { kind: "error"; streamId: string; message: string };

export const onHttpStream = (fn: (e: StreamEvent) => void): Promise<UnlistenFn> =>
  listen<StreamEvent>("http-stream", (e) => fn(e.payload));

export type McpConfig =
  | { transport: "stdio"; command: string; args: string[]; env: KV[]; cwd?: string }
  | { transport: "http" | "sse"; url: string; headers: KV[] };

export interface McpLog {
  sessionId: string;
  dir: "out" | "in" | "stderr" | "info";
  message: unknown;
  ts: number;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export const mcp = {
  connect: (id: string, config: McpConfig) => invoke<any>("mcp_connect", { id, config }),
  request: (id: string, method: string, params?: unknown) =>
    invoke<JsonRpcResponse>("mcp_request", { id, method, params: params ?? null }),
  notify: (id: string, method: string, params?: unknown) =>
    invoke<void>("mcp_notify", { id, method, params: params ?? null }),
  disconnect: (id: string) => invoke<void>("mcp_disconnect", { id }),
};

export const onMcpLog = (fn: (e: McpLog) => void) => listen<McpLog>("mcp-log", (e) => fn(e.payload));

export interface WsEvent {
  connId: string;
  kind: "open" | "in" | "out" | "close" | "error";
  data: string;
  ts: number;
}

export const ws = {
  connect: (id: string, url: string, headers: KV[]) => invoke<void>("ws_connect", { id, url, headers }),
  send: (id: string, text: string) => invoke<void>("ws_send", { id, text }),
  close: (id: string) => invoke<void>("ws_close", { id }),
};

export const onWsEvent = (fn: (e: WsEvent) => void) => listen<WsEvent>("ws-event", (e) => fn(e.payload));

export interface Tree {
  root: string;
  dirs: string[];
  files: { path: string; content: string }[];
}

export const fs = {
  open: (path: string) => invoke<Tree>("workspace_open", { path }),
  write: (path: string, content: string) => invoke<void>("workspace_write", { path, content }),
  mkdir: (path: string) => invoke<void>("workspace_mkdir", { path }),
  remove: (path: string) => invoke<void>("workspace_delete", { path }),
  rename: (from: string, to: string) => invoke<void>("workspace_rename", { from, to }),
  ensureGitignore: (lines: string[]) => invoke<void>("workspace_ensure_gitignore", { lines }),
  /** Reads picked files/folders from anywhere on disk for import. */
  writeBytes: (path: string, bytes: Uint8Array) => invoke<string>("workspace_write_bytes", { path, data: toBase64(bytes) }),
  saveFile: (path: string, bytes: Uint8Array) => invoke<void>("file_save", { path, data: toBase64(bytes) }),
  importRead: (paths: string[]) => invoke<{ path: string; content: string }[]>("import_read", { paths }),
  readSettings: () => invoke<string>("settings_read"),
  writeSettings: (content: string) => invoke<void>("settings_write", { content }),
  /** Forge's private app-data files (history, cookies), outside every workspace. */
  readAppData: (name: string) => invoke<string>("appdata_read", { name }),
  writeAppData: (name: string, content: string) => invoke<void>("appdata_write", { name, content }),
};

/** Splits a command-line string into args, honouring quotes and backslash escapes like a POSIX shell. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      // POSIX rules: a backslash escapes anything outside quotes; inside "…" only " \ $ and `.
      if (quote === '"' && !'"\\$`'.includes(ch)) cur += "\\";
      cur += ch;
      escaped = false;
    } else if (ch === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
