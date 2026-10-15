import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { Loader2, Play, Plug, PlugZap, RefreshCw } from "lucide-react";
import { interpolate } from "../lib/eval";
import { mcp, onMcpLog, splitArgs, type JsonRpcResponse, type McpConfig, type McpLog } from "../lib/ipc";
import VarInput from "../components/VarInput";
import { useStore } from "../lib/store";
import type { Item, McpItem } from "../lib/types";
import { Editor, KvTable, Seg, Split, fmtTime, skeleton } from "../components/ui";

interface Live {
  status: "idle" | "connecting" | "connected" | "error";
  error?: string;
  info?: any;
  tools?: any[];
  resources?: any[];
  templates?: any[];
  prompts?: any[];
  log: McpLog[];
}

/** Live MCP sessions keyed by item path; survives tab switches. */
const useLive = create<{ s: Record<string, Live>; patch: (id: string, p: Partial<Live>) => void }>((set) => ({
  s: {},
  patch: (id, p) => set((st) => ({ s: { ...st.s, [id]: { ...(st.s[id] ?? { status: "idle", log: [] }), ...p } } })),
}));

onMcpLog((e) => {
  const st = useLive.getState();
  const cur = st.s[e.sessionId];
  if (!cur) return;
  const log = cur.log.length > 2000 ? [...cur.log.slice(-1500), e] : [...cur.log, e];
  st.patch(e.sessionId, { log, ...(e.dir === "info" && e.message === "server process exited" ? { status: "error", error: "Server process exited" } : {}) });
});

export function mcpConfig(item: McpItem, vars: Record<string, string>): McpConfig {
  const v = (s: string) => interpolate(s, vars);
  return item.transport === "stdio"
    ? { transport: "stdio", command: v(item.command), args: splitArgs(v(item.args)), env: item.env.map((e) => ({ ...e, value: v(e.value) })), cwd: item.cwd || undefined }
    : { transport: item.transport, url: v(item.url), headers: item.headers.map((h) => ({ ...h, value: v(h.value) })) };
}

type Tab = "tools" | "resources" | "prompts" | "raw" | "log" | "config";

const MCP_METHODS = [
  { value: "ping", hint: "Check the server is alive" },
  { value: "tools/list", hint: "List tools" },
  { value: "tools/call", hint: "Call a tool" },
  { value: "resources/list", hint: "List resources" },
  { value: "resources/read", hint: "Read a resource" },
  { value: "resources/templates/list", hint: "List resource templates" },
  { value: "prompts/list", hint: "List prompts" },
  { value: "prompts/get", hint: "Get a prompt" },
  { value: "completion/complete", hint: "Argument completions" },
  { value: "logging/setLevel", hint: "Set server log level" },
];

export default function McpPanel({ item }: { item: Item & McpItem }) {
  const update = useStore((s) => s.updateItem);
  const live = useLive((s) => s.s[item.path]) ?? { status: "idle", log: [] };
  const patch = useLive((s) => s.patch);
  const [tab, setTab] = useState<Tab>(live.status === "connected" ? "tools" : "config");
  const set = (p: Partial<McpItem>) => update(item.path, p);
  const id = item.path;

  const list = async (method: string, key: string) => {
    const r = await mcp.request(id, method, {});
    return r.result?.[key] ?? [];
  };

  const refresh = async (info = live.info) => {
    const caps = info?.capabilities ?? {};
    const [tools, resources, templates, prompts] = await Promise.all([
      caps.tools ? list("tools/list", "tools") : [],
      caps.resources ? list("resources/list", "resources") : [],
      caps.resources ? list("resources/templates/list", "resourceTemplates").catch(() => []) : [],
      caps.prompts ? list("prompts/list", "prompts") : [],
    ]);
    patch(id, { tools, resources, templates, prompts });
  };

  const connect = async () => {
    patch(id, { status: "connecting", error: undefined, log: [] });
    try {
      const info = await mcp.connect(id, mcpConfig(item, useStore.getState().vars()));
      patch(id, { status: "connected", info });
      setTab("tools");
      await refresh(info);
    } catch (e) {
      patch(id, { status: "error", error: String(e) });
      setTab("log");
    }
  };

  const disconnect = async () => {
    await mcp.disconnect(id);
    patch(id, { status: "idle", info: undefined, tools: [], resources: [], prompts: [] });
  };

  const connected = live.status === "connected";
  const server = live.info?.serverInfo;
  return (
    <div className="panel">
      <div className="urlbar" style={{ alignItems: "center" }}>
        <select className="select" style={{ height: 34 }} value={item.transport} onChange={(e) => set({ transport: e.target.value as McpItem["transport"] })}>
          <option value="stdio">STDIO</option>
          <option value="http">Streamable HTTP</option>
          <option value="sse">SSE (legacy)</option>
        </select>
        <div className="group">
          {item.transport === "stdio" ? (
            <>
              <input style={{ maxWidth: 160, borderRight: "1px solid var(--line)" }} value={item.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" spellCheck={false} />
              <input value={item.args} onChange={(e) => set({ args: e.target.value })} placeholder="-y @modelcontextprotocol/server-everything" spellCheck={false} />
            </>
          ) : (
            <input value={item.url} onChange={(e) => set({ url: e.target.value })} placeholder={item.transport === "http" ? "http://localhost:3001/mcp" : "http://localhost:3001/sse"} spellCheck={false} />
          )}
        </div>
        {connected ? (
          <button className="btn" style={{ height: 34 }} onClick={disconnect}>
            <PlugZap size={14} /> Disconnect
          </button>
        ) : (
          <button className="btn primary" style={{ height: 34 }} onClick={connect} disabled={live.status === "connecting"}>
            {live.status === "connecting" ? <Loader2 size={14} className="spin" /> : <Plug size={14} />} Connect
          </button>
        )}
      </div>
      <div className="row" style={{ padding: "0 14px 10px", gap: 10 }}>
        <span className={connected ? "ok" : live.status === "error" ? "err" : "muted"}>●</span>
        {connected ? (
          <span>
            <b>{server?.name ?? "server"}</b> <span className="muted">{server?.version}</span> <span className="muted">· protocol {live.info?.protocolVersion}</span>
          </span>
        ) : (
          <span className={live.status === "error" ? "err" : "muted"}>{live.error ?? (live.status === "connecting" ? "Connecting…" : "Not connected")}</span>
        )}
        <div className="spacer" />
        {connected && (
          <button className="btn ghost sm" onClick={() => refresh()}>
            <RefreshCw size={12} /> Refresh
          </button>
        )}
      </div>
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { id: "tools", label: "Tools", count: live.tools?.length },
          { id: "resources", label: "Resources", count: (live.resources?.length ?? 0) + (live.templates?.length ?? 0) },
          { id: "prompts", label: "Prompts", count: live.prompts?.length },
          { id: "raw", label: "Raw JSON-RPC" },
          { id: "log", label: "Traffic", count: live.log.length },
          { id: "config", label: item.transport === "stdio" ? "Env & cwd" : "Headers" },
        ]}
      />
      <div className="grow" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {tab === "config" && (
          <div className="scroll">
            {item.transport === "stdio" ? (
              <div className="col pad">
                <label className="field">
                  Working directory
                  <input className="input mono" value={item.cwd} onChange={(e) => set({ cwd: e.target.value })} placeholder="(inherit)" />
                </label>
                <h3>Environment variables</h3>
                <KvTable rows={item.env} onChange={(env) => set({ env })} keyPh="NAME" />
              </div>
            ) : (
              <KvTable rows={item.headers} onChange={(headers) => set({ headers })} keyPh="Header" />
            )}
          </div>
        )}
        {tab === "tools" && <Invoker id={id} kind="tool" entries={live.tools ?? []} connected={connected} />}
        {tab === "resources" && <Invoker id={id} kind="resource" entries={[...(live.resources ?? []), ...(live.templates ?? [])]} connected={connected} />}
        {tab === "prompts" && <Invoker id={id} kind="prompt" entries={live.prompts ?? []} connected={connected} />}
        {tab === "raw" && <Raw id={id} connected={connected} />}
        {tab === "log" && <Traffic log={live.log} />}
      </div>
    </div>
  );
}

function Invoker({ id, kind, entries, connected }: { id: string; kind: "tool" | "resource" | "prompt"; entries: any[]; connected: boolean }) {
  const [sel, setSel] = useState(0);
  const [args, setArgs] = useState("{}");
  const [out, setOut] = useState<{ loading?: boolean; res?: JsonRpcResponse; err?: string; ms?: number }>({});
  const [filter, setFilter] = useState("");
  const shown = entries.filter((e) => !filter || JSON.stringify([e.name, e.uri, e.uriTemplate, e.description]).toLowerCase().includes(filter.toLowerCase()));
  const cur = shown[sel];

  useEffect(() => {
    if (!cur) return;
    if (kind === "tool") setArgs(JSON.stringify(skeleton(cur.inputSchema) ?? {}, null, 2));
    if (kind === "prompt") setArgs(JSON.stringify(Object.fromEntries((cur.arguments ?? []).map((a: any) => [a.name, ""])), null, 2));
    if (kind === "resource") setArgs(JSON.stringify({ uri: cur.uri ?? cur.uriTemplate }, null, 2));
    setOut({});
  }, [cur, kind]);

  const run = async () => {
    let parsed: any;
    try {
      parsed = JSON.parse(args || "{}");
    } catch (e) {
      return setOut({ err: `Invalid JSON: ${(e as Error).message}` });
    }
    setOut({ loading: true });
    const t0 = performance.now();
    try {
      const res =
        kind === "tool"
          ? await mcp.request(id, "tools/call", { name: cur.name, arguments: parsed })
          : kind === "prompt"
            ? await mcp.request(id, "prompts/get", { name: cur.name, arguments: parsed })
            : await mcp.request(id, "resources/read", { uri: parsed.uri });
      setOut({ res, ms: performance.now() - t0 });
    } catch (e) {
      setOut({ err: String(e) });
    }
  };

  if (!connected) return <div className="empty">Connect to the server to explore its {kind}s.</div>;
  if (!entries.length) return <div className="empty">This server exposes no {kind}s.</div>;
  const isError = out.res?.error || out.res?.result?.isError;
  return (
    <Split
      id={`mcp-${kind}`}
      a={
        <div className="col scroll" style={{ padding: 8, gap: 4 }}>
          <input className="input" placeholder={`Filter ${entries.length} ${kind}s`} value={filter} onChange={(e) => (setFilter(e.target.value), setSel(0))} />
          {shown.map((e, i) => (
            <div key={i} className={`list-item ${i === sel ? "on" : ""}`} onClick={() => setSel(i)}>
              <div className="mono" style={{ fontWeight: 600 }}>
                {e.name ?? e.uri ?? e.uriTemplate}
              </div>
              {e.description && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{e.description.slice(0, 160)}</div>}
              {e.annotations && (
                <div style={{ marginTop: 4 }}>
                  {Object.entries(e.annotations)
                    .filter(([, v]) => v === true)
                    .map(([k]) => (
                      <span className="tag" key={k}>
                        {k.replace(/Hint$/, "")}
                      </span>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      }
      b={
        cur ? (
          <Split
            id="mcp-io"
            dir="v"
            a={
              <>
                <div className="row" style={{ padding: "8px 12px" }}>
                  <h3 className="grow">{kind === "tool" ? "Arguments" : kind === "prompt" ? "Prompt arguments" : "Resource"}</h3>
                  <button className="btn primary sm" onClick={run} disabled={out.loading}>
                    {out.loading ? <Loader2 size={12} className="spin" /> : <Play size={12} />} {kind === "tool" ? "Call" : kind === "prompt" ? "Get" : "Read"}
                  </button>
                </div>
                <Editor value={args} onChange={setArgs} />
              </>
            }
            b={
              <>
                <div className="row" style={{ padding: "8px 12px" }}>
                  <h3 className="grow">Result</h3>
                  {out.ms !== undefined && <span className="stat">{out.ms.toFixed(0)} ms</span>}
                  {out.res && <span className={isError ? "err" : "ok"}>{isError ? "error" : "ok"}</span>}
                </div>
                {out.err ? <pre className="block err" style={{ margin: 12 }}>{out.err}</pre> : <Editor readOnly value={out.res ? JSON.stringify(out.res.error ?? out.res.result, null, 2) : ""} />}
              </>
            }
          />
        ) : (
          <div className="empty">No match</div>
        )
      }
    />
  );
}

function Raw({ id, connected }: { id: string; connected: boolean }) {
  const [method, setMethod] = useState("ping");
  const [params, setParams] = useState("{}");
  const [notify, setNotify] = useState(false);
  const [out, setOut] = useState("");
  const send = async () => {
    try {
      const p = params.trim() ? JSON.parse(params) : undefined;
      if (notify) {
        await mcp.notify(id, method, p);
        setOut("(notification sent, no response expected)");
      } else setOut(JSON.stringify(await mcp.request(id, method, p), null, 2));
    } catch (e) {
      setOut(String(e));
    }
  };
  if (!connected) return <div className="empty">Connect first.</div>;
  return (
    <Split
      id="mcp-raw"
      a={
        <>
          <div className="row" style={{ padding: 10 }}>
            <VarInput className="input-like grow" value={method} onChange={(e) => setMethod(e.target.value)} suggestions={MCP_METHODS} onPick={setMethod} />
            <label className="check">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> notification
            </label>
            <button className="btn primary sm" onClick={send}>
              <Play size={12} /> Send
            </button>
          </div>
          <Editor value={params} onChange={setParams} />
        </>
      }
      b={<Editor readOnly value={out} />}
    />
  );
}

function Traffic({ log }: { log: McpLog[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const rows = useMemo(() => log.slice(-500), [log]);
  if (!log.length) return <div className="empty">No traffic yet.</div>;
  const arrow = { out: "→", in: "←", stderr: "!", info: "·" };
  return (
    <div className="scroll log">
      {rows.map((l, i) => {
        const m: any = l.message;
        const text = typeof m === "string" ? m : open === i ? JSON.stringify(m, null, 2) : JSON.stringify(m);
        return (
          <div className="line" key={i} onClick={() => setOpen(open === i ? null : i)}>
            <span className="ts">{fmtTime(l.ts)}</span>
            <span className={`dir d-${l.dir}`}>{arrow[l.dir]}</span>
            <span className="body" style={open === i ? undefined : { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
