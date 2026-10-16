import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { executeHttp } from "../lib/execute";
import { uid } from "../lib/ipc";
import { COLLECTIONS, useStore } from "../lib/store";
import type { AssertionResult, Environment, HttpItem, Item, KV } from "../lib/types";

/**
 * Runs saved requests from a workspace, the same way the desktop app's runner does: the same
 * request building, auth, tests and captured values. Nothing in the workspace is changed.
 */

export interface RunOptions {
  workspace: string;
  /** Collection, folder or request paths, e.g. "Shop" or "Shop/Users/List users". Empty runs everything. */
  targets: string[];
  /** Environment name or file name. */
  env?: string;
  /** Values that override the environment, from --var and FORGE_VAR_* (CI secrets). */
  vars: Record<string, string>;
  /** One run per row, each row's values overriding the rest. */
  data?: Record<string, string>[];
  iterations: number;
  bail: boolean;
  timeoutMs?: number;
  insecure?: boolean;
  /** Allow script changes that point requests at new hosts; refused otherwise, as there's no one to ask. */
  trustScripts?: boolean;
  delayMs: number;
}

export interface RequestResult {
  path: string;
  folder: string;
  name: string;
  method: string;
  /** The URL as written, with {{placeholders}}; resolved values never appear in reports. */
  url: string;
  iteration: number;
  status?: number;
  timeMs?: number;
  error?: string;
  tests: AssertionResult[];
  passed: boolean;
  /** console output from the request's scripts. */
  logs?: string[];
}

export interface RunResult {
  workspace: string;
  env: string | null;
  results: RequestResult[];
  skipped: { path: string; kind: string }[];
  durationMs: number;
  /** Values to mask in any output. */
  secrets: string[];
}

export class UsageError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripJson = (p: string) => p.replace(/\.json$/, "");

/** Reads --data: a JSON array of objects, or CSV with a header row. */
export function readData(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8");
  if (/\.json$/i.test(path) || /^\s*\[/.test(text)) {
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new UsageError(`${path} must contain a JSON array of objects.`);
    return rows.map((r) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])));
  }
  if (/\.ya?ml$/i.test(path)) return readDataFromValue(parseYaml(text), path);
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const cells = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (q && ch === '"' && line[k + 1] === '"') (cur += '"'), k++;
      else if (ch === '"') q = !q;
      else if (ch === "," && !q) out.push(cur), (cur = "");
      else cur += ch;
    }
    return [...out, cur];
  };
  const [head, ...rows] = lines;
  if (!head) return [];
  const keys = cells(head).map((k) => k.trim());
  return rows.map((r) => Object.fromEntries(cells(r).map((v, k) => [keys[k], v])));
}

function readDataFromValue(v: unknown, path: string): Record<string, string>[] {
  if (!Array.isArray(v)) throw new UsageError(`${path} must contain a list of objects.`);
  return v.map((r) => Object.fromEntries(Object.entries(r ?? {}).map(([k, x]) => [k, String(x)])));
}

function pickEnv(envs: Environment[], name?: string): Environment | null {
  if (!name) return null;
  const want = stripJson(name.toLowerCase().split("/").pop()!);
  const env = envs.find((e) => e.name.toLowerCase() === name.toLowerCase() || stripJson(e.path.split("/").pop()!.toLowerCase()) === want);
  if (!env) throw new UsageError(`No environment "${name}". Available: ${envs.map((e) => e.name).join(", ") || "none"}.`);
  return env;
}

/** Requests matching the targets, in file order like the app's runner. */
export function selectItems(items: Record<string, Item>, targets: string[]): { run: (Item & HttpItem)[]; skipped: Item[] } {
  const all = Object.values(items).sort((a, b) => a.path.localeCompare(b.path));
  const norm = (t: string) => stripJson(t.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(new RegExp(`^${COLLECTIONS}/`), ""));
  const rel = (p: string) => stripJson(p.slice(COLLECTIONS.length + 1));
  const wanted = targets.map(norm).filter(Boolean);
  const chosen = wanted.length
    ? all.filter((i) => wanted.some((t) => {
        const r = rel(i.path).toLowerCase();
        const w = t.toLowerCase();
        return r === w || r.startsWith(`${w}/`);
      }))
    : all;
  for (const t of wanted) if (!all.some((i) => rel(i.path).toLowerCase() === t.toLowerCase() || rel(i.path).toLowerCase().startsWith(`${t.toLowerCase()}/`)))
    throw new UsageError(`Nothing matches "${t}". Paths are relative to collections/, for example "${rel(all[0]?.path ?? "collections/Shop/Users/List users")}".`);
  return { run: chosen.filter((i): i is Item & HttpItem => i.kind === "http"), skipped: chosen.filter((i) => i.kind !== "http") };
}

export async function runCollection(opts: RunOptions, onResult?: (r: RequestResult, secrets: string[]) => void): Promise<RunResult> {
  const started = performance.now();
  const st = useStore.getState();
  await st.openWorkspace(opts.workspace);
  const { items, envs, root } = useStore.getState();
  if (!Object.keys(items).length) throw new UsageError(`No requests found in ${root}. Point --workspace at a Forge workspace folder (the one with collections/ in it).`);

  const env = pickEnv(envs, opts.env);
  // Overrides live in the environment's secrets (in memory), so they win over its values and
  // captured values flow between requests exactly as in the app.
  const base: Environment = env ? { ...env, vars: [...env.vars], secrets: [...env.secrets] } : { name: "CLI", path: "environments/.cli.json", vars: [], secrets: [] };
  const withOverrides = (extra: Record<string, string>): Environment => {
    const secrets: KV[] = [...base.secrets];
    for (const [key, value] of Object.entries({ ...opts.vars, ...extra })) {
      const i = secrets.findIndex((s) => s.key === key);
      if (i >= 0) secrets[i] = { key, value, enabled: true };
      else secrets.push({ key, value, enabled: true });
    }
    return { ...base, secrets };
  };

  const { run, skipped } = selectItems(items, opts.targets);
  const rows = opts.data?.length ? opts.data : Array.from({ length: Math.max(1, opts.iterations) }, () => ({}));
  const secretSet = new Set<string>([...base.secrets.map((s) => s.value), ...Object.values(opts.vars)].filter((v) => v && v.length >= 4));
  const results: RequestResult[] = [];

  outer: for (let it = 0; it < rows.length; it++) {
    const e = withOverrides(rows[it]);
    useStore.setState({ envs: [...envs.filter((x) => x.path !== e.path), e], activeEnv: e.path, sessionVars: {} });
    for (const original of run) {
      const item: Item & HttpItem = {
        ...original,
        settings: { ...original.settings, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.insecure ? { insecure: true } : {}) },
      };
      const rel = item.path.slice(COLLECTIONS.length + 1);
      const r: RequestResult = {
        path: rel,
        folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
        name: item.name,
        method: item.method,
        url: item.url,
        iteration: it + 1,
        tests: [],
        passed: false,
      };
      try {
        const { res, results: tests, extracted, logs } = await executeHttp(item, uid(), "cli", { interactive: false, confirm: opts.trustScripts ? async () => true : undefined });
        r.status = res.status;
        r.timeMs = Math.round(res.timeMs);
        r.tests = tests;
        if (logs.length) r.logs = logs.map((l) => l.text);
        for (const v of Object.values(extracted)) if (v.length >= 8) secretSet.add(v);
        r.passed = r.tests.every((t) => t.pass);
      } catch (err) {
        r.error = err instanceof Error ? err.message : String(err);
        const logs = (err as { logs?: { text: string }[] }).logs;
        if (logs?.length) r.logs = logs.map((l) => l.text);
      }
      // Anything that looks like a credential (by name) is masked in output from now on.
      for (const [k, v] of Object.entries(useStore.getState().vars())) if (v && v.length >= 6 && /token|secret|key|pass|auth|cookie|session|credential/i.test(k)) secretSet.add(v);
      results.push(r);
      onResult?.(r, [...secretSet].sort((a, b) => b.length - a.length));
      if (opts.bail && !r.passed) break outer;
      if (opts.delayMs) await sleep(opts.delayMs);
    }
  }

  return {
    workspace: root ?? opts.workspace,
    env: env?.name ?? null,
    results,
    skipped: skipped.map((s) => ({ path: s.path.slice(COLLECTIONS.length + 1), kind: s.kind })),
    durationMs: Math.round(performance.now() - started),
    secrets: [...secretSet].sort((a, b) => b.length - a.length),
  };
}

/** Replaces every secret value with *** in text that leaves the process. */
export function masker(secrets: string[]) {
  return (text: string) => {
    let out = text;
    for (const s of secrets) {
      if (!s) continue;
      out = out.split(s).join("***");
      const enc = encodeURIComponent(s);
      if (enc !== s) out = out.split(enc).join("***");
    }
    return out;
  };
}
