import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Loader2, RotateCcw, Search, Send } from "lucide-react";
import * as A2A from "../lib/a2a";
import { interpolate } from "../lib/eval";
import { useStore } from "../lib/store";
import type { A2AItem, Item, KV } from "../lib/types";
import { Editor, KvTable, Seg, Split } from "../components/ui";

interface Msg {
  role: "user" | "agent" | "sys";
  text: string;
}
interface Live {
  card?: A2A.AgentCard;
  cardUrl?: string;
  error?: string;
  loading?: boolean;
  busy?: boolean;
  contextId?: string;
  taskId?: string;
  msgs: Msg[];
  events: unknown[];
}

const useLive = create<{ s: Record<string, Live>; patch: (id: string, p: Partial<Live> | ((l: Live) => Partial<Live>)) => void }>((set) => ({
  s: {},
  patch: (id, p) =>
    set((st) => {
      const cur = st.s[id] ?? { msgs: [], events: [] };
      return { s: { ...st.s, [id]: { ...cur, ...(typeof p === "function" ? p(cur) : p) } } };
    }),
}));

export default function A2APanel({ item }: { item: Item & A2AItem }) {
  const update = useStore((s) => s.updateItem);
  const live = useLive((s) => s.s[item.path]) ?? { msgs: [], events: [] };
  const patch = useLive((s) => s.patch);
  const [tab, setTab] = useState<"chat" | "card" | "events" | "headers">("chat");
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const id = item.path;
  const headers = (): KV[] => item.headers.map((h) => ({ ...h, value: interpolate(h.value, useStore.getState().vars()) }));

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [live.msgs.length]);

  const discover = async () => {
    patch(id, { loading: true, error: undefined });
    try {
      const { card, cardUrl } = await A2A.fetchCard(interpolate(item.url, useStore.getState().vars()), headers());
      patch(id, { card, cardUrl, loading: false });
      // Name a fresh item after the agent it talks to.
      if (card.name && /^new a2a agent( \d+)?$|^[\w.-]+\.[a-z]{2,} agent$/i.test(item.name)) useStore.getState().renameItem(item.path, card.name);
      if (!card.capabilities?.streaming) setStreaming(false);
    } catch (e) {
      patch(id, { error: String(e), loading: false });
    }
  };

  const send = async () => {
    const msg = text.trim();
    if (!msg || live.busy) return;
    setText("");
    const endpoint = live.card?.url || interpolate(item.url, useStore.getState().vars());
    const params = { message: A2A.userMessage(msg, live.contextId, live.taskId) };
    patch(id, (l) => ({ busy: true, msgs: [...l.msgs, { role: "user", text: msg }] }));
    const track = (r: any) => {
      if (!r || typeof r !== "object") return;
      const terminal = ["completed", "canceled", "failed", "rejected"].includes(r.status?.state);
      patch(id, {
        contextId: r.contextId ?? useLive.getState().s[id]?.contextId,
        taskId: r.kind === "task" || r.taskId ? (terminal ? undefined : (r.taskId ?? r.id)) : undefined,
      });
    };
    if (streaming) {
      let acc = "";
      patch(id, (l) => ({ msgs: [...l.msgs, { role: "agent", text: "" }] }));
      await A2A.stream(
        endpoint,
        params,
        headers(),
        (ev: any) => {
          patch(id, (l) => ({ events: [...l.events, ev] }));
          if (ev?.error) acc += `\n[error] ${ev.error.message}`;
          const r = ev?.result;
          track(r);
          const t = A2A.textOf(r);
          if (t) acc = r?.kind === "artifact-update" && r.append ? acc + t : r?.kind === "status-update" && acc ? acc : t || acc;
          if (r?.kind === "status-update" && r.status?.state && !t) acc = acc || `(${r.status.state})`;
          patch(id, (l) => ({ msgs: [...l.msgs.slice(0, -1), { role: "agent", text: acc }] }));
        },
        (err) => {
          patch(id, (l) => ({ busy: false, msgs: err ? [...l.msgs, { role: "sys", text: `Stream error: ${err}` }] : l.msgs }));
        },
      );
    } else {
      try {
        const r = await A2A.call(endpoint, "message/send", params, headers());
        track(r.result);
        patch(id, (l) => ({
          busy: false,
          events: [...l.events, r],
          msgs: [...l.msgs, r.error ? { role: "sys", text: `Error ${r.error.code}: ${r.error.message}` } : { role: "agent", text: A2A.textOf(r.result) || JSON.stringify(r.result, null, 2) }],
        }));
      } catch (e) {
        patch(id, (l) => ({ busy: false, msgs: [...l.msgs, { role: "sys", text: String(e) }] }));
      }
    }
  };

  const card = live.card;
  return (
    <div className="panel">
      <div className="urlbar">
        <div className="group">
          <input value={item.url} onChange={(e) => update(item.path, { url: e.target.value })} placeholder="https://agent.example.com  (agent card is discovered at /.well-known/agent-card.json)" spellCheck={false} />
        </div>
        <button className="btn primary" onClick={discover} disabled={live.loading}>
          {live.loading ? <Loader2 size={14} className="spin" /> : <Search size={14} />} Discover
        </button>
      </div>
      <div className="row" style={{ padding: "0 14px 10px" }}>
        {card ? (
          <span>
            <b>{card.name}</b> <span className="muted">v{card.version} · protocol {card.protocolVersion ?? "?"} · {card.skills?.length ?? 0} skills</span>
          </span>
        ) : (
          <span className={live.error ? "err" : "muted"}>{live.error ?? "Discover the agent card, or just start chatting with the URL above."}</span>
        )}
        <div className="spacer" />
        <label className="check">
          <input type="checkbox" checked={streaming} onChange={(e) => setStreaming(e.target.checked)} /> Stream
        </label>
        <button className="btn ghost sm" onClick={() => patch(id, { msgs: [], events: [], contextId: undefined, taskId: undefined })}>
          <RotateCcw size={12} /> New conversation
        </button>
      </div>
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { id: "chat", label: "Conversation" },
          { id: "card", label: "Agent card" },
          { id: "events", label: "Raw events", count: live.events.length },
          { id: "headers", label: "Headers", count: item.headers.length },
        ]}
      />
      {tab === "chat" && (
        <>
          <div className="scroll grow col" style={{ padding: 16, gap: 10 }}>
            {!live.msgs.length && <div className="empty">Messages are sent with JSON-RPC message/{streaming ? "stream" : "send"}. Context is kept across turns.</div>}
            {live.msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                {m.text || <Loader2 size={14} className="spin" />}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div className="row" style={{ padding: 12, borderTop: "1px solid var(--line)" }}>
            <textarea
              className="textarea grow"
              rows={2}
              value={text}
              placeholder={card?.skills?.[0]?.examples?.[0] ?? "Message the agent…  (↵ to send, ⇧↵ for newline)"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
            />
            <button className="btn primary" onClick={send} disabled={live.busy}>
              {live.busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            </button>
          </div>
          {live.contextId && <div className="muted mono" style={{ padding: "0 12px 8px", fontSize: 11 }}>context {live.contextId}{live.taskId ? ` · task ${live.taskId}` : ""}</div>}
        </>
      )}
      {tab === "card" &&
        (card ? (
          <Split
            id="a2a-card"
            a={
              <div className="scroll pad col">
                <div>{card.description}</div>
                <div className="muted mono">{live.cardUrl}</div>
                <div>
                  {Object.entries(card.capabilities ?? {}).map(([k, v]) => (
                    <span className="tag" key={k}>
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
                <h3>Skills</h3>
                {(card.skills ?? []).map((s) => (
                  <div className="card" key={s.id}>
                    <b>{s.name}</b> <span className="muted mono">{s.id}</span>
                    <div className="dim" style={{ margin: "4px 0" }}>{s.description}</div>
                    {s.tags?.map((t) => (
                      <span className="tag" key={t}>
                        {t}
                      </span>
                    ))}
                    {s.examples?.map((ex) => (
                      <div key={ex} className="list-item mono" style={{ fontSize: 12 }} onClick={() => (setText(ex), setTab("chat"))}>
                        ↳ {ex}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            }
            b={<Editor readOnly value={JSON.stringify(card, null, 2)} />}
          />
        ) : (
          <div className="empty">Click Discover to load the agent card.</div>
        ))}
      {tab === "events" && <Editor readOnly value={live.events.map((e) => JSON.stringify(e, null, 2)).join("\n\n")} />}
      {tab === "headers" && <KvTable rows={item.headers} onChange={(headers) => update(item.path, { headers })} keyPh="Header" />}
    </div>
  );
}
