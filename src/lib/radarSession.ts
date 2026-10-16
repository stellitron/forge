import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { Capture } from "./radar";

/**
 * A running Website radar: a separate Chrome-family browser driven over the DevTools protocol.
 * Every page, popup and worker it opens is attached, so API calls are captured wherever the
 * user (or the agent) goes, including requests made while logging in.
 */

export interface Browser {
  name: string;
  path: string;
}

export const radarBrowsers = () => invoke<Browser[]>("radar_browsers");
export const clearRadarProfiles = () => invoke<void>("radar_clear_profiles");

interface RadarEvent {
  radarId: string;
  method: string;
  params: any;
  sessionId?: string;
}

interface Target {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

export interface RadarState {
  status: "idle" | "starting" | "open" | "closed";
  error?: string;
  browser?: string;
  /** False when DevTools listens on a loopback port (Windows) instead of a private pipe. */
  private?: boolean;
  captures: Capture[];
  /** URL of the page the agent drives (the most recent tab). */
  pageUrl: string;
}

/** UI state per radar item, kept outside the panel so switching tabs doesn't lose a capture. */
export const useRadars = create<{ s: Record<string, RadarState> }>(() => ({ s: {} }));

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const BODY_TYPES = /json|xml|text|graphql|javascript|x-www-form-urlencoded|event-stream/i;
const MAX_BODY = 100_000;
const WATCHED = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

/** A read in disguise: GraphQL queries are POSTs but don't change anything. */
export function readOnlyPost(postData?: string): boolean {
  if (!postData) return false;
  try {
    const j = JSON.parse(postData);
    const ops = Array.isArray(j) ? j : [j];
    return ops.length > 0 && ops.every((o) => o && typeof o.query === "string" && !/^\s*(mutation|subscription)\b/.test(o.query));
  } catch {
    return false;
  }
}

const sessions = new Map<string, RadarSession>();
let listening: Promise<unknown> | null = null;

function listenOnce() {
  listening ??= listen<RadarEvent>("radar-event", (e) => sessions.get(e.payload.radarId)?.handle(e.payload));
  return listening;
}

export class RadarSession {
  private targets = new Map<string, Target>();
  private pages: string[] = [];
  private byId = new Map<string, Capture>();
  private extra = new Map<string, Record<string, string>>();
  private inflight = new Set<string>();
  private guard: { allowWrites: boolean } | null = null;
  private agentActive = false;

  private constructor(readonly id: string) {}

  static get(id: string): RadarSession {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = new RadarSession(id)));
    return s;
  }

  get state(): RadarState {
    return useRadars.getState().s[this.id] ?? { status: "idle", captures: [], pageUrl: "" };
  }

  private set(patch: Partial<RadarState>) {
    useRadars.setState((st) => ({ s: { ...st.s, [this.id]: { ...this.state, ...patch } } }));
  }

  get running() {
    return this.state.status === "open";
  }

  /** The tab the agent works in. */
  get page(): string | undefined {
    return this.pages[this.pages.length - 1];
  }

  async start(url: string, browser?: string) {
    await listenOnce();
    this.targets.clear();
    this.pages = [];
    this.set({ status: "starting", error: undefined });
    try {
      // The browser opens a blank tab, so the first page load happens after capture is attached.
      const r = await invoke<{ browser: string; private: boolean }>("radar_start", { id: this.id, browser: browser || null });
      this.set({ status: "open", private: r.private, browser: r.browser.split(/[\\/]/).pop()?.replace(/\.(exe|app)$/i, "") });
      await this.send("Target.setDiscoverTargets", { discover: true });
      await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      for (let i = 0; i < 50 && !this.page; i++) await sleep(100);
      if (!this.page) throw new Error("The browser opened, but Forge couldn't attach to its tab.");
      await this.send("Page.navigate", { url }, this.page);
    } catch (e) {
      this.set({ status: this.running ? "open" : "idle", error: String(e instanceof Error ? e.message : e) });
    }
  }

  async stop() {
    await invoke("radar_stop", { id: this.id }).catch(() => {});
    this.set({ status: "closed" });
  }

  clear() {
    this.byId.clear();
    this.extra.clear();
    this.inflight.clear();
    this.set({ captures: [] });
  }

  send<T = any>(method: string, params?: unknown, sessionId?: string): Promise<T> {
    return invoke<T>("radar_send", { id: this.id, method, params: params ?? null, sessionId: sessionId ?? null });
  }

  /** While set, data-changing requests the page makes are blocked (and still recorded). */
  async setGuard(guard: { allowWrites: boolean } | null, agentActive: boolean) {
    this.guard = guard;
    this.agentActive = agentActive;
    for (const [sid, t] of this.targets) if (t.type === "page" || t.type === "iframe") await this.applyGuard(sid).catch(() => {});
  }

  private applyGuard(sid: string) {
    return this.guard && !this.guard.allowWrites
      ? this.send("Fetch.enable", { patterns: ["XHR", "Fetch", "Document"].map((resourceType) => ({ urlPattern: "*", resourceType, requestStage: "Request" })) }, sid)
      : this.send("Fetch.disable", {}, sid);
  }

  /** Waits until the page's API calls settle (or `maxMs` passes). */
  async idle(maxMs = 6000) {
    const end = Date.now() + maxMs;
    await sleep(500);
    let quietSince = Date.now();
    while (Date.now() < end) {
      if (this.inflight.size) quietSince = Date.now();
      else if (Date.now() - quietSince > 500) return;
      await sleep(100);
    }
  }

  private publish() {
    this.set({ captures: [...this.byId.values()] });
  }

  private publishSoon = debounce(() => this.publish(), 150);

  /** @internal Called for each forwarded DevTools event. */
  handle(e: RadarEvent) {
    const p = e.params;
    const sid = e.sessionId ?? "";
    const key = (rid: string) => `${sid}:${rid}`;
    switch (e.method) {
      case "Radar.closed":
        this.targets.clear();
        this.pages = [];
        this.inflight.clear();
        if (this.state.status !== "idle") this.set({ status: "closed" });
        return;
      case "Target.attachedToTarget":
        return void this.attach(p.sessionId, p.targetInfo).catch(() => {});
      case "Target.detachedFromTarget":
        this.targets.delete(p.sessionId);
        this.pages = this.pages.filter((s) => s !== p.sessionId);
        this.set({ pageUrl: this.page ? (this.targets.get(this.page)?.url ?? "") : "" });
        return;
      case "Target.targetInfoChanged":
        for (const t of this.targets.values()) if (t.targetId === p.targetInfo.targetId) Object.assign(t, { url: p.targetInfo.url, title: p.targetInfo.title });
        if (this.page) this.set({ pageUrl: this.targets.get(this.page)?.url ?? "" });
        return;
      case "Page.frameNavigated":
        if (!p.frame.parentId && this.targets.has(sid)) {
          this.targets.get(sid)!.url = p.frame.url;
          if (sid === this.page) this.set({ pageUrl: p.frame.url });
        }
        return;
      case "Fetch.requestPaused":
        return void this.paused(sid, p);
      case "Network.requestWillBeSent": {
        const r = p.request;
        const k = key(p.requestId);
        const c: Capture = {
          id: k,
          method: String(r.method).toUpperCase(),
          url: r.url + (r.urlFragment ?? ""),
          type: p.type ?? "Other",
          requestHeaders: { ...r.headers, ...this.extra.get(k) },
          postData: r.postData,
          page: this.targets.get(sid)?.url ?? p.documentURL ?? "",
          ts: Date.now(),
          byAgent: this.agentActive || undefined,
        };
        if (c.type === "Document" || c.type === "Preflight" || c.type === "Ping") return;
        this.extra.delete(k);
        this.byId.set(k, c);
        this.inflight.add(k);
        if (r.hasPostData && r.postData == null)
          this.send("Network.getRequestPostData", { requestId: p.requestId }, sid)
            .then((x) => ((c.postData = x.postData), this.publishSoon()))
            .catch(() => {});
        return this.publishSoon();
      }
      case "Network.requestWillBeSentExtraInfo": {
        // The headers actually sent, cookies included; may arrive before or after the request.
        const c = this.byId.get(key(p.requestId));
        if (c) c.requestHeaders = { ...c.requestHeaders, ...p.headers };
        else this.extra.set(key(p.requestId), p.headers);
        if (this.extra.size > 2000) this.extra.clear();
        return;
      }
      case "Network.responseReceived": {
        const c = this.byId.get(key(p.requestId));
        if (!c) return;
        c.status = p.response.status;
        c.mimeType = p.response.mimeType;
        c.responseHeaders = p.response.headers;
        return this.publishSoon();
      }
      case "Network.loadingFinished": {
        const c = this.byId.get(key(p.requestId));
        if (!c) return;
        if (!BODY_TYPES.test(c.mimeType ?? "") || p.encodedDataLength > MAX_BODY * 4) return this.done(key(p.requestId));
        this.send("Network.getResponseBody", { requestId: p.requestId }, sid)
          .then((b) => {
            if (!b.base64Encoded) c.responseBody = String(b.body).slice(0, MAX_BODY);
          })
          .catch(() => {})
          .finally(() => this.done(key(p.requestId)));
        return;
      }
      case "Network.loadingFailed": {
        const c = this.byId.get(key(p.requestId));
        if (!c) return;
        c.failed = p.blockedReason ?? p.errorText ?? "failed";
        if (/BLOCKED_BY_CLIENT/.test(p.errorText ?? "") && this.guard) c.blocked = true;
        return this.done(key(p.requestId));
      }
    }
  }

  private done(k: string) {
    this.inflight.delete(k);
    this.publishSoon();
  }

  private async attach(sid: string, info: { type: string; url: string; title: string; targetId: string }) {
    // Chrome's own UI and extensions get attached too; only the web app matters.
    if (!WATCHED.has(info.type) || /^(chrome|chrome-extension|devtools|edge|brave):/.test(info.url)) return this.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
    this.targets.set(sid, { targetId: info.targetId, type: info.type, url: info.url, title: info.title });
    if (info.type === "page") {
      this.pages.push(sid);
      this.set({ pageUrl: info.url });
    }
    try {
      await this.send("Network.enable", { maxPostDataSize: 65536 }, sid);
      if (info.type === "page" || info.type === "iframe") {
        await this.send("Page.enable", {}, sid).catch(() => {});
        await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
        if (this.guard) await this.applyGuard(sid).catch(() => {});
      }
    } finally {
      await this.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
    }
  }

  private async paused(sid: string, p: any) {
    const method = String(p.request.method).toUpperCase();
    const allowed = !this.guard || this.guard.allowWrites || SAFE.has(method) || readOnlyPost(p.request.postData);
    if (allowed) return this.send("Fetch.continueRequest", { requestId: p.requestId }, sid).catch(() => {});
    if (p.networkId) {
      const c = this.byId.get(`${sid}:${p.networkId}`);
      if (c) c.blocked = true;
    }
    await this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sid).catch(() => {});
    this.publishSoon();
  }

  /** Runs `expression` in the agent's tab and returns its value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (!this.page) throw new Error("No open tab in the radar browser");
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.page);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Script error");
    return r.result?.value as T;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function debounce(fn: () => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
