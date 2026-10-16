import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Bot, ChevronRight, Copy, FileDown, Folder, FolderPlus, Globe, Pencil, Play, Plus, Radio, Server, SlidersHorizontal, Trash2, Waypoints, Zap, TerminalSquare, Download, FolderOpen, BookOpen, Sparkles, Radar, ShieldAlert, ShieldCheck, History, FolderCog } from "lucide-react";
import { fs } from "../lib/ipc";
import ExportModal from "./ExportModal";
import DocsModal from "./DocsModal";
import { reveal, revealLabel } from "../lib/reveal";
import { COLLECTIONS, ENV_TAB, basename, dirname, runnerTab, useStore } from "../lib/store";
import { useConsole } from "../lib/devconsole";
import { kindLabel, type Item, type ItemKind } from "../lib/types";
import { Menu, safeGet, safeSet, type MenuItem } from "./ui";
import HistoryList from "./HistoryList";
import { mockTab } from "../panels/MockPanel";
import { folderTab } from "../panels/FolderPanel";
import { linkRequestAsModel } from "../agent/llm";

export function ItemBadge({ item }: { item: Item }) {
  if (item.kind === "http")
    return item.bodyMode === "graphql" ? <span className="kind k-gql">GQL</span> : <span className={`method m-${item.method}`}>{item.method === "DELETE" ? "DEL" : item.method === "OPTIONS" ? "OPT" : item.method}</span>;
  const map: Record<Exclude<ItemKind, "http">, [string, string]> = { mcp: ["MCP", "k-mcp"], a2a: ["A2A", "k-a2a"], ws: ["WS", "k-ws"], web: ["WEB", "k-web"], radar: ["RADAR", "k-radar"], agent: ["AGENT", "k-agent"] };
  const [t, c] = map[item.kind];
  return <span className={`kind ${c}`}>{t}</span>;
}

const NEW: { kind: ItemKind; icon: ReactNode; name: string }[] = [
  { kind: "http", icon: <Zap size={14} />, name: "New request" },
  { kind: "mcp", icon: <Server size={14} />, name: "MCP server" },
  { kind: "a2a", icon: <Waypoints size={14} />, name: "A2A agent" },
  { kind: "ws", icon: <Radio size={14} />, name: "WebSocket" },
  { kind: "web", icon: <Globe size={14} />, name: "Web check" },
  { kind: "radar", icon: <Radar size={14} />, name: "Website radar" },
  { kind: "agent", icon: <Bot size={14} />, name: "Agent test" },
];

export default function Sidebar() {
  const consoleOpen = useConsole((c) => c.open);
  const unseen = useConsole((c) => c.unseenErrors);
  const { root, dirs, items, active, openTab } = useStore();
  const st = useStore.getState();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState<string | null>(null);
  const [docsFor, setDocsFor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | "-")[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [view, setView] = useState<"collections" | "history">(() => (safeGet("sideView") === "history" ? "history" : "collections"));
  useEffect(() => safeSet("sideView", view), [view]);
  useEffect(() => {
    const show = (e: Event) => setView((e as CustomEvent).detail === "history" ? "history" : "collections");
    window.addEventListener("forge:side-view", show);
    return () => window.removeEventListener("forge:side-view", show);
  }, []);
  const trustAsked = useStore((s) => s.trustAsked);
  const untrusted = useStore((s) => (s.trustPrints ? Object.values(s.items).filter((i) => !s.isTrusted(i)).length : 0));
  const [filter, setFilter] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const children = useMemo(() => {
    const map: Record<string, { dirs: string[]; items: Item[] }> = {};
    const node = (p: string) => (map[p] ??= { dirs: [], items: [] });
    for (const d of dirs) node(dirname(d)).dirs.push(d);
    const f = filter.toLowerCase();
    for (const it of Object.values(items)) {
      if (f && !`${it.name} ${"url" in it ? it.url : ""}`.toLowerCase().includes(f)) continue;
      node(dirname(it.path)).items.push(it);
    }
    for (const n of Object.values(map)) {
      n.dirs.sort((a, b) => a.localeCompare(b));
      n.items.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [dirs, items, filter]);

  const newMenu = (folder: string): (MenuItem | "-")[] => [
    ...NEW.map((n) => ({ label: n.name, icon: n.icon, onClick: () => st.createItem(folder, n.kind, n.kind === "http" ? "New request" : `New ${kindLabel[n.kind]}`).then(() => setOpen((o) => ({ ...o, [folder]: true }))) })),
    "-",
    { label: "New folder", icon: <FolderPlus size={14} />, onClick: () => newFolder(folder) },
  ];

  const newFolder = async (parent: string) => {
    let n = 1;
    let p = `${parent}/New Folder`;
    while (dirs.includes(p)) p = `${parent}/New Folder ${++n}`;
    await st.createFolder(p);
    setOpen((o) => ({ ...o, [parent]: true, [p]: true }));
    setRenaming(p);
  };

  const renameFolder = async (from: string, name: string) => {
    const to = `${dirname(from)}/${name.replace(/[/\\]/g, "-")}`;
    if (name && to !== from) {
      try {
        await fs.rename(from, to);
        await st.reload();
      } catch (e) {
        st.notify(String(e), "error");
      }
    }
    setRenaming(null);
  };

  const folderMenu = (path: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...newMenu(path),
        "-",
        { label: path.split("/").length === 2 ? "Collection settings" : "Folder settings", icon: <FolderCog size={14} />, onClick: () => openTab(folderTab(path)) },
        { label: "Run folder", icon: <Play size={14} />, onClick: () => openTab(runnerTab(path)) },
        { label: "Mock server", icon: <Server size={14} />, onClick: () => openTab(mockTab(path)) },
        ...(Object.values(items).some((i) => i.path.startsWith(`${path}/`) && !st.isTrusted(i))
          ? [{ label: "Trust requests in this folder", icon: <ShieldCheck size={14} />, onClick: () => (st.trust([path]), st.notify("Trusted. These requests' hosts now count as yours.")) }]
          : []),
        { label: "Generate docs…", icon: <BookOpen size={14} />, onClick: () => setDocsFor(path) },
        { label: "Export…", icon: <Download size={14} />, onClick: () => setExporting(path) },
        { label: revealLabel, icon: <FolderOpen size={14} />, onClick: () => reveal(path) },
        { label: "Rename", icon: <Pencil size={14} />, onClick: () => setRenaming(path) },
        {
          label: "Delete folder",
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: async () => (await ask(`Delete "${basename(path)}" and everything in it?`, { kind: "warning" })) && st.deleteFolder(path),
        },
      ],
    });
  };

  const itemMenu = (it: Item, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Rename", icon: <Pencil size={14} />, onClick: () => setRenaming(it.path) },
        { label: "Duplicate", icon: <Copy size={14} />, onClick: () => st.duplicateItem(it.path) },
        ...(it.kind === "http" ? [{ label: "Use as AI model", icon: <Sparkles size={14} />, onClick: () => linkRequestAsModel(it.path) }] : []),
        { label: revealLabel, icon: <FolderOpen size={14} />, onClick: () => reveal(it.path) },
        "-",
        { label: "Delete", icon: <Trash2 size={14} />, danger: true, onClick: async () => (await ask(`Delete "${it.name}"?`, { kind: "warning" })) && st.deleteItem(it.path) },
      ],
    });
  };

  const drop = (folder: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const p = e.dataTransfer.getData("forge/item");
    if (p) st.moveItem(p, folder).catch((er) => st.notify(String(er), "error"));
  };
  const dragOver = (folder: string) => (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("forge/item")) {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(folder);
    }
  };

  const renderDir = (path: string, depth: number): ReactNode => {
    const n = children[path] ?? { dirs: [], items: [] };
    const isOpen = open[path] ?? (depth === 0 || !!filter);
    return (
      <div key={path} onDragOver={dragOver(path)} onDrop={drop(path)}>
        <div
          className={`node ${dropTarget === path ? "drop" : ""}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => setOpen((o) => ({ ...o, [path]: !isOpen }))}
          onContextMenu={(e) => folderMenu(path, e)}
          onDoubleClick={() => setRenaming(path)}
        >
          <ChevronRight size={14} className={`chev ${isOpen ? "open" : ""}`} />
          <Folder size={14} style={{ flexShrink: 0 }} />
          {renaming === path ? (
            <input className="input" autoFocus defaultValue={basename(path)} onClick={(e) => e.stopPropagation()} onBlur={(e) => renameFolder(path, e.target.value.trim())} onKeyDown={(e) => (e.key === "Enter" ? e.currentTarget.blur() : e.key === "Escape" && setRenaming(null))} />
          ) : (
            <span className="label" style={{ fontWeight: depth === 0 ? 600 : 400, color: depth === 0 ? "var(--fg)" : undefined }}>
              {basename(path)}
            </span>
          )}
          <span className="actions">
            <button className="btn ghost icon sm" title="Run folder" onClick={(e) => (e.stopPropagation(), openTab(runnerTab(path)))}>
              <Play size={12} />
            </button>
            <button className="btn ghost icon sm" title="Add" onClick={(e) => (e.stopPropagation(), setMenu({ x: e.clientX, y: e.clientY, items: newMenu(path) }))}>
              <Plus size={13} />
            </button>
          </span>
        </div>
        {isOpen && (
          <>
            {n.dirs.map((d) => renderDir(d, depth + 1))}
            {n.items.map((it) => (
              <div
                key={it.path}
                className={`node ${active === it.path ? "active" : ""}`}
                style={{ paddingLeft: 26 + depth * 12 }}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("forge/item", it.path)}
                onClick={() => openTab(it.path)}
                onContextMenu={(e) => itemMenu(it, e)}
                onDoubleClick={() => setRenaming(it.path)}
              >
                <ItemBadge item={it} />
                {renaming === it.path ? (
                  <input
                    className="input"
                    autoFocus
                    defaultValue={it.name}
                    onBlur={(e) => {
                      if (e.target.value.trim()) st.renameItem(it.path, e.target.value.trim());
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => (e.key === "Enter" ? e.currentTarget.blur() : e.key === "Escape" && setRenaming(null))}
                  />
                ) : (
                  <span className="label">{it.name}</span>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  const collections = children[COLLECTIONS]?.dirs ?? [];
  return (
    <>
      <div className="side-head">
        <span className="ws" title={root ?? ""}>
          {root ? basename(root) : "Forge"}
        </span>
        <button className={`btn ghost icon sm ${view === "history" ? "on" : ""}`} title={view === "history" ? "Show collections" : "Show history"} onClick={() => setView(view === "history" ? "collections" : "history")}>
          <History size={14} />
        </button>
        <button className="btn ghost icon sm" title="Import collection (Postman, Insomnia, Bruno, OpenAPI, HAR, cURL)" onClick={() => st.setImporting(true)}>
          <FileDown size={14} />
        </button>
        <button className="btn ghost icon sm" title="New collection" onClick={() => newFolder(COLLECTIONS)}>
          <FolderPlus size={14} />
        </button>
      </div>
      <input className="input side-search" placeholder={view === "history" ? "Search history" : "Search"} value={filter} onChange={(e) => setFilter(e.target.value)} />
      {view === "history" && <HistoryList filter={filter} />}
      {view === "collections" && trustAsked && untrusted > 0 && (
        <div className="row muted" style={{ padding: "4px 12px", fontSize: 11.5 }} title="Imported, or new or changed outside Forge since you last trusted them. Forge asks before scripts or AI send anything to hosts only these use.">
          <ShieldAlert size={12} className="warn" />
          <span className="grow">
            {untrusted} request{untrusted === 1 ? "" : "s"} not trusted yet
          </span>
          <a href="#" onClick={(e) => (e.preventDefault(), st.decideWorkspaceTrust(true))}>
            Trust all
          </a>
        </div>
      )}
      <div className="tree" style={view === "history" ? { display: "none" } : undefined} onDragOver={dragOver(COLLECTIONS)} onDrop={drop(COLLECTIONS)}>
        {collections.map((c) => renderDir(c, 0))}
        {children[COLLECTIONS]?.items.map((it) => (
          <div key={it.path} className={`node ${active === it.path ? "active" : ""}`} onClick={() => openTab(it.path)} onContextMenu={(e) => itemMenu(it, e)}>
            <ItemBadge item={it} />
            <span className="label">{it.name}</span>
          </div>
        ))}
        {!collections.length && (
          <div className="empty" style={{ padding: 24 }}>
            <button className="btn" onClick={() => newFolder(COLLECTIONS)}>
              <FolderPlus size={14} /> New collection
            </button>
          </div>
        )}
      </div>
      <div className="side-foot">
        <button className="btn ghost sm grow" onClick={() => openTab(ENV_TAB)}>
          <SlidersHorizontal size={13} /> Environments
        </button>
        <button className={`btn ghost sm grow ${consoleOpen ? "on" : ""}`} title="Console (⌘J)" onClick={() => useConsole.getState().toggle()}>
          <TerminalSquare size={13} /> Console
          {unseen > 0 && <span className="badge-dot">{unseen}</span>}
        </button>
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {exporting && <ExportModal root={exporting} onClose={() => setExporting(null)} />}
      {docsFor && <DocsModal root={docsFor} onClose={() => setDocsFor(null)} />}
    </>
  );
}
