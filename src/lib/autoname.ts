import { createSession } from "../agent/llm";
import { aiStatus, useStore } from "./store";
import type { Item } from "./types";

/**
 * Names new items from what they point at, like "List products" for GET /products.
 * Instant and offline; when an AI model is configured, the name is polished once after the
 * first successful response. Stops as soon as the user renames the item themselves.
 */

const DEFAULT = /^(new (request|mcp server|a2a agent|websocket|web check|agent test|item)|untitled)( copy)?( \d+)?$/i;

const VERBS: Record<string, string> = { GET: "Get", POST: "Create", PUT: "Replace", PATCH: "Update", DELETE: "Delete", HEAD: "Check", OPTIONS: "Options for" };
const ACTIONS = /^(search|login|logout|signin|signup|register|refresh|verify|validate|reset|confirm|cancel|approve|reject|publish|archive|restore|export|import|upload|download|sync|health|status|ping|me|count|stats|summary|token|callback|webhook|batch|bulk)$/i;
const NOISE = /^(api|rest|v\d+(\.\d+)?|public|private|internal|graphql|rpc|json)$/i;
// Placeholders, numbers, UUIDs, Mongo ids, and random-looking tokens (which contain digits).
const ID = /^(\{\{[^}]+\}\}|:\w+|\{[^}]+\}|\d+|[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}|[0-9a-f]{24}|(?=[A-Za-z]*\d)[A-Za-z0-9]{12,})$/;

const words = (s: string) =>
  s
    .replace(/\{\{|\}\}/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const singular = (w: string) =>
  /ies$/.test(w) ? w.replace(/ies$/, "y") : /(ss|sh|ch|x|z)es$/.test(w) ? w.slice(0, -2) : /(ss|us)$/.test(w) ? w : /s$/.test(w) ? w.slice(0, -1) : w;

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/\{\{[^}]+\}\}/g, "x")).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function suggestName(item: Item): string | null {
  switch (item.kind) {
    case "http": {
      if (item.bodyMode === "graphql") {
        const op = item.graphql.query.match(/\b(query|mutation|subscription)\s+(\w+)/);
        if (op) return `${cap(words(op[2]))}`;
        const field = item.graphql.query.match(/\{\s*(\w+)/);
        if (field) return `${/mutation/.test(item.graphql.query) ? "Mutate" : "Query"} ${words(field[1])}`;
      }
      const raw = item.url.trim();
      if (!raw || raw === "{{baseUrl}}") return null;
      const path = raw.replace(/^\{\{[^}]+\}\}/, "").replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0];
      const segs = path.split("/").filter((s) => s && !NOISE.test(s));
      if (!segs.length) return `${VERBS[item.method] ?? item.method} ${hostOf(raw) || "root"}`;
      const last = segs[segs.length - 1];
      const endsWithId = ID.test(last);
      const named = segs.filter((s) => !ID.test(s));
      const res = named[named.length - 1];
      if (!res) return `${VERBS[item.method] ?? item.method} by id`;
      if (!endsWithId && ACTIONS.test(res)) {
        const parent = named.length > 1 ? ` ${words(named[named.length - 2])}` : "";
        const a = res.toLowerCase();
        if (a === "me") return "Get current user";
        if (a === "health" || a === "status" || a === "ping") return `${cap(a)} check`;
        return `${cap(words(res))}${parent}`;
      }
      const noun = words(res);
      if (item.method === "GET") return endsWithId ? `Get ${singular(noun)}` : `List ${noun}`;
      if (item.method === "POST") return endsWithId ? `${cap(noun)} action` : `Create ${singular(noun)}`;
      return `${VERBS[item.method] ?? cap(item.method.toLowerCase())} ${endsWithId ? singular(noun) : noun}`;
    }
    case "mcp": {
      if (item.transport !== "stdio") return hostOf(item.url) ? `${hostOf(item.url)} MCP` : null;
      const args = item.args.split(/\s+/).filter((a) => a && !a.startsWith("-"));
      const pkg = args.find((a) => /mcp|server/i.test(a)) ?? args[args.length - 1] ?? item.command;
      if (!pkg) return null;
      const base = pkg
        .replace(/@[\w.-]+$/, "") // version
        .split(/[\\/]/)
        .pop()!
        .replace(/\.(m?js|py|ts)$/, "")
        .replace(/^(mcp-server-|server-|mcp-)/, "")
        .replace(/([-_](mcp|server))+$/, "");
      return base ? `${cap(words(base))} MCP` : null;
    }
    case "a2a":
      return item.url && hostOf(item.url) ? `${hostOf(item.url)} agent` : null;
    case "ws":
      return item.url && hostOf(item.url) ? `${hostOf(item.url)} socket` : null;
    case "web":
      return item.url && hostOf(item.url) ? `${hostOf(item.url)} check` : null;
    default:
      return null;
  }
}

/** The fields a name is derived from. */
const target = (it: Item) => {
  const x = it as any;
  return JSON.stringify([x.method, x.url, x.graphql?.query, x.command, x.args, x.transport]);
};

const auto = new Map<string, string>(); // path → name we gave it
const polished = new Set<string>();
const timers = new Map<string, number>();

const eligible = (it: Item) => DEFAULT.test(it.name) || auto.get(it.path) === it.name;

async function rename(path: string, name: string) {
  const st = useStore.getState();
  const it = st.items[path];
  if (!it || !eligible(it) || it.name === name) return;
  const to = await st.renameItem(path, name);
  auto.delete(path);
  auto.set(to, name);
}

/** Asks the configured model for a short name once the request has returned something. */
async function polish(path: string) {
  const st = useStore.getState();
  const it = st.items[path];
  const r = st.responses[path]?.res;
  const s = st.settings;
  if (!it || it.kind !== "http" || !r || r.status >= 400 || polished.has(path) || !eligible(it)) return;
  if (s.ai?.autoName === false || !aiStatus(s).ready) return;
  polished.add(path);
  const keys = (() => {
    try {
      const j = JSON.parse(r.body);
      const o = Array.isArray(j) ? j[0] : j;
      return o && typeof o === "object" ? Object.keys(o).slice(0, 15).join(", ") : "";
    } catch {
      return "";
    }
  })();
  try {
    const session = createSession(
      s,
      "You name API requests for a collection, like Postman users do. Reply with only the name: 2 to 5 words, Title case, no quotes or punctuation, starting with a verb when natural (List, Get, Create, Update, Delete, Search…).",
      [],
      `${it.method} ${it.url}\nStatus ${r.status}${keys ? `\nResponse fields: ${keys}` : ""}\nCurrent name: ${it.name}`,
    );
    const turn = await session.next();
    const name = turn.text.trim().split("\n")[0].replace(/^["'`]|["'`.]$/g, "").trim();
    if (name && name.length <= 48 && /^[\p{L}\p{N}][\p{L}\p{N} &/'()+-]*$/u.test(name)) await rename(path, name);
  } catch {
    /* naming is best-effort */
  }
}

export function installAutoName() {
  let prevItems = useStore.getState().items;
  let prevResponses = useStore.getState().responses;
  useStore.subscribe((s) => {
    if (s.items !== prevItems) {
      for (const [path, it] of Object.entries(s.items)) {
        // Only react to the user changing what the item points at; items appearing (workspace
        // opened, created, moved) or other edits leave the name alone.
        const prev = prevItems[path];
        if (!prev || prev === it || target(prev) === target(it) || !eligible(it)) continue;
        const name = suggestName(it);
        if (!name || name === it.name) continue;
        clearTimeout(timers.get(path));
        // Wait until typing pauses so the file isn't renamed on every keystroke.
        timers.set(path, window.setTimeout(() => rename(path, name), 1200));
      }
      prevItems = s.items;
    }
    if (s.responses !== prevResponses) {
      for (const [path, r] of Object.entries(s.responses)) if (r !== prevResponses[path] && r.res) void polish(path);
      prevResponses = s.responses;
    }
  });
}
