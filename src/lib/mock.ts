import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useStore } from "./store";
import type { HttpItem, Item } from "./types";

/** Mock servers per folder: its requests' saved examples, served on 127.0.0.1. */

export interface MockRoute {
  method: string;
  path: string;
  name: string;
  examples: { name: string; status: number; headers: [string, string][]; body: string }[];
}

export interface MockLog {
  mockId: string;
  method: string;
  path: string;
  status: number;
  example?: string;
  route?: string;
  ts: number;
}

/** The part of a request URL a client calls the mock with: "{{baseUrl}}/users/:id?x=1" → "/users/:id". */
export function mockPath(url: string): string {
  let u = url.trim().split(/[?#]/)[0].replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Whatever comes before the first slash is the host: a {{baseUrl}}, host:port, or domain.
  if (!u.startsWith("/")) u = u.includes("/") ? u.slice(u.indexOf("/")) : "";
  return u.replace(/\/+$/, "") || "/";
}

/** Routes for the HTTP requests under a folder (GraphQL requests are POSTs to their URL). */
export function mockRoutes(items: Item[], folder: string): MockRoute[] {
  return items
    .filter((i): i is Item & HttpItem => i.kind === "http" && i.path.startsWith(`${folder}/`))
    .map((i) => ({
      method: i.bodyMode === "graphql" && i.method === "GET" ? "POST" : i.method,
      path: mockPath(i.url),
      name: i.name,
      examples: (i.examples ?? []).map((e) => ({ name: e.name, status: e.status, headers: e.headers.filter((h) => h.enabled !== false).map((h) => [h.key, h.value] as [string, string]), body: e.body })),
    }));
}

interface MockState {
  running: Record<string, string>; // folder → URL
  logs: Record<string, MockLog[]>;
  /** Extra browser origins allowed per folder, besides pages served from localhost. */
  origins: Record<string, string[]>;
}

const savedOrigins = (): Record<string, string[]> => {
  try {
    return JSON.parse(localStorage.getItem("forge:mock-origins") ?? "{}");
  } catch {
    return {};
  }
};

export const useMocks = create<MockState>(() => ({ running: {}, logs: {}, origins: savedOrigins() }));

/** Parses "https://a.test, https://b.test" into origins; anything that isn't one is dropped. */
export function parseOrigins(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => /^https?:\/\/[^/\s]+$/i.test(o));
}

export function setMockOrigins(folder: string, origins: string[]) {
  useMocks.setState((s) => ({ origins: { ...s.origins, [folder]: origins } }));
  try {
    localStorage.setItem("forge:mock-origins", JSON.stringify(useMocks.getState().origins));
  } catch {
    /* remembered for this session only */
  }
  if (useMocks.getState().running[folder]) invoke("mock_update", { id: folder, routes: routesFor(folder), origins }).catch(() => {});
}

let listening = false;
function listenLogs() {
  if (listening) return;
  listening = true;
  listen<MockLog>("mock-log", (e) =>
    useMocks.setState((s) => ({ logs: { ...s.logs, [e.payload.mockId]: [e.payload, ...(s.logs[e.payload.mockId] ?? [])].slice(0, 200) } })),
  ).catch(() => (listening = false));
}

const routesFor = (folder: string) => mockRoutes(Object.values(useStore.getState().items), folder);

export async function startMock(folder: string, port = 4010) {
  listenLogs();
  const url = await invoke<string>("mock_start", { id: folder, port, routes: routesFor(folder), origins: useMocks.getState().origins[folder] ?? [] });
  useMocks.setState((s) => ({ running: { ...s.running, [folder]: url } }));
  return url;
}

export async function stopMock(folder: string) {
  await invoke("mock_stop", { id: folder }).catch(() => {});
  useMocks.setState((s) => {
    const { [folder]: _gone, ...running } = s.running;
    return { running };
  });
}

// Running mocks follow edits to their requests and examples, and stop when the workspace changes.
let timer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.root !== prev.root) {
    for (const f of Object.keys(useMocks.getState().running)) void stopMock(f);
    return;
  }
  if (s.items === prev.items || !Object.keys(useMocks.getState().running).length) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const f of Object.keys(useMocks.getState().running)) invoke("mock_update", { id: f, routes: routesFor(f), origins: useMocks.getState().origins[f] ?? [] }).catch(() => {});
  }, 300);
});
