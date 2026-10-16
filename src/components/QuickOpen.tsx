import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Cookie, FileDown, FolderCog, History, MessageSquare, Plus, Search, Server, Settings, SlidersHorizontal, SquareTerminal, Play } from "lucide-react";
import { fuzzyFilter } from "../lib/fuzzy";
import { useHistory } from "../lib/history";
import { COLLECTIONS, ENV_TAB, SETTINGS_TAB, basename, dirname, runnerTab, useStore } from "../lib/store";
import { toggleChat } from "../lib/chatUi";
import { useConsole } from "../lib/devconsole";
import { historyTab } from "./HistoryList";
import { ItemBadge } from "./Sidebar";
import { folderTab } from "../panels/FolderPanel";
import { mockTab } from "../panels/MockPanel";
import { openCookies } from "./CookiesModal";

export const useQuickOpen = create<{ open: boolean }>(() => ({ open: false }));
export const openQuickOpen = () => useQuickOpen.setState({ open: true });

interface Entry {
  id: string;
  label: string;
  /** Matched too, shown dim: folder path, URL, shortcut. */
  detail?: string;
  icon: ReactNode;
  group: string;
  boost: number;
  run(): void;
}

const rel = (p: string) => p.slice(COLLECTIONS.length + 1);

function Highlight({ text, hits }: { text: string; hits: Set<number> }) {
  return (
    <>
      {[...text].map((ch, i) =>
        hits.has(i) ? (
          <b key={i} style={{ color: "var(--accent)" }}>
            {ch}
          </b>
        ) : (
          ch
        ),
      )}
    </>
  );
}

/** ⌘K: jump to any request, folder, environment, recent send or action by typing a few letters. */
export default function QuickOpen() {
  const open = useQuickOpen((s) => s.open);
  if (!open) return null;
  return <Palette onClose={() => useQuickOpen.setState({ open: false })} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { items, dirs, envs, activeEnv, active, tabs, root } = useStore();
  const history = useHistory((s) => s.entries);

  const entries = useMemo<Entry[]>(() => {
    const st = useStore.getState();
    const go = (id: string) => () => st.openTab(id);
    const activeItem = active ? items[active] : undefined;
    const here = activeItem ? dirname(activeItem.path) : dirs.find((d) => d.split("/").length === 2);
    const out: Entry[] = [];
    for (const it of Object.values(items))
      out.push({ id: it.path, label: it.name, detail: `${dirname(rel(it.path))}${"url" in it && typeof it.url === "string" && it.url ? `  ${it.url}` : ""}`, icon: <ItemBadge item={it} />, group: "Requests", boost: tabs.includes(it.path) ? 3 : 1, run: go(it.path) });
    for (const d of dirs.filter((x) => x !== COLLECTIONS))
      out.push({ id: `folder:${d}`, label: `${basename(d)} settings`, detail: rel(d), icon: <FolderCog size={14} />, group: "Folders", boost: 0, run: go(folderTab(d)) });
    for (const e of envs)
      out.push({ id: `env:${e.path}`, label: `Use environment: ${e.name}`, detail: e.path === activeEnv ? "active" : undefined, icon: <SlidersHorizontal size={14} />, group: "Environments", boost: 0, run: () => st.setActiveEnv(e.path) });
    if (activeEnv) out.push({ id: "env:none", label: "Use no environment", icon: <SlidersHorizontal size={14} />, group: "Environments", boost: -1, run: () => st.setActiveEnv(null) });
    for (const h of history.slice(0, 40))
      out.push({ id: `h:${h.id}`, label: `${h.req.method} ${h.name}`, detail: `${h.res?.status ?? "error"} · ${new Date(h.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, icon: <History size={14} />, group: "History", boost: -2, run: go(historyTab(h.id)) });
    const action = (id: string, label: string, icon: ReactNode, run: () => void, detail?: string) => out.push({ id: `a:${id}`, label, detail, icon, group: "Actions", boost: 2, run });
    if (here) action("new", `New request in ${basename(here)}`, <Plus size={14} />, () => void st.createItem(here, "http", "New request"));
    if (here) action("run", `Run ${basename(here)}`, <Play size={14} />, go(runnerTab(here)));
    if (here) action("mock", `Mock server for ${basename(here)}`, <Server size={14} />, go(mockTab(here)));
    action("history", "Show history", <History size={14} />, () => window.dispatchEvent(new CustomEvent("forge:side-view", { detail: "history" })));
    action("import", "Import collection", <FileDown size={14} />, () => st.setImporting(true), "⌘I");
    action("envs", "Edit environments", <SlidersHorizontal size={14} />, go(ENV_TAB));
    action("ask", "Ask AI", <MessageSquare size={14} />, () => toggleChat(true), "⌘L");
    action("cookies", "Cookies", <Cookie size={14} />, openCookies);
    action("console", "Toggle console", <SquareTerminal size={14} />, () => useConsole.getState().toggle(), "⌘J");
    action("settings", "Settings", <Settings size={14} />, go(SETTINGS_TAB), "⌘,");
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, dirs, envs, activeEnv, history, root]);

  const results = useMemo(() => {
    if (q.trim()) return fuzzyFilter(q, entries, (e) => `${e.label} ${e.detail ?? ""}`, (e) => e.boost, 60);
    // Nothing typed: open tabs, then actions, then recent sends.
    const open = tabs.map((t) => entries.find((e) => e.id === t)).filter((e): e is Entry => !!e);
    return [...open, ...entries.filter((e) => e.group === "Actions"), ...entries.filter((e) => e.group === "History").slice(0, 5)].map((item) => ({ item, hits: [] as number[] }));
  }, [q, entries, tabs]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }), [sel]);

  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    onClose();
    r.item.run();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(results.length - 1, s + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
    else if (e.key === "Enter") (e.preventDefault(), choose(sel));
    else if (e.key === "Escape") (e.preventDefault(), onClose());
  };

  return (
    <div className="modal-bg" style={{ alignItems: "flex-start", paddingTop: "12vh" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(640px, 92vw)" }}>
        <div className="row" style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
          <Search size={15} className="dim" />
          <input autoFocus className="grow" style={{ border: "none", outline: "none", background: "transparent", fontSize: 15, color: "var(--fg)" }} placeholder="Go to a request, folder, environment or action…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
          <kbd>esc</kbd>
        </div>
        <div ref={listRef} style={{ overflow: "auto", maxHeight: "56vh", padding: 6 }}>
          {!results.length && <div className="muted" style={{ padding: 14 }}>Nothing matches “{q}”.</div>}
          {results.map((r, i) => {
            const labelLen = r.item.label.length;
            const hits = new Set(r.hits.filter((h) => h < labelLen));
            const detailHits = new Set(r.hits.filter((h) => h > labelLen).map((h) => h - labelLen - 1));
            const header = !q.trim() ? null : i === 0 || results[i - 1].item.group !== r.item.group ? r.item.group : null;
            return (
              <div key={r.item.id}>
                {header && <div className="muted" style={{ padding: "8px 10px 2px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{header}</div>}
                <div
                  data-i={i}
                  className="row"
                  style={{ padding: "7px 10px", borderRadius: 7, cursor: "pointer", background: i === sel ? "var(--accent-bg)" : undefined }}
                  onMouseMove={() => i !== sel && setSel(i)}
                  onClick={() => choose(i)}
                >
                  <span style={{ width: 44, display: "flex", justifyContent: "center", flexShrink: 0 }}>{r.item.icon}</span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <Highlight text={r.item.label} hits={hits} />
                  </span>
                  {r.item.detail && (
                    <span className="muted mono" style={{ fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
                      <Highlight text={r.item.detail} hits={detailHits} />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
