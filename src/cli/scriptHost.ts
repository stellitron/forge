import { Worker } from "node:worker_threads";
import { sandboxMain, type ScriptApi, type ScriptOutput } from "../lib/scriptRuntime";
import type { ScriptHost } from "../lib/scripts";

/**
 * Runs request scripts for the command line in a worker thread, inside a vm context with no
 * require, process, file system or network. The thread can be stopped at any point, so a runaway
 * script never hangs a CI job, and it starts with an empty environment and no fetch, so even code
 * that escaped the vm context couldn't read CI secrets or send them anywhere. Requests a script
 * asks for (pm.sendRequest) come back to this thread, which checks and sends them.
 */
const WORKER = `
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");
for (const n of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "Request", "Response", "Headers", "FormData"]) { try { delete globalThis[n]; } catch {} }
for (const n of ["binding", "_linkedBinding", "dlopen", "kill", "chdir"]) { try { process[n] = undefined; } catch {} }
const source = ${JSON.stringify(`(${sandboxMain.toString()})(__input, __api)`)};
const sends = new Map();
let seq = 0;
parentPort.on("message", async (m) => {
  if (m.type === "sendResult") {
    const p = sends.get(m.sendId);
    sends.delete(m.sendId);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.res);
    return;
  }
  const api = { send: (req) => new Promise((resolve, reject) => { const sendId = ++seq; sends.set(sendId, { resolve, reject }); parentPort.postMessage({ type: "send", id: m.id, sendId, req: JSON.parse(JSON.stringify(req)) }); }) };
  const context = vm.createContext({ __input: m.input, __api: api, setTimeout, clearTimeout, atob, btoa, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone });
  let out;
  try { out = await vm.runInContext(source, context, { timeout: m.timeoutMs }); } catch (e) {
    if (e && e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return parentPort.postMessage({ type: "timeout", id: m.id });
    out = { vars: {}, request: m.input.request, tests: [], logs: [], error: String(e && e.message || e) };
  }
  parentPort.postMessage({ type: "done", id: m.id, out: JSON.parse(JSON.stringify(out)) });
});`;

interface Run {
  resolve: (o: ScriptOutput) => void;
  reject: (e: Error) => void;
  api?: ScriptApi;
  timeoutMs: number;
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
  if (!runs.size) worker?.unref();
  return r;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER, { eval: true, env: {}, argv: [], execArgv: [] });
  w.on("message", (m: any) => {
    if (m.type === "done") return void finish(m.id)?.resolve(m.out);
    if (m.type === "timeout") {
      const r = finish(m.id);
      return void r?.reject(new Error(`Script took longer than ${r.timeoutMs / 1000} s and was stopped`));
    }
    if (m.type === "send") {
      const r = runs.get(m.id);
      if (!r?.api?.send) return w.postMessage({ type: "sendResult", sendId: m.sendId, error: "Sending requests from scripts isn't available here." });
      r.inflight++;
      r.api
        .send(m.req)
        .then(
          (res) => w.postMessage({ type: "sendResult", sendId: m.sendId, res: JSON.parse(JSON.stringify(res)) }),
          (err) => w.postMessage({ type: "sendResult", sendId: m.sendId, error: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => r.inflight--);
    }
  });
  w.on("error", (e) => kill(String(e)));
  return (worker = w);
}

function kill(reason: string) {
  const w = worker;
  worker = null;
  void w?.terminate();
  for (const id of [...runs.keys()]) finish(id)?.reject(new Error(reason));
}

export const nodeScriptHost: ScriptHost = (input, timeoutMs, api) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const run: Run = {
      resolve,
      reject,
      api,
      timeoutMs,
      inflight: 0,
      busyMs: 0,
      // Time spent waiting on requests the script asked for doesn't count.
      timer: setInterval(() => {
        if (run.inflight) return;
        run.busyMs += TICK;
        if (run.busyMs > timeoutMs) kill(`Script took longer than ${timeoutMs / 1000} s and was stopped`);
      }, TICK),
    };
    runs.set(id, run);
    const w = getWorker();
    w.ref();
    w.postMessage({ type: "run", id, input, timeoutMs });
  });
