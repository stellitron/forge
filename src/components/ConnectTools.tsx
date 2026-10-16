import { useState } from "react";
import { Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { writeText } from "../lib/clipboard";
import { DEFAULT_PORT, newToken, useServer } from "../lib/forgeServer";
import { useStore, type Settings } from "../lib/store";

type Client = { id: string; label: string; where: string; snippet: (u: string, t: string) => string; note?: string };

const CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    where: "Run in a terminal",
    snippet: (u, t) => `claude mcp add --transport http forge ${u}/mcp --header "Authorization: Bearer ${t}"`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    where: "Settings → Developer → Edit Config (claude_desktop_config.json)",
    snippet: (u, t) =>
      JSON.stringify({ mcpServers: { forge: { command: "npx", args: ["-y", "mcp-remote", `${u}/mcp`, "--header", "Authorization:${FORGE_AUTH}"], env: { FORGE_AUTH: `Bearer ${t}` } } } }, null, 2),
    note: "Needs Node.js. Restart Claude Desktop afterwards.",
  },
  {
    id: "vscode",
    label: "VS Code · GitHub Copilot",
    where: ".vscode/mcp.json (or MCP: Open User Configuration)",
    snippet: (u) =>
      JSON.stringify(
        {
          inputs: [{ type: "promptString", id: "forge-token", description: "Forge token (Forge → Settings → Connect AI tools)", password: true }],
          servers: { forge: { type: "http", url: `${u}/mcp`, headers: { Authorization: "Bearer ${input:forge-token}" } } },
        },
        null,
        2,
      ),
    note: "VS Code asks for the token once and stores it securely, so this file is safe to commit. Use it from Copilot Chat in Agent mode.",
  },
  {
    id: "cursor",
    label: "Cursor",
    where: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
    snippet: (u, t) => JSON.stringify({ mcpServers: { forge: { url: `${u}/mcp`, headers: { Authorization: `Bearer ${t}` } } } }, null, 2),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    where: "~/.codeium/windsurf/mcp_config.json",
    snippet: (u, t) => JSON.stringify({ mcpServers: { forge: { serverUrl: `${u}/mcp`, headers: { Authorization: `Bearer ${t}` } } } }, null, 2),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    where: "~/.gemini/settings.json",
    snippet: (u, t) => JSON.stringify({ mcpServers: { forge: { httpUrl: `${u}/mcp`, headers: { Authorization: `Bearer ${t}` } } } }, null, 2),
  },
  {
    id: "a2a",
    label: "Google A2A / ADK",
    where: "Any A2A client: agent card + bearer token. Python ADK example:",
    snippet: (u, t) => `import httpx
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent

forge = RemoteA2aAgent(
    name="forge",
    description="My local API workspace",
    agent_card="${u}/.well-known/agent-card.json",
    httpx_client=httpx.AsyncClient(headers={"Authorization": "Bearer ${t}"}, timeout=600),
)`,
    note: "Answers use the model configured under Agent model. JSON-RPC endpoint: /a2a (message/send).",
  },
  {
    id: "copilot-studio",
    label: "Microsoft Copilot Studio",
    where: "Cloud agents can't reach localhost. Expose Forge through a tunnel first:",
    snippet: (u, t) => `# 1. Tunnel (any one of these)
cloudflared tunnel --url ${u}
# or: ngrok http ${u.split(":").pop()}
# or: VS Code → Ports → Forward ${u.split(":").pop()} (set visibility Public)

# 2. Copilot Studio → Tools → Add a tool → Model Context Protocol
#    Server URL:  https://<your-tunnel-host>/mcp
#    Authentication: API key → Header "Authorization", value "Bearer ${t}"`,
    note: "Anyone with the tunnel URL and token can use your workspace while the tunnel runs. Keep “Ask before requests that change data” on, and stop the tunnel when done.",
  },
];

export default function ConnectTools({ embedded = false }: { embedded?: boolean }) {
  const server = useStore((s) => s.settings.server);
  const save = useStore((s) => s.saveSettings);
  const status = useServer();
  const [client, setClient] = useState(CLIENTS[0].id);
  const [show, setShow] = useState(false);
  const cfg: NonNullable<Settings["server"]> = server ?? { enabled: false, port: DEFAULT_PORT, token: "", approveWrites: true };
  const set = (p: Partial<typeof cfg>) => save({ server: { ...cfg, ...p } });
  const url = status.url ?? `http://127.0.0.1:${cfg.port}`;
  const token = cfg.token || "<enable to generate>";
  const c = CLIENTS.find((x) => x.id === client)!;
  const snippet = c.snippet(url, token);

  return (
    <div className={embedded ? "col" : "card col"}>
      {!embedded && <h3>Connect AI tools</h3>}
      <div className="muted">
        Run Forge as a local <b>MCP server</b> and <b>A2A agent</b> so Claude, Copilot, Cursor and other assistants can list, read and run the requests in this workspace. It listens on 127.0.0.1 only and every call needs the token.
      </div>
      <label className="check">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked, token: cfg.token || newToken() })} />
        Enable Forge server
        {status.running && <span className="ok" style={{ fontSize: 12 }}>● running at {status.url}</span>}
        {status.error && <span className="err" style={{ fontSize: 12 }}>{status.error}</span>}
      </label>
      <div className="row">
        <label className="field" style={{ width: 110 }}>
          Port
          <input className="input mono" type="number" value={cfg.port} onChange={(e) => set({ port: Math.max(1, Math.min(65535, Number(e.target.value) || DEFAULT_PORT)) })} />
        </label>
        <label className="field grow">
          Token
          <div className="row" style={{ gap: 4 }}>
            <input className="input mono grow" readOnly type={show ? "text" : "password"} value={cfg.token} placeholder="Generated when enabled" />
            <button className="btn icon" title={show ? "Hide" : "Show"} onClick={() => setShow(!show)}>
              {show ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button className="btn icon" title="Copy" disabled={!cfg.token} onClick={() => writeText(cfg.token).then(() => useStore.getState().notify("Token copied"))}>
              <Copy size={13} />
            </button>
            <button className="btn icon" title="New token (disconnects existing clients)" onClick={() => set({ token: newToken() })}>
              <RefreshCw size={13} />
            </button>
          </div>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={cfg.approveWrites} onChange={(e) => set({ approveWrites: e.target.checked })} />
        Ask before requests that change data (POST, PUT, PATCH, DELETE) or saving new requests. Editing requests, settings, variables and imports always asks.
      </label>
      <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 6 }}>
        {CLIENTS.map((x) => (
          <button key={x.id} className={`chip ${x.id === client ? "on" : ""}`} onClick={() => setClient(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{c.where}</div>
      <div className="md-code">
        <button className="btn ghost sm" onClick={() => writeText(snippet).then(() => useStore.getState().notify(`Copied ${c.label} setup`))}>
          <Copy size={12} /> Copy
        </button>
        <pre className="selectable">{show ? snippet : snippet.split(cfg.token || "\0").join("••••••••")}</pre>
      </div>
      {c.note && <div className="muted" style={{ fontSize: 12 }}>{c.note}</div>}
      {!cfg.enabled && <div className="muted" style={{ fontSize: 12 }}>Enable the server first, then paste this into {c.label}.</div>}
    </div>
  );
}
