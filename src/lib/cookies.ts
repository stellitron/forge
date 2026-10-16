import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { sha256Sync } from "./crypto";
import { afterSend, fs } from "./ipc";
import { useStore } from "./store";

/**
 * The cookie jar, one per environment: switching environments swaps the cookies, so a staging
 * login doesn't follow you to production. Jars are saved in Forge's private app-data folder,
 * never in the workspace, and only kept in memory when "Keep cookies" is off.
 */

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; null for a session cookie. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
}

export const cookieJar = {
  list: () => invoke<Cookie[]>("cookies_list"),
  set: (cookie: Cookie) => invoke<void>("cookies_set", { cookie }),
  remove: (c: Pick<Cookie, "domain" | "path" | "name">) => invoke<void>("cookies_delete", { domain: c.domain, path: c.path, name: c.name }),
  clear: () => invoke<void>("http_reset_cookies"),
};

/** Bumped whenever the jar may have changed, so open views refresh. */
export const useCookieVersion = create<{ v: number }>(() => ({ v: 0 }));
const changed = () => useCookieVersion.setState((s) => ({ v: s.v + 1 }));

const keyOf = (root: string, env: string | null) => `cookies-${sha256Sync(`${root}\n${env ?? ""}`).slice(0, 16)}.json`;
const memory = new Map<string, string>();
let current: string | null = null;
let chain: Promise<unknown> = Promise.resolve();
const persist = () => useStore.getState().settings.cookies?.persist !== false;

async function save(key: string) {
  const text = await invoke<string>("cookies_export");
  memory.set(key, text);
  if (persist()) await fs.writeAppData(key, text);
}

async function switchTo(key: string | null) {
  if (key === current) return;
  if (current) await save(current).catch(() => {});
  current = key;
  let text = key ? (memory.get(key) ?? "") : "";
  if (key && !memory.has(key) && persist()) text = await fs.readAppData(key).catch(() => "");
  await invoke("cookies_import", { text }).catch(() => {});
  changed();
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Saves the current jar soon (after sends and edits). */
export function saveCookiesSoon() {
  changed();
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (current) chain = chain.then(() => save(current!)).catch(() => {});
  }, 800);
}

/** Starts following the workspace and active environment. Call once from the app. */
export function startCookieJars() {
  const sync = () => {
    const { root, activeEnv } = useStore.getState();
    chain = chain.then(() => switchTo(root ? keyOf(root, activeEnv) : null));
  };
  sync();
  useStore.subscribe((s, prev) => {
    if (s.root !== prev.root || s.activeEnv !== prev.activeEnv) sync();
  });
  afterSend.add(saveCookiesSoon);
}
