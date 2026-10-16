import { useMemo, useState } from "react";
import { Copy, FilePlus2, RotateCw, Trash2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useHistory, type HistoryEntry } from "../lib/history";
import { saveHistoryAsRequest, sendAgain } from "../panels/HistoryPanel";
import { useStore } from "../lib/store";
import { writeText } from "../lib/clipboard";
import { Menu, statusClass, type MenuItem } from "./ui";

export const historyTab = (id: string) => `::history:${id}`;

const day = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** The sidebar's History view: every send, newest first, grouped by day. */
export default function HistoryList({ filter }: { filter: string }) {
  const entries = useHistory((s) => s.entries);
  const active = useStore((s) => s.active);
  const enabled = useStore((s) => s.settings.history?.enabled !== false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | "-")[] } | null>(null);
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => (q ? entries.filter((e) => `${e.req.method} ${e.name} ${e.req.url} ${e.res?.status ?? ""} ${e.env ?? ""}`.toLowerCase().includes(q)) : entries), [entries, q]);
  const groups = useMemo(() => {
    const out: [string, HistoryEntry[]][] = [];
    for (const e of shown) {
      const d = day(e.ts);
      if (out[out.length - 1]?.[0] !== d) out.push([d, []]);
      out[out.length - 1][1].push(e);
    }
    return out;
  }, [shown]);
  const open = (e: HistoryEntry) => useStore.getState().openTab(historyTab(e.id));
  const rowMenu = (e: HistoryEntry, ev: React.MouseEvent) => {
    ev.preventDefault();
    setMenu({
      x: ev.clientX,
      y: ev.clientY,
      items: [
        { label: "Send again", icon: <RotateCw size={14} />, onClick: () => sendAgain(e) },
        { label: "Save as request", icon: <FilePlus2 size={14} />, onClick: () => saveHistoryAsRequest(e) },
        { label: "Copy URL", icon: <Copy size={14} />, onClick: () => writeText(e.req.url) },
        "-",
        { label: "Delete", icon: <Trash2 size={14} />, danger: true, onClick: () => useHistory.getState().remove(e.id) },
      ],
    });
  };

  if (!entries.length)
    return (
      <div className="empty" style={{ padding: 24 }}>
        {enabled ? "Requests you send show up here, newest first." : "History is turned off in Settings."}
      </div>
    );
  return (
    <div className="tree">
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {groups.map(([d, list]) => (
        <div key={d}>
          <div className="muted" style={{ padding: "8px 12px 4px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>
            {d}
          </div>
          {list.map((e) => (
            <div key={e.id} className={`node ${active === historyTab(e.id) ? "active" : ""}`} onClick={() => open(e)} onContextMenu={(ev) => rowMenu(e, ev)} title={e.req.url}>
              <span className={`method m-${e.req.method}`}>{e.req.method === "DELETE" ? "DEL" : e.req.method === "OPTIONS" ? "OPT" : e.req.method}</span>
              <span className="label">{e.name}</span>
              {e.res ? <span className={statusClass(e.res.status)} style={{ fontSize: 10 }}>{e.res.status}</span> : <span className="err" style={{ fontSize: 10 }}>error</span>}
              <span className="muted" style={{ fontSize: 10.5, flexShrink: 0 }}>{time(e.ts)}</span>
            </div>
          ))}
        </div>
      ))}
      <div className="row" style={{ padding: "10px 12px" }}>
        <a href="#" className="muted" onClick={async (ev) => (ev.preventDefault(), (await ask("Clear the request history for this workspace?", { kind: "warning" })) && useHistory.getState().clear())}>
          Clear history
        </a>
      </div>
    </div>
  );
}
