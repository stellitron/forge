import { create } from "zustand";
import type { HttpResponse } from "./types";
import type { RawRequest } from "./ipc";

/** In-memory log of everything Forge sends and receives, shown in the Console drawer. Never written to disk. */

export type ConsoleKind = "http" | "mcp" | "a2a" | "ws" | "server" | "log";

export interface ConsoleEntry {
  id: string;
  ts: number;
  kind: ConsoleKind;
  level: "info" | "warn" | "error";
  /** Who triggered it: "request", "agent", "chat", "runner", "Claude Code"… */
  source: string;
  title: string;
  status?: number | string;
  ms?: number;
  size?: number;
  request?: RawRequest;
  response?: HttpResponse;
  detail?: unknown;
}

const MAX = 1000;
let seq = 0;

interface ConsoleState {
  entries: ConsoleEntry[];
  open: boolean;
  unseenErrors: number;
  add(e: Omit<ConsoleEntry, "id" | "ts"> & { ts?: number }): string;
  patch(id: string, p: Partial<ConsoleEntry>): void;
  clear(): void;
  toggle(open?: boolean): void;
}

export const useConsole = create<ConsoleState>((set) => ({
  entries: [],
  open: false,
  unseenErrors: 0,
  add(e) {
    const id = `c${++seq}`;
    set((s) => ({
      entries: [...s.entries.slice(-(MAX - 1)), { ts: Date.now(), ...e, id }],
      unseenErrors: s.open || e.level !== "error" ? s.unseenErrors : s.unseenErrors + 1,
    }));
    return id;
  },
  patch(id, p) {
    set((s) => {
      const err = p.level === "error" && !s.open;
      return { entries: s.entries.map((x) => (x.id === id ? { ...x, ...p } : x)), unseenErrors: s.unseenErrors + (err ? 1 : 0) };
    });
  },
  clear: () => set({ entries: [], unseenErrors: 0 }),
  toggle: (open) => set((s) => ({ open: open ?? !s.open, unseenErrors: 0 })),
}));

export const logConsole = (e: Omit<ConsoleEntry, "id" | "ts">) => useConsole.getState().add(e);

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;

/** Masks credentials, e.g. before showing an entry to an LLM. */
export const redactHeaders = (h: { key: string; value: string }[]) =>
  h.map((x) => (SECRET_HEADER.test(x.key) ? { ...x, value: x.value ? `${x.value.slice(0, 6)}… (redacted)` : "" } : x));
export const isSecretHeader = (k: string) => SECRET_HEADER.test(k);
