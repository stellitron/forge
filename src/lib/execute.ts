import { runAssertions, runExtractions } from "./eval";
import type { RawRequest } from "./ipc";
import { allowRisk, requestRisk, variableRisk, type ScriptRisk } from "./scriptGuard";
import { effectiveItem, scriptChain } from "./inherit";
import { applyView, requestView, runScript } from "./scripts";
import type { ScriptApi, ScriptOutput } from "./scriptRuntime";
import { allow, checkEgress } from "../agent/egress";
import { http, uid } from "./ipc";
import { sendItem } from "./sendItem";
import { useStore } from "./store";
import type { AssertionResult, HttpItem, HttpResponse } from "./types";

export interface ScriptLog {
  phase: "pre" | "post";
  level: "info" | "warn" | "error";
  text: string;
}

export interface Executed {
  req: RawRequest;
  res: HttpResponse;
  results: AssertionResult[];
  extracted: Record<string, string>;
  logs: ScriptLog[];
}

/** Script variable changes as setVars values; an unset variable becomes empty. */
const asVars = (changes: ScriptOutput["vars"]) => Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v ?? ""]));

/**
 * Asks about a risky script change. Without a way to ask (the CLI), it's refused unless the run
 * trusts scripts.
 */
async function approve(risk: ScriptRisk, confirm?: (summary: string) => Promise<boolean>): Promise<boolean> {
  if (!confirm || !(await confirm(risk.summary))) return false;
  allowRisk(risk);
  return true;
}

/**
 * Sends what a script asks for (pm.sendRequest). The script can't reach the network itself; this
 * runs outside the sandbox and applies the same check as AI-built requests: a host none of your
 * trusted requests use, or a secret going somewhere it isn't normally sent, needs your OK.
 */
function scriptSender(name: string, varsBefore: () => Record<string, string>, scriptSet: () => string[], confirm?: (summary: string) => Promise<boolean>): ScriptApi {
  return {
    async send(r) {
      const out = { url: r.url, headers: r.headers, body: r.body };
      const v = checkEgress(out, out, { vars: varsBefore(), ignore: new Set(scriptSet()) });
      if (v.reason) {
        const summary = `A script in "${name}" wants to send ${r.method}. ${v.reason}`;
        if (!confirm || !(await confirm(summary))) throw new Error(`Blocked: ${summary}`);
        allow(v);
      }
      const res = await http.send(uid(), { method: r.method, url: r.url, headers: r.headers.map((h) => ({ ...h, enabled: true })), body: r.body === undefined ? { type: "none" } : { type: "raw", content: r.body }, timeoutMs: 30000 }, "script");
      return { status: res.status, statusText: res.statusText, headers: res.headers, body: res.bodyBase64 ? "" : res.body, timeMs: res.timeMs, size: res.size };
    },
  };
}

const testResults = (out: ScriptOutput, phase: string): AssertionResult[] => [
  ...out.tests.map((t) => ({ label: t.name, pass: t.pass, actual: t.error ?? "" })),
  ...(out.error ? [{ label: `${phase} script`, pass: false, actual: out.error }] : []),
];

/**
 * Sends a request the way every runner does (app, folder runner, CLI): pre-request script,
 * send with auth, assertions, extracted values, post-response script. Requests without scripts
 * skip the script steps entirely.
 */
export async function executeHttp(
  item: HttpItem & { name?: string; path?: string },
  requestId: string,
  source: string,
  opts: {
    interactive: boolean;
    /** Asks the user about a script sending a request or variable somewhere new; refused when absent. */
    confirm?: (summary: string) => Promise<boolean>;
  },
): Promise<Executed> {
  const st = useStore.getState();
  const path = item.path ?? "";
  const vars = () => (path ? useStore.getState().varsFor(path) : useStore.getState().vars());
  const logs: ScriptLog[] = [];
  const results: AssertionResult[] = [];
  // Folder headers and inherited auth, as the request will actually be sent.
  const base = path ? effectiveItem({ ...item, path }) : item;
  let send = base;

  const pre = path ? scriptChain(path, item, "pre") : item.preScript?.trim() ? [{ label: "Request", code: item.preScript }] : [];
  if (pre.length) {
    const varsBefore = vars();
    const set: Record<string, string> = {};
    const stop = (msg: string) => Object.assign(new Error(msg), { logs });
    const api = scriptSender(item.name ?? "", () => varsBefore, () => Object.keys(set), opts.confirm);
    for (const script of pre) {
      const before = requestView(send);
      const out = await runScript({ code: script.code, phase: "pre", name: item.name ?? "", vars: { ...varsBefore, ...set }, request: before }, api);
      logs.push(...out.logs.map((l) => ({ ...l, phase: "pre" as const })));
      const where = pre.length > 1 ? ` (${script.label})` : "";
      // A failing pre-request script stops the request, like a failed login step would.
      if (out.error) throw stop(`Pre-request script${where}: ${out.error}`);
      Object.assign(set, asVars(out.vars));
      send = applyView(send, before, out.request);
      results.push(...testResults(out, `Pre-request${where}`));
    }
    // Judged against the variables from before any script ran, so a changed {{baseUrl}} can't vouch for itself.
    const varRisk = variableRisk(set, varsBefore, "pre");
    if (varRisk && !(await approve(varRisk, opts.confirm))) throw stop(`Blocked: ${varRisk.summary}`);
    if (send !== base || Object.keys(set).length) {
      const risk = requestRisk(base, send, varsBefore, { ...varsBefore, ...set }, Object.keys(set));
      if (risk && !(await approve(risk, opts.confirm))) throw stop(`Blocked: ${risk.summary}`);
    }
    if (Object.keys(set).length) st.setVars(set);
  }

  const { req, res } = await sendItem(send, requestId, source, { ...opts, vars });
  results.push(...runAssertions(send.assertions, res, vars()));
  const extracted = runExtractions(send.extractions, res);
  let changed: Record<string, string> = { ...extracted };

  const post = path ? scriptChain(path, item, "post") : item.postScript?.trim() ? [{ label: "Request", code: item.postScript }] : [];
  if (post.length) {
    const varsBefore = vars();
    const set: Record<string, string> = {};
    const response = { status: res.status, statusText: res.statusText, headers: res.headers, body: res.bodyBase64 ? "" : res.body, timeMs: res.timeMs, size: res.size };
    const api = scriptSender(item.name ?? "", () => varsBefore, () => Object.keys(set), opts.confirm);
    for (const script of post) {
      const out = await runScript({ code: script.code, phase: "post", name: item.name ?? "", vars: { ...varsBefore, ...extracted, ...set }, request: requestView(send), response }, api);
      logs.push(...out.logs.map((l) => ({ ...l, phase: "post" as const })));
      results.push(...testResults(out, `Post-response${post.length > 1 ? ` (${script.label})` : ""}`));
      Object.assign(set, asVars(out.vars));
    }
    const risk = variableRisk(set, varsBefore, "post");
    // Declined: keep the response and the tests, drop the variables.
    if (risk && !(await approve(risk, opts.confirm))) results.push({ label: "Post-response script variables", pass: false, actual: `Not saved. ${risk.summary}` });
    else changed = { ...changed, ...set };
  }
  // One write for everything the response produced.
  if (Object.keys(changed).length) useStore.getState().setVars(changed);
  return { req, res, results, extracted: changed, logs };
}
