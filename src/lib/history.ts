import { create } from "zustand";
import { secretValues } from "../agent/egress";
import { sha256Sync } from "./crypto";
import { interpolate } from "./eval";
import { fs, http, uid, type RawRequest } from "./ipc";
import { useStore } from "./store";
import { defaults, type AssertionResult, type HttpItem, type HttpResponse } from "./types";
import { paramsFromUrl } from "./urlParams";

/**
 * Every request you send, kept per workspace in Forge's private app-data folder (never in the
 * workspace, so never in git). Secret values are turned back into their {{placeholders}} before
 * anything is stored, so the history file holds no tokens, and re-sending fills in today's values.
 */

export interface HistoryEntry {
  id: string;
  ts: number;
  /** The saved request it came from, if any. */
  path?: string;
  name: string;
  env?: string;
  source: string;
  req: RawRequest;
  res?: HttpResponse;
  results?: AssertionResult[];
  error?: string;
  /** The response body was cut to MAX_BODY. */
  truncated?: boolean;
}

export const MAX_ENTRIES = 300;
export const MAX_BODY = 256_000;

/** Header values that are credentials even when no variable holds them (a pasted token). */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
export const HIDDEN = "‹hidden›";

/** Replaces each secret value (and its URL-encoded form) with {{name}}, longest first. */
export function maskText(text: string, secrets: [string, string][]): string {
  let out = text;
  for (const [name, value] of [...secrets].sort((a, b) => b[1].length - a[1].length)) {
    if (value.length < 6) continue;
    out = out.split(value).join(`{{${name}}}`);
    const enc = encodeURIComponent(value);
    if (enc !== value) out = out.split(enc).join(`{{${name}}}`);
  }
  return out;
}

const maskHeaders = (headers: { key: string; value: string; enabled: boolean }[], secrets: [string, string][]) =>
  headers.map((h) => {
    const value = maskText(h.value, secrets);
    // Still a literal credential after masking: hide it rather than store it.
    return { ...h, value: CREDENTIAL_HEADER.test(h.key) && !value.includes("{{") ? HIDDEN : value };
  });

export function maskEntry(e: HistoryEntry, secrets: [string, string][]): HistoryEntry {
  const body = e.req.body;
  const req: RawRequest = {
    ...e.req,
    url: maskText(e.req.url, secrets),
    headers: maskHeaders(e.req.headers, secrets),
    body:
      body?.type === "raw" ? { ...body, content: maskText(body.content, secrets) }
      : body?.type === "form" || body?.type === "multipart" ? { ...body, fields: body.fields.map((f) => ({ ...f, value: maskText(f.value, secrets) })) }
      : body,
  };
  delete req.clientCert;
  let res = e.res;
  let truncated: boolean | undefined;
  if (res) {
    const raw = res.bodyBase64 ? "" : res.body;
    truncated = raw.length > MAX_BODY || undefined;
    res = { ...res, headers: maskHeaders(res.headers, secrets), body: maskText(raw.slice(0, MAX_BODY), secrets), bodyBase64: false };
  }
  return { ...e, req, res, truncated, error: e.error && maskText(e.error, secrets) };
}

interface HistoryState {
  root: string | null;
  entries: HistoryEntry[];
  load(root: string): Promise<void>;
  add(e: Omit<HistoryEntry, "id" | "ts">): HistoryEntry | null;
  remove(id: string): void;
  clear(): void;
}

const fileOf = (root: string) => `history-${sha256Sync(root).slice(0, 16)}.json`;
let timer: ReturnType<typeof setTimeout> | undefined;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const { root, entries } = useHistory.getState();
    if (root) fs.writeAppData(fileOf(root), JSON.stringify(entries)).catch(() => {});
  }, 400);
};

export const useHistory = create<HistoryState>((set, get) => ({
  root: null,
  entries: [],
  async load(root) {
    if (get().root === root) return;
    set({ root, entries: [] });
    try {
      const text = await fs.readAppData(fileOf(root));
      const entries = text ? (JSON.parse(text) as HistoryEntry[]) : [];
      if (get().root === root) set({ entries: Array.isArray(entries) ? entries : [] });
    } catch {
      /* unreadable history starts fresh */
    }
  },
  add(e) {
    const st = useStore.getState();
    if (st.settings.history?.enabled === false || !get().root) return null;
    const entry = maskEntry({ ...e, id: crypto.randomUUID(), ts: Date.now() }, secretValues());
    set((s) => ({ entries: [entry, ...s.entries].slice(0, MAX_ENTRIES) }));
    save();
    return entry;
  },
  remove(id) {
    set((s) => ({ entries: s.entries.filter((x) => x.id !== id) }));
    save();
  },
  clear() {
    set({ entries: [] });
    save();
  },
}));

/** Earlier responses of the same saved request, newest first (for Compare). */
export const historyOf = (path: string, entries = useHistory.getState().entries) => entries.filter((e) => e.path === path && e.res);

/** Fills today's values into a stored request's {{placeholders}}. Refuses if a credential was hidden. */
export function resolveEntry(e: HistoryEntry, vars: Record<string, string>): RawRequest {
  const v = (s: string) => interpolate(s, vars);
  const req = e.req;
  if (JSON.stringify(req).includes(HIDDEN)) throw new Error("A credential in this request was typed in directly, so history didn't keep it. Use Save as request and add it back.");
  const body = req.body;
  return {
    ...req,
    url: v(req.url),
    headers: req.headers.map((h) => ({ ...h, value: v(h.value) })),
    body:
      body?.type === "raw" ? { ...body, content: v(body.content) }
      : body?.type === "form" || body?.type === "multipart" ? { ...body, fields: body.fields.map((f) => ({ ...f, value: v(f.value) })) }
      : body,
  };
}

/** A saved request rebuilt from a history entry, keeping its {{placeholders}}. */
export function entryToItem(e: HistoryEntry): HttpItem {
  const d = defaults.http();
  d.method = e.req.method;
  // The URL keeps its query; the Params table mirrors it.
  d.url = e.req.url;
  d.params = paramsFromUrl(e.req.url, []);
  const ctype = e.req.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
  const auth = e.req.headers.find((h) => h.key.toLowerCase() === "authorization");
  const bearer = auth && /^bearer\s+(\{\{[^}]+\}\})$/i.exec(auth.value);
  if (bearer) d.auth = { type: "bearer", token: bearer[1] };
  d.headers = e.req.headers.filter((h) => !(bearer && h === auth) && !(e.req.body?.type === "form" && h.key.toLowerCase() === "content-type"));
  const b = e.req.body;
  if (b?.type === "raw") {
    d.bodyMode = /json/i.test(ctype) || (!ctype && /^\s*[[{]/.test(b.content)) ? "json" : /xml/i.test(ctype) ? "xml" : "text";
    d.body = b.content;
    if (d.bodyMode !== "text") d.headers = d.headers.filter((h) => h.key.toLowerCase() !== "content-type");
  } else if (b?.type === "form") {
    d.bodyMode = "form";
    d.form = b.fields;
  } else if (b?.type === "multipart") {
    d.bodyMode = "multipart";
    d.multipart = b.fields;
  } else if (b?.type === "binary") {
    d.bodyMode = "binary";
    d.body = b.path;
  }
  if (e.req.timeoutMs) d.settings = { ...d.settings, timeoutMs: e.req.timeoutMs, followRedirects: e.req.followRedirects ?? true, insecure: !!e.req.insecure };
  return d;
}

/** Sends a history entry again with today's variable values, and records the result as a new entry. */
export async function resendEntry(e: HistoryEntry): Promise<HistoryEntry | null> {
  const st = useStore.getState();
  const req = resolveEntry(e, st.vars());
  const env = st.envs.find((x) => x.path === st.activeEnv)?.name;
  try {
    const res = await http.send(uid(), req, "history");
    return useHistory.getState().add({ path: e.path, name: e.name, env, source: "history", req, res });
  } catch (err) {
    return useHistory.getState().add({ path: e.path, name: e.name, env, source: "history", req, error: err instanceof Error ? err.message : String(err) });
  }
}
