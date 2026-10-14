import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ArrowRight, Bot, FileJson, FolderOpen, GitBranch, Lock, Server, Sparkles, Waypoints } from "lucide-react";
import ForgeMark from "./ForgeMark";
import { useStore } from "../lib/store";
import { openSettings } from "../lib/settingsNav";
import { DEFAULT_APPEARANCE, type ThemeMode } from "../lib/theme";

/**
 * First-run guide. Each step pairs one idea with a small animated scene drawn in CSS, so it
 * follows the theme and never goes stale the way screenshots do. Skippable at every step and
 * reachable again from Settings › General.
 */

interface Step {
  title: string;
  body: ReactNode;
  scene: ReactNode;
}

export default function Onboarding() {
  const root = useStore((s) => s.root);
  const appearance = { ...DEFAULT_APPEARANCE, ...useStore((s) => s.settings.appearance) };
  const [i, setI] = useState(0);
  const [wantsAi, setWantsAi] = useState(false);

  const finish = async (pickFolder: boolean) => {
    const st = useStore.getState();
    if (pickFolder) {
      const dir = await open({ directory: true, title: "Choose a folder for your Forge workspace" });
      if (typeof dir !== "string") return;
      await st.saveSettings({ onboarded: true });
      await st.openWorkspace(dir);
    } else await st.saveSettings({ onboarded: true });
    if (wantsAi && useStore.getState().root) openSettings("ai");
  };

  const steps: Step[] = [
    {
      title: "One client for every API you test",
      body: (
        <>
          <p>Forge sends REST and GraphQL requests, talks to WebSockets, inspects MCP servers and A2A agents, and checks websites. All in one window, all on your computer.</p>
          <p className="ob-muted">Free and open source. No account, no cloud, no telemetry.</p>
        </>
      ),
      scene: <SceneHello />,
    },
    {
      title: "Your work is a folder of files",
      body: (
        <>
          <p>Pick any folder as your workspace. Every request and environment is a small JSON file there, so you can review changes and share them through git like code.</p>
          <p className="ob-muted">Tokens and passwords go in <code>*.local.json</code> files, which Forge keeps out of git automatically.</p>
        </>
      ),
      scene: <SceneFiles />,
    },
    {
      title: "Send a request in seconds",
      body: (
        <>
          <p>
            Type a URL or paste a cURL command and press <kbd>⌘</kbd> <kbd>↵</kbd>. Use <code>{"{{variables}}"}</code> from an environment so one request works on local, staging and production.
          </p>
          <p className="ob-muted">Responses open as pretty JSON, a sortable table, or an export to Excel, PDF and more.</p>
        </>
      ),
      scene: <SceneRequest />,
    },
    {
      title: "Test MCP servers and AI agents",
      body: (
        <>
          <p>Connect to an MCP server to list and call its tools, or chat with an A2A agent. Add assertions and run whole folders as a test suite.</p>
          <p className="ob-muted">Forge can also be an MCP server itself, so Claude, Copilot or Cursor can run your saved requests.</p>
        </>
      ),
      scene: <SceneMcp />,
    },
    {
      title: "Bring your own AI, if you like",
      body: (
        <>
          <p>Connect Claude, OpenAI, Gemini, Azure, Bedrock, OpenRouter or a local Ollama model to ask questions about responses, write tests, and run agentic test sessions.</p>
          <p className="ob-muted">Optional. Your key stays on this computer and secrets are never sent.</p>
          <label className="ob-check">
            <input type="checkbox" checked={wantsAi} onChange={(e) => setWantsAi(e.target.checked)} />
            Take me to AI setup when I'm done
          </label>
        </>
      ),
      scene: <SceneAsk />,
    },
    {
      title: "Make it yours",
      body: (
        <>
          <p>Pick a look. You can change it any time in Settings.</p>
          <div className="ob-themes">
            {(["system", "light", "dark"] as ThemeMode[]).map((m) => (
              <button
                key={m}
                className={`swatch ${appearance.mode === m ? "on" : ""}`}
                onClick={() => useStore.getState().saveSettings({ appearance: { ...appearance, mode: m } })}
              >
                {m === "system" ? "System" : m === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </>
      ),
      scene: <SceneHello small />,
    },
  ];

  const last = i === steps.length - 1;
  const next = () => (last ? finish(!root) : setI(i + 1));

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
      if (e.key === "Escape") finish(false);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const s = steps[i];
  return (
    <div className="ob" role="dialog" aria-modal aria-label="Welcome to Forge">
      <div className="ob-card">
        <div className="ob-text" key={`t${i}`}>
          <div className="ob-brand">
            <ForgeMark size={20} /> Forge
          </div>
          <div className="ob-step">
            Step {i + 1} of {steps.length}
          </div>
          <h1>{s.title}</h1>
          {s.body}
          <div className="ob-nav">
            {i > 0 ? (
              <button className="btn ghost" onClick={() => setI(i - 1)}>
                <ArrowLeft size={14} /> Back
              </button>
            ) : (
              <button className="btn ghost" onClick={() => finish(false)}>
                Skip tour
              </button>
            )}
            <div className="ob-dots">
              {steps.map((_, j) => (
                <button key={j} className={j === i ? "on" : ""} onClick={() => setI(j)} aria-label={`Step ${j + 1}`} />
              ))}
            </div>
            <button className="btn primary" onClick={next} autoFocus>
              {last ? (
                root ? (
                  "Start using Forge"
                ) : (
                  <>
                    <FolderOpen size={14} /> Choose workspace folder
                  </>
                )
              ) : (
                <>
                  Next <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>
        <div className="ob-scene" key={`s${i}`} aria-hidden>
          {s.scene}
        </div>
      </div>
    </div>
  );
}

function SceneHello({ small }: { small?: boolean }) {
  const chips = ["REST", "GraphQL", "WebSocket", "MCP", "A2A", "Web checks"];
  return (
    <div className="sc-hello">
      <div className="sc-logo">
        <ForgeMark size={small ? 64 : 84} />
      </div>
      {chips.map((c, j) => (
        <span key={c} className="sc-orbit" style={{ ["--a" as string]: `${(360 / chips.length) * j}deg`, ["--d" as string]: `${j * 0.12}s` }}>
          {c}
        </span>
      ))}
    </div>
  );
}

function SceneFiles() {
  const files: [ReactNode, string, string?][] = [
    [<FolderOpen size={13} />, "my-api/"],
    [<FolderOpen size={13} />, "  collections/Users/"],
    [<FileJson size={13} />, "    list-users.json", "add"],
    [<FileJson size={13} />, "    create-user.json", "add"],
    [<FolderOpen size={13} />, "  environments/"],
    [<FileJson size={13} />, "    staging.json", "add"],
    [<Lock size={13} />, "    staging.local.json", "ignored"],
  ];
  return (
    <div className="sc-window">
      <div className="sc-bar">
        <i />
        <i />
        <i />
      </div>
      <div className="sc-files">
        {files.map(([icon, name, tag], j) => (
          <div key={name} className="sc-file" style={{ ["--d" as string]: `${0.15 + j * 0.18}s` }}>
            {icon}
            <span className="mono" style={{ whiteSpace: "pre" }}>
              {name}
            </span>
            {tag === "add" && <span className="sc-tag ok">+ git</span>}
            {tag === "ignored" && <span className="sc-tag">not in git</span>}
          </div>
        ))}
        <div className="sc-commit" style={{ ["--d" as string]: "1.6s" }}>
          <GitBranch size={13} /> <span className="mono">git commit -m "Add Users API"</span>
        </div>
      </div>
    </div>
  );
}

function SceneRequest() {
  return (
    <div className="sc-window">
      <div className="sc-bar">
        <i />
        <i />
        <i />
      </div>
      <div className="sc-url">
        <span className="sc-method">GET</span>
        <span className="sc-typing mono">
          <span className="vi-ok">{"{{baseUrl}}"}</span>/users?limit=3
        </span>
        <span className="sc-send">Send</span>
      </div>
      <div className="sc-res">
        <div className="sc-status">
          <span className="sc-ok">200 OK</span> <span className="muted">· 84 ms · 1.2 KB</span>
        </div>
        <table className="sc-table">
          <thead>
            <tr>
              <th>id</th>
              <th>name</th>
              <th>email</th>
            </tr>
          </thead>
          <tbody>
            {[
              [1, "Ada Lovelace", "ada@example.com"],
              [2, "Alan Turing", "alan@example.com"],
              [3, "Grace Hopper", "grace@example.com"],
            ].map((r, j) => (
              <tr key={j} style={{ ["--d" as string]: `${2.1 + j * 0.15}s` }}>
                {r.map((c, k) => (
                  <td key={k}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SceneMcp() {
  const tools = [
    ["search_issues", "Find issues by text"],
    ["create_issue", "Open a new issue"],
    ["get_file", "Read a file from a repo"],
  ];
  return (
    <div className="sc-window">
      <div className="sc-bar">
        <i />
        <i />
        <i />
      </div>
      <div className="sc-mcp">
        <div className="sc-mcp-head">
          <Server size={14} /> <b>github-mcp</b> <span className="sc-tag ok">connected</span>
        </div>
        {tools.map(([n, d], j) => (
          <div key={n} className={`sc-tool ${j === 0 ? "hot" : ""}`} style={{ ["--d" as string]: `${0.2 + j * 0.2}s` }}>
            <span className="mono">{n}</span>
            <span className="muted">{d}</span>
          </div>
        ))}
        <div className="sc-result mono" style={{ ["--d" as string]: "1.5s" }}>
          {'{ "total": 12, "items": [ … ] }'}
        </div>
        <div className="sc-mcp-foot" style={{ ["--d" as string]: "1.9s" }}>
          <Waypoints size={13} /> A2A agents <span className="muted">·</span> <Bot size={13} /> Agentic tests
        </div>
      </div>
    </div>
  );
}

function SceneAsk() {
  return (
    <div className="sc-window">
      <div className="sc-bar">
        <i />
        <i />
        <i />
      </div>
      <div className="sc-chat">
        <div className="sc-q" style={{ ["--d" as string]: "0.2s" }}>
          Which product categories have the highest average price?
        </div>
        <div className="sc-step" style={{ ["--d" as string]: "0.9s" }}>
          <Sparkles size={12} /> Queried data in List products
        </div>
        <div className="sc-a" style={{ ["--d" as string]: "1.4s" }}>
          <b>Laptops</b> lead at $1,190, then <b>smartphones</b> at $720 and <b>tablets</b> at $480.
          <div className="sc-bars">
            <i style={{ width: "92%" }} />
            <i style={{ width: "56%" }} />
            <i style={{ width: "37%" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
