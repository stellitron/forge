import { sandboxMain, type ScriptApi, type ScriptInput, type ScriptOutput, type ScriptRequest } from "./scriptRuntime";
import type { HttpItem } from "./types";
import { paramsFromUrl } from "./urlParams";

/**
 * Runs request scripts in isolation. In the app that's one long-lived Web Worker: it starts once,
 * so each script costs about a millisecond, it has no access to Forge's file and network bridge,
 * and a runaway script is killed without freezing the window. The CLI swaps in a Node vm host.
 */

export type ScriptHost = (input: ScriptInput, timeoutMs: number, api?: ScriptApi) => Promise<ScriptOutput>;

export const SCRIPT_TIMEOUT_MS = 5000;

/** Names removed from the worker before any script runs. */
const BLOCKED = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "WebTransport", "BroadcastChannel", "Worker", "SharedWorker", "indexedDB", "caches", "navigator"];

// Requests a script asks for (pm.sendRequest) leave the worker as messages; Forge sends them
// after its checks and posts the response back.
const WORKER_SOURCE = `
const run = (${sandboxMain.toString()});
const reply = self.postMessage.bind(self);
for (const n of ${JSON.stringify(BLOCKED)}) {
  for (let o = self; o; o = Object.getPrototypeOf(o)) { try { delete o[n]; } catch {} }
  try { Object.defineProperty(self, n, { value: undefined, writable: false, configurable: false }); } catch {}
}
const sends = new Map();
let sendSeq = 0;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "sendResult") {
    const p = sends.get(m.sendId);
    sends.delete(m.sendId);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.res);
    return;
  }
  const api = { send: (req) => new Promise((resolve, reject) => { const sendId = ++sendSeq; sends.set(sendId, { resolve, reject }); reply({ type: "send", id: m.id, sendId, req }); }) };
  let out;
  try { out = await run(m.input, api); } catch (err) { out = { vars: {}, request: m.input.request, tests: [], logs: [], error: String(err) }; }
  reply({ type: "done", id: m.id, out: JSON.parse(JSON.stringify(out)) });
};`;

interface Run {
  resolve: (o: ScriptOutput) => void;
  reject: (e: Error) => void;
  api?: ScriptApi;
  /** Requests in flight; time spent waiting on them doesn't count toward the timeout. */
  inflight: number;
  busyMs: number;
  timer: ReturnType<typeof setInterval>;
}

let worker: Worker | null = null;
let seq = 0;
const runs = new Map<number, Run>();
const TICK = 50;

function finish(id: number) {
  const r = runs.get(id);
  if (r) clearInterval(r.timer);
  runs.delete(id);
  return r;
}

function getWorker(): Worker {
  if (worker) return worker;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  w.onmessage = (e: MessageEvent<any>) => {
    const m = e.data;
    if (m.type === "done") return void finish(m.id)?.resolve(m.out);
    if (m.type === "send") {
      const r = runs.get(m.id);
      if (!r?.api?.send) return w.postMessage({ type: "sendResult", sendId: m.sendId, error: "Sending requests from scripts isn't available here." });
      r.inflight++;
      r.api.send(m.req).then(
        (res) => w.postMessage({ type: "sendResult", sendId: m.sendId, res }),
        (err) => w.postMessage({ type: "sendResult", sendId: m.sendId, error: err instanceof Error ? err.message : String(err) }),
      ).finally(() => r.inflight--);
    }
  };
  return (worker = w);
}

function killWorker(reason: string) {
  worker?.terminate();
  worker = null;
  for (const id of [...runs.keys()]) finish(id)?.reject(new Error(reason));
}

const workerHost: ScriptHost = (input, timeoutMs, api) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const run: Run = {
      resolve,
      reject,
      api,
      inflight: 0,
      busyMs: 0,
      timer: setInterval(() => {
        if (run.inflight) return;
        run.busyMs += TICK;
        if (run.busyMs > timeoutMs) killWorker(`Script took longer than ${timeoutMs / 1000} s and was stopped`);
      }, TICK),
    };
    runs.set(id, run);
    getWorker().postMessage({ type: "run", id, input });
  });

let host: ScriptHost = workerHost;

/** The CLI and tests run scripts in Node instead of a Web Worker. */
export function setScriptHost(h: ScriptHost) {
  host = h;
}

export const hasScripts = (item: HttpItem) => !!(item.preScript?.trim() || item.postScript?.trim());

export function runScript(input: ScriptInput, api?: ScriptApi, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ScriptOutput> {
  return host(input, timeoutMs, api);
}

/** What a script sees of a request: as written, with {{placeholders}} (like Postman's pm.request). */
export function requestView(item: HttpItem): ScriptRequest {
  const body = item.bodyMode === "graphql" ? JSON.stringify({ query: item.graphql.query, variables: item.graphql.variables }) : item.bodyMode === "none" ? "" : item.body;
  return { method: item.method, url: item.url, headers: item.headers.map((h) => ({ ...h })), body };
}

/** Applies a pre-request script's changes to a copy of the item (the saved request isn't touched). */
export function applyView(item: HttpItem, before: ScriptRequest, after: ScriptRequest): HttpItem {
  let next = item;
  if (after.method !== before.method) next = { ...next, method: after.method };
  if (after.url !== before.url) next = { ...next, url: after.url, params: paramsFromUrl(after.url, next.params) };
  if (JSON.stringify(after.headers) !== JSON.stringify(before.headers)) next = { ...next, headers: after.headers };
  if (after.body !== before.body) {
    if (next.bodyMode === "graphql") {
      try {
        const g = JSON.parse(after.body);
        next = { ...next, graphql: { query: String(g.query ?? ""), variables: typeof g.variables === "string" ? g.variables : JSON.stringify(g.variables ?? {}) } };
      } catch {
        /* not GraphQL any more; leave it */
      }
    } else {
      const mode = next.bodyMode === "json" || next.bodyMode === "xml" || next.bodyMode === "text" ? next.bodyMode : /^\s*[[{]/.test(after.body) ? "json" : "text";
      next = { ...next, bodyMode: mode, body: after.body };
    }
  }
  return next;
}
