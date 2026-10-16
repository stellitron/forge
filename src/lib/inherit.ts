import { basename, useStore } from "./store";
import type { Auth, FolderSettings, HttpItem, KV } from "./types";

/**
 * What a request actually sends once its folders are taken into account: collection and folder
 * headers under its own, and its auth when set to inherit.
 */

const chainOf = (path: string, folders: Record<string, FolderSettings>) =>
  useStore.getState().folderChain(path).filter((p) => folders[p]).map((p) => ({ path: p, settings: folders[p] }));

/** The auth a request uses, and which folder it comes from (undefined: the request's own, or none). */
export function resolveAuth(path: string, own: Auth, folders = useStore.getState().folders): { auth: Auth; from?: string } {
  if (own.type !== "inherit") return { auth: own };
  for (const f of chainOf(path, folders).reverse()) if (f.settings.auth.type !== "inherit") return { auth: f.settings.auth, from: f.path };
  return { auth: { type: "none" } };
}

/** Folder headers, outermost first, each replaced by a closer one (or the request's own) of the same name. */
export function mergeHeaders(path: string, own: KV[], folders = useStore.getState().folders): KV[] {
  const out: KV[] = [];
  const has = (k: string) => own.some((h) => h.key.toLowerCase() === k.toLowerCase());
  for (const f of chainOf(path, folders).reverse())
    for (const h of f.settings.headers) if (h.enabled && h.key && !has(h.key) && !out.some((o) => o.key.toLowerCase() === h.key.toLowerCase())) out.unshift(h);
  return [...out, ...own];
}

/** Folder headers a request gets (those its own headers don't replace), with the folder each comes from. */
export function inheritedHeaders(path: string, own: KV[], folders = useStore.getState().folders): { key: string; value: string; from: string }[] {
  const merged = mergeHeaders(path, own, folders).slice(0, -own.length || undefined);
  return merged.map((h) => ({ key: h.key, value: h.value, from: [...chainOf(path, folders)].reverse().find((f) => f.settings.headers.some((x) => x === h))?.path ?? "" }));
}

export function effectiveItem<T extends HttpItem>(item: T & { path: string }, folders = useStore.getState().folders): T {
  const chain = chainOf(item.path, folders);
  if (!chain.length && item.auth.type !== "inherit") return item;
  return { ...item, headers: mergeHeaders(item.path, item.headers, folders), auth: resolveAuth(item.path, item.auth, folders).auth };
}

/** Collection and folder variables for a request (without the environment), closer folders winning. */
export function folderVars(path: string, folders = useStore.getState().folders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of chainOf(path, folders)) for (const v of f.settings.vars) if (v.enabled && v.key) out[v.key] = v.value;
  return out;
}

/** Scripts to run for a request, outermost folder first; each runs separately, like in Postman and Bruno. */
export function scriptChain(path: string, own: { preScript?: string; postScript?: string }, phase: "pre" | "post", folders = useStore.getState().folders): { label: string; code: string }[] {
  const key = phase === "pre" ? "preScript" : "postScript";
  return [
    ...chainOf(path, folders).map((f) => ({ label: `Folder "${basename(f.path)}"`, code: f.settings[key] ?? "" })),
    { label: "Request", code: own[key] ?? "" },
  ].filter((s) => s.code.trim());
}
