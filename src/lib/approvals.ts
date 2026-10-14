import { create } from "zustand";

/** Questions waiting for the user ("Claude Code wants to run POST /orders"). One shown at a time. */

interface Pending {
  id: number;
  client: string;
  summary: string;
  /** Security prompts can't be skipped by trusting the client. */
  always?: boolean;
  resolve(ok: boolean): void;
}

interface ApprovalState {
  queue: Pending[];
  /** Clients the user trusted for the rest of this session. */
  trusted: Set<string>;
  request(client: string, summary: string, always?: boolean): Promise<boolean>;
  answer(id: number, ok: boolean, trustClient?: boolean): void;
}

let seq = 0;
/** Unanswered prompts expire as a "no" before the server stops waiting (600 s), so a stale prompt can never approve anything. */
export const APPROVAL_TIMEOUT_MS = 540_000;

export const useApprovals = create<ApprovalState>((set, get) => ({
  queue: [],
  trusted: new Set(),
  request(client, summary, always) {
    if (!always && get().trusted.has(client)) return Promise.resolve(true);
    const id = ++seq;
    setTimeout(() => get().answer(id, false), APPROVAL_TIMEOUT_MS);
    return new Promise((resolve) => set((s) => ({ queue: [...s.queue, { id, client, summary, always, resolve }] })));
  },
  answer(id, ok, trustClient) {
    const p = get().queue.find((x) => x.id === id);
    if (!p) return;
    const trusted = new Set(get().trusted);
    if (ok && trustClient) trusted.add(p.client);
    set((s) => ({ queue: s.queue.filter((x) => x.id !== id), trusted }));
    p.resolve(ok);
    // Anything else queued from a now-trusted client goes through.
    if (ok && trustClient) for (const q of get().queue.filter((x) => x.client === p.client && !x.always)) get().answer(q.id, true);
  },
}));

export const askApproval = (client: string, summary: string, always?: boolean) => useApprovals.getState().request(client, summary, always);
