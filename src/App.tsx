import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Bot, FolderCog, FolderOpen, Globe, History, Server, SlidersHorizontal, Settings as Gear, Waypoints, X, Zap, MessageSquare } from "lucide-react";
import Sidebar, { ItemBadge } from "./components/Sidebar";
import { hasFiles, readDropped, setPendingDrop } from "./lib/dropFiles";
import ImportModal from "./components/ImportModal";
import ConsolePanel from "./components/ConsolePanel";
import ForgeMark from "./components/ForgeMark";
import ChatPanel, { toggleChat, useChatOpen } from "./components/ChatPanel";
import ApprovalModal from "./components/ApprovalModal";
import TrustPrompt from "./components/TrustPrompt";
import QuickOpen, { openQuickOpen } from "./components/QuickOpen";
import CookiesModal from "./components/CookiesModal";
import { startCookieJars } from "./lib/cookies";
import { useHistory } from "./lib/history";
import Onboarding from "./components/Onboarding";
import { startUpdateChecks, useUpdates } from "./lib/updates";
import { openSettings } from "./lib/settingsNav";
import { useConsole } from "./lib/devconsole";
import { Menu, safeGet, safeSet, type MenuItem } from "./components/ui";
import { COLLECTIONS, ENV_TAB, SETTINGS_TAB, basename, useStore } from "./lib/store";
import HttpPanel from "./panels/HttpPanel";
import McpPanel from "./panels/McpPanel";
import A2APanel from "./panels/A2APanel";
import WsPanel from "./panels/WsPanel";
import WebPanel from "./panels/WebPanel";
import RadarPanel from "./panels/RadarPanel";
import AgentPanel from "./panels/AgentPanel";
import RunnerPanel from "./panels/RunnerPanel";
import HistoryPanel from "./panels/HistoryPanel";
import MockPanel from "./panels/MockPanel";
import FolderPanel from "./panels/FolderPanel";
import { useMocks } from "./lib/mock";
import { EnvPanel, SettingsPanel } from "./panels/SettingsPanels";

/** Window title bar: traffic lights on the left, brand centred, Settings in the right corner. */
function TitleBar({ settings = true }: { settings?: boolean }) {
  return (
    <header className="appbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <ForgeMark size={18} />
        <b>Forge</b>
        <span className="muted">by Stellitron</span>
      </div>
      {settings && (
        <div className="appbar-right row" style={{ gap: 6 }}>
          <UpdatePill />
          <button className="btn ghost icon sm" title="Settings (⌘,)" onClick={() => useStore.getState().openTab(SETTINGS_TAB)}>
            <Gear size={15} />
          </button>
        </div>
      )}
    </header>
  );
}

/** Appears only when a new version is downloaded or available. */
function UpdatePill() {
  const { status, version } = useUpdates();
  if (status !== "available" && status !== "ready") return null;
  return (
    <button className="update-pill" onClick={() => openSettings("updates")} title="Open Settings › Updates">
      {status === "ready" ? "Restart to update" : `Update ${version}`}
    </button>
  );
}

function Welcome() {
  const startupError = useStore((s) => s.startupError);
  const pick = async () => {
    const dir = await open({ directory: true, title: "Choose a folder for your Forge workspace" });
    if (typeof dir === "string") await useStore.getState().openWorkspace(dir);
  };
  const features = [
    [<Zap size={16} />, "REST & GraphQL", "Requests, environments, assertions, runner"],
    [<Server size={16} />, "MCP", "Inspect & call tools over stdio, HTTP, SSE"],
    [<Waypoints size={16} />, "A2A", "Agent cards, chat, streaming tasks"],
    [<Bot size={16} />, "Agentic testing", "Let an LLM explore and test your APIs"],
    [<Globe size={16} />, "Web checks", "Headers, perf, SEO and broken links"],
  ] as const;
  return (
    <div className="welcome">
      <div style={{ position: "fixed", top: 0, left: 0, right: 0 }}>
        <TitleBar settings={false} />
      </div>
      <ForgeMark size={64} />
      <h1>Forge</h1>
      {startupError && (
        <div className="err" style={{ maxWidth: 560 }}>
          {startupError}
        </div>
      )}
      <div className="dim" style={{ maxWidth: 460 }}>
        One local-first client for every API you test. No sign-in and no cloud. Your collections are plain files in a folder you choose.
      </div>
      <div className="row">
        <button className="btn primary" style={{ height: 38, padding: "0 18px" }} onClick={() => pick()}>
          <FolderOpen size={16} /> Open or create workspace folder
        </button>
      </div>
      <div className="row" style={{ flexWrap: "wrap", justifyContent: "center", maxWidth: 1100, marginTop: 10 }}>
        {features.map(([icon, t, d]) => (
          <div className="feature" key={t}>
            <div className="row" style={{ marginBottom: 4 }}>
              {icon}
              <b>{t}</b>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryTabLabel({ id }: { id: string }) {
  const e = useHistory((s) => s.entries.find((x) => x.id === id));
  return (
    <>
      <History size={13} /> <span className="label">{e ? `${e.name} · ${new Date(e.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "History"}</span>
    </>
  );
}

function MockTabLabel({ folder }: { folder: string }) {
  const on = useMocks((s) => !!s.running[folder]);
  return (
    <>
      <Server size={13} className={on ? "ok" : undefined} /> <span className="label">Mock · {basename(folder) === COLLECTIONS ? "All" : basename(folder)}</span>
    </>
  );
}

function TabLabel({ id }: { id: string }) {
  const saving = useStore((s) => s.saving[id]);
  const item = useStore((s) => s.items[id]);
  if (id === SETTINGS_TAB)
    return (
      <>
        <Gear size={13} /> <span className="label">Settings</span>
      </>
    );
  if (id === ENV_TAB)
    return (
      <>
        <SlidersHorizontal size={13} /> <span className="label">Environments</span>
      </>
    );
  if (id.startsWith("::runner:"))
    return <span className="label">Run · {basename(id.slice(9)) === COLLECTIONS ? "All" : basename(id.slice(9))}</span>;
  if (id.startsWith("::history:")) return <HistoryTabLabel id={id.slice(10)} />;
  if (id.startsWith("::mock:")) return <MockTabLabel folder={id.slice(7)} />;
  if (id.startsWith("::folder:"))
    return (
      <>
        <FolderCog size={13} /> <span className="label">{basename(id.slice(9))} settings</span>
      </>
    );
  if (!item) return <span className="label muted">(deleted)</span>;
  return (
    <>
      <ItemBadge item={item} />
      <span className="label">{item.name}</span>
      <span className={`savedot ${saving ? "on" : ""}`} title={saving ? "Saving…" : "Saved automatically"} />
    </>
  );
}

function Body({ id }: { id: string | null }) {
  const item = useStore((s) => (id ? s.items[id] : undefined));
  if (!id)
    return (
      <div className="empty">
        <div className="big">Nothing open</div>
        <div>
          Pick something from the sidebar, or right-click a collection to add a request, MCP server, A2A agent, WebSocket, web check, website radar or agent test.
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <kbd>⌘</kbd>
          <kbd>↵</kbd> send · <kbd>⌘</kbd>
          <kbd>W</kbd> close tab
        </div>
      </div>
    );
  if (id === SETTINGS_TAB) return <SettingsPanel />;
  if (id === ENV_TAB) return <EnvPanel />;
  if (id.startsWith("::runner:")) return <RunnerPanel folder={id.slice(9)} />;
  if (id.startsWith("::history:")) return <HistoryPanel key={id} id={id.slice(10)} />;
  if (id.startsWith("::mock:")) return <MockPanel key={id} folder={id.slice(7)} />;
  if (id.startsWith("::folder:")) return <FolderPanel key={id} path={id.slice(9)} />;
  if (!item) return <div className="empty">This item no longer exists.</div>;
  switch (item.kind) {
    case "http":
      return <HttpPanel key={id} item={item} />;
    case "mcp":
      return <McpPanel key={id} item={item} />;
    case "a2a":
      return <A2APanel key={id} item={item} />;
    case "ws":
      return <WsPanel key={id} item={item} />;
    case "web":
      return <WebPanel key={id} item={item} />;
    case "radar":
      return <RadarPanel key={id} item={item} />;
    case "agent":
      return <AgentPanel key={id} item={item} />;
  }
}

export default function App() {
  const root = useStore((s) => s.root);
  const onboarded = useStore((s) => !!s.settings.onboarded);
  const st = useStore.getState();
  const [ready, setReady] = useState(false);

  useEffect(() => useStore.subscribe((s, prev) => void (s.root && s.root !== prev.root && useHistory.getState().load(s.root))), []);

  useEffect(() => {
    st.init().finally(() => (setReady(true), startCookieJars()));
    startUpdateChecks();
    const keys = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useStore.getState();
      if (mod && e.key === "w" && s.active) {
        e.preventDefault();
        s.closeTab(s.active);
      }
      if (mod && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "p") && !e.shiftKey && s.root) {
        e.preventDefault();
        openQuickOpen();
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        s.openTab(SETTINGS_TAB);
      }
      if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggleChat();
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        useConsole.getState().toggle();
      }
      if (mod && e.key.toLowerCase() === "i" && s.root) {
        e.preventDefault();
        s.setImporting(true);
      }
    };
    // Files dropped outside the import window: stop the page from navigating to the file, and
    // open the import window with them. The import window handles drops itself while it's open.
    const fileOver = (e: DragEvent) => hasFiles(e.dataTransfer) && e.preventDefault();
    const fileDrop = async (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const s = useStore.getState();
      if (s.importing || !s.root) return;
      try {
        const files = await readDropped(e.dataTransfer!);
        if (!files.length) return s.notify("Nothing to import there. Forge reads JSON, YAML, Bruno, HAR and cURL files.", "error");
        setPendingDrop(files);
        s.setImporting(true);
      } catch (err) {
        s.notify(String(err instanceof Error ? err.message : err), "error");
      }
    };
    window.addEventListener("keydown", keys);
    window.addEventListener("dragover", fileOver);
    window.addEventListener("drop", fileDrop);
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("dragover", fileOver);
      window.removeEventListener("drop", fileDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return null;
  if (!onboarded) return <>{root ? <Workspace /> : <Welcome />}<Onboarding /></>;
  if (!root) return <Welcome />;
  return <Workspace />;
}

function Workspace() {
  const { tabs, active, envs, activeEnv, toast, importing } = useStore();
  const consoleOpen = useConsole((c) => c.open);
  const chatOpen = useChatOpen();
  const st = useStore.getState();
  const [side, setSide] = useState(() => Number(safeGet("side")) || 272);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | "-")[] } | null>(null);
  const tabMenu = (t: string, e: React.MouseEvent) => {
    e.preventDefault();
    const i = tabs.indexOf(t);
    const others = tabs.filter((x) => x !== t);
    const right = tabs.slice(i + 1);
    const items: (MenuItem | "-")[] = [{ label: "Close", onClick: () => st.closeTab(t) }];
    if (others.length) items.push({ label: "Close others", onClick: () => (st.closeTabs(others), st.openTab(t)) });
    if (right.length) items.push({ label: "Close to the right", onClick: () => st.closeTabs(right) });
    items.push("-", { label: "Close all", onClick: () => st.closeTabs(tabs) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => dragging.current && setSide(Math.min(480, Math.max(200, e.clientX)));
    const up = () => (dragging.current = false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);
  useEffect(() => {
    safeSet("side", String(side));
  }, [side]);
  return (
    <div className="shell">
    <TitleBar />
    <div className="app" style={{ ["--side" as string]: `${side}px` }}>
      <aside className="side">
        <Sidebar />
        <div className="side-resize" onMouseDown={() => (dragging.current = true)} />
      </aside>
      <main className="main">
        {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
        <div className="tabbar" data-tauri-drag-region>
          {tabs.map((t) => (
            <div key={t} className={`tab ${t === active ? "active" : ""}`} onClick={() => st.openTab(t)} onAuxClick={(e) => e.button === 1 && st.closeTab(t)} onContextMenu={(e) => tabMenu(t, e)}>
              <TabLabel id={t} />
              <span className="x" onClick={(e) => (e.stopPropagation(), st.closeTab(t))}>
                <X size={12} />
              </span>
            </div>
          ))}
          <div className="spacer" data-tauri-drag-region />
          <div className="row" style={{ padding: "0 10px" }}>
            <select
              className="select"
              style={{ height: 26, fontSize: 12, maxWidth: 200 }}
              value={activeEnv ?? ""}
              title="Active environment"
              onChange={async (e) => {
                if (e.target.value === "::new") {
                  st.setActiveEnv((await st.newEnv()) as string);
                  st.openTab(ENV_TAB);
                } else if (e.target.value === "::manage") st.openTab(ENV_TAB);
                else st.setActiveEnv(e.target.value || null);
              }}
            >
              <option value="">No environment</option>
              {envs.map((e) => (
                <option key={e.path} value={e.path}>
                  {e.name}
                </option>
              ))}
              <option disabled>──────────</option>
              <option value="::new">+ New environment</option>
              <option value="::manage">Manage environments…</option>
            </select>
            <button className={`btn ghost sm ${chatOpen ? "on" : ""}`} title="Ask about your APIs (⌘L)" onClick={() => toggleChat()}>
              <MessageSquare size={14} /> Ask
            </button>
          </div>
        </div>
        <div className="workarea">
          <div className="content">
            <Body id={active} />
          </div>
          {chatOpen && <ChatPanel />}
        </div>
        {consoleOpen && <ConsolePanel />}
      </main>
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      {importing && <ImportModal onClose={() => st.setImporting(false)} />}
      <ApprovalModal />
      <TrustPrompt />
      <QuickOpen />
      <CookiesModal />
    </div>
    </div>
  );
}
