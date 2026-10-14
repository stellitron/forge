import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Copy, Eye, EyeOff, X } from "lucide-react";
import { writeText } from "../lib/clipboard";
import { formatBytes, prettyBody } from "../lib/eval";
import { isSecretHeader, useConsole, type ConsoleEntry, type ConsoleKind } from "../lib/devconsole";
import { toCurl } from "../lib/request";
import { Editor, fmtTime, statusClass } from "./ui";

const KINDS: { id: ConsoleKind; label: string }[] = [
  { id: "http", label: "HTTP" },
  { id: "mcp", label: "MCP" },
  { id: "ws", label: "WebSocket" },
  { id: "server", label: "Server" },
  { id: "log", label: "Logs" },
];

/** Dev-tools style drawer: every request, MCP message, socket frame and error, newest at the bottom. */
export default function ConsolePanel() {
  const { entries, clear, toggle } = useConsole();
  const [kinds, setKinds] = useState<Set<ConsoleKind>>(new Set());
  const [q, setQ] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [height, setHeight] = useState(() => Number(localStorage.getItem("console:h")) || 300);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = useMemo(() => {
    const needle = q.toLowerCase();
    return entries.filter(
      (e) =>
        (!kinds.size || kinds.has(e.kind)) &&
        (!errorsOnly || e.level !== "info") &&
        (!needle || e.title.toLowerCase().includes(needle) || e.source.toLowerCase().includes(needle) || String(e.status ?? "").includes(needle)),
    );
  }, [entries, kinds, q, errorsOnly]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const resize = (e: React.MouseEvent) => {
    const y0 = e.clientY;
    const h0 = height;
    const move = (ev: MouseEvent) => setHeight(Math.min(window.innerHeight - 160, Math.max(140, h0 + y0 - ev.clientY)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setHeight((h) => (localStorage.setItem("console:h", String(h)), h));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const count = (k: ConsoleKind) => entries.filter((e) => e.kind === k).length;
  const current = entries.find((e) => e.id === sel);

  return (
    <div className="console" style={{ height }}>
      <div className="console-resize" onMouseDown={resize} />
      <div className="console-bar">
        <b style={{ fontSize: 12 }}>Console</b>
        {KINDS.map((k) => (
          <button
            key={k.id}
            className={`chip ${kinds.has(k.id) ? "on" : ""}`}
            onClick={() => setKinds((s) => {
              const n = new Set(s);
              n.has(k.id) ? n.delete(k.id) : n.add(k.id);
              return n;
            })}
          >
            {k.label} <span className="muted">{count(k.id)}</span>
          </button>
        ))}
        <label className="check" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors & warnings
        </label>
        <input className="input" style={{ height: 24, width: 200, fontSize: 12 }} placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <button className="btn ghost icon sm" title="Clear" onClick={() => (clear(), setSel(null))}>
          <Ban size={13} />
        </button>
        <button className="btn ghost icon sm" title="Close (⌘J)" onClick={() => toggle(false)}>
          <X size={14} />
        </button>
      </div>
      <div className="console-body">
        <div
          className="console-list"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}
        >
          {!shown.length && <div className="empty" style={{ padding: 20 }}>Nothing yet. Requests, MCP traffic, WebSocket frames and errors show up here.</div>}
          {shown.map((e) => (
            <div key={e.id} className={`console-row ${e.level} ${e.id === sel ? "sel" : ""}`} onClick={() => setSel(e.id === sel ? null : e.id)}>
              <span className="muted mono">{fmtTime(e.ts)}</span>
              <span className={`kind k-${e.kind}`}>{e.kind}</span>
              <span className="src">{e.source}</span>
              <span className="title mono">{e.title}</span>
              {typeof e.status === "number" ? <span className={statusClass(e.status)}>{e.status}</span> : e.status ? <span className="muted">{e.status}</span> : null}
              {e.ms !== undefined && <span className="muted mono">{Math.round(e.ms)} ms</span>}
              {e.size !== undefined && <span className="muted mono">{formatBytes(e.size)}</span>}
            </div>
          ))}
        </div>
        {current && <Detail e={current} />}
      </div>
    </div>
  );
}

function Detail({ e }: { e: ConsoleEntry }) {
  const [reveal, setReveal] = useState(false);
  const mask = (k: string, v: string) => (!reveal && isSecretHeader(k) && v ? `${v.slice(0, 6)}••••••` : v);
  const res = e.response;
  const ctype = res?.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
  const text = e.request
    ? [
        `${e.request.method} ${e.request.url}`,
        ...e.request.headers.filter((h) => h.enabled !== false).map((h) => `${h.key}: ${mask(h.key, h.value)}`),
        e.request.body?.type === "raw" ? `\n${prettyBody(e.request.body.content)}` : e.request.body && e.request.body.type !== "none" ? `\n<${e.request.body.type} body>` : "",
        "",
        "────────── response ──────────",
        res ? `${[res.status, res.statusText].filter(Boolean).join(" ")} · ${Math.round(res.timeMs)} ms · ${formatBytes(res.size)}` : String(e.detail ?? "(pending)"),
        ...(res?.headers ?? []).map((h) => `${h.key}: ${mask(h.key, h.value)}`),
        res ? `\n${res.bodyBase64 ? `<binary ${formatBytes(res.size)}>` : prettyBody(res.body.slice(0, 200_000), ctype)}` : "",
      ].join("\n")
    : typeof e.detail === "string"
      ? e.detail
      : JSON.stringify(e.detail, null, 2);
  return (
    <div className="console-detail">
      <div className="row" style={{ padding: "4px 8px", borderBottom: "1px solid var(--line)" }}>
        <span className="muted" style={{ fontSize: 12 }}>{e.source} · {new Date(e.ts).toLocaleString()}</span>
        <div className="spacer" />
        {e.request && (
          <button className="btn ghost sm" onClick={() => setReveal((r) => !r)} title="Show or hide credentials in headers">
            {reveal ? <EyeOff size={12} /> : <Eye size={12} />} {reveal ? "Hide" : "Show"} secrets
          </button>
        )}
        {e.request && (
          <button className="btn ghost sm" onClick={() => writeText(toCurl(e.request!))}>
            <Copy size={12} /> cURL
          </button>
        )}
      </div>
      <Editor readOnly value={text ?? ""} lang="text" />
    </div>
  );
}
