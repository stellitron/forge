import { useState } from "react";
import { create } from "zustand";
import { Plug, PlugZap, Send, Trash2 } from "lucide-react";
import { interpolate } from "../lib/eval";
import { onWsEvent, ws, type WsEvent } from "../lib/ipc";
import { useStore } from "../lib/store";
import type { Item, WsItem } from "../lib/types";
import { Editor, KvTable, Seg, Split, fmtTime } from "../components/ui";
import { usePaneDir } from "../components/PaneLayout";

const useLive = create<{ open: Record<string, boolean>; log: Record<string, WsEvent[]> }>(() => ({ open: {}, log: {} }));

onWsEvent((e) => {
  useLive.setState((s) => ({
    log: { ...s.log, [e.connId]: [...(s.log[e.connId] ?? []).slice(-1999), e] },
    open: { ...s.open, [e.connId]: e.kind === "open" ? true : e.kind === "close" || e.kind === "error" ? false : (s.open[e.connId] ?? false) },
  }));
});

export default function WsPanel({ item }: { item: Item & WsItem }) {
  const update = useStore((s) => s.updateItem);
  const paneDir = usePaneDir();
  const open = useLive((s) => s.open[item.path] ?? false);
  const log = useLive((s) => s.log[item.path] ?? []);
  const [tab, setTab] = useState<"message" | "headers">("message");
  const [error, setError] = useState("");
  const id = item.path;

  const connect = async () => {
    setError("");
    const vars = useStore.getState().vars();
    try {
      await ws.connect(id, interpolate(item.url, vars), item.headers.map((h) => ({ ...h, value: interpolate(h.value, vars) })));
    } catch (e) {
      setError(String(e));
    }
  };
  const send = () => ws.send(id, interpolate(item.message, useStore.getState().vars())).catch((e) => setError(String(e)));

  const arrow: Record<WsEvent["kind"], string> = { out: "↑", in: "↓", open: "●", close: "○", error: "!" };
  return (
    <div className="panel">
      <div className="urlbar">
        <div className="group">
          <input value={item.url} onChange={(e) => update(id, { url: e.target.value })} placeholder="wss://echo.websocket.org" spellCheck={false} />
        </div>
        {open ? (
          <button className="btn" onClick={() => ws.close(id)}>
            <PlugZap size={14} /> Disconnect
          </button>
        ) : (
          <button className="btn primary" onClick={connect}>
            <Plug size={14} /> Connect
          </button>
        )}
      </div>
      {error && <div className="err" style={{ padding: "0 14px 8px" }}>{error}</div>}
      <Split
        id={`ws-${paneDir}`}
        dir={paneDir}
        a={
          <>
            <Seg
              value={tab}
              onChange={setTab}
              options={[
                { id: "message", label: "Message" },
                { id: "headers", label: "Headers", count: item.headers.length },
              ]}
              right={
                tab === "message" && (
                  <button className="btn primary sm" disabled={!open} onClick={send}>
                    <Send size={12} /> Send
                  </button>
                )
              }
            />
            {tab === "message" ? (
              <Editor value={item.message} onChange={(message) => update(id, { message })} placeholder='{"type": "subscribe", "channel": "ticker"}' />
            ) : (
              <KvTable rows={item.headers} onChange={(headers) => update(id, { headers })} keyPh="Header" />
            )}
          </>
        }
        b={
          <>
            <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
              <h3 className="grow">Messages</h3>
              <span className={open ? "ok" : "muted"}>{open ? "connected" : "closed"}</span>
              <button className="btn ghost icon sm" onClick={() => useLive.setState((s) => ({ log: { ...s.log, [id]: [] } }))}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="scroll log grow">
              {log.map((l, i) => (
                <div className="line" key={i}>
                  <span className="ts">{fmtTime(l.ts)}</span>
                  <span className={`dir d-${l.kind}`}>{arrow[l.kind]}</span>
                  <span className="body">{l.data}</span>
                </div>
              ))}
            </div>
          </>
        }
      />
    </div>
  );
}
