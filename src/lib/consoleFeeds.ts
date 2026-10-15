import { logConsole } from "./devconsole";
import { onMcpLog, onWsEvent } from "./ipc";

/** Feeds MCP traffic, WebSocket frames and app errors into the Console. Call once at startup. */
export function installConsoleFeeds() {
  onMcpLog((e) => {
    const m: any = e.message;
    const isErr = e.dir === "stderr" || !!m?.error;
    const title =
      e.dir === "stderr" || e.dir === "info"
        ? String(m).slice(0, 200)
        : m?.method
          ? `${e.dir === "out" ? "→" : "←"} ${m.method}${m.id !== undefined ? ` #${m.id}` : ""}`
          : `${e.dir === "out" ? "→" : "←"} response #${m?.id ?? "?"}${m?.error ? ` error ${m.error.code}: ${m.error.message}` : ""}`;
    logConsole({ kind: "mcp", level: isErr ? (e.dir === "stderr" ? "warn" : "error") : "info", source: e.sessionId.startsWith("agent-") ? "agent" : "MCP", title, detail: m });
  }).catch(() => {});

  onWsEvent((e) => {
    const arrow = { open: "● open", in: "←", out: "→", close: "○ close", error: "✕ error" }[e.kind];
    logConsole({ kind: "ws", level: e.kind === "error" ? "error" : "info", source: "WebSocket", title: `${arrow} ${e.data.slice(0, 160)}`, size: e.data.length, detail: e.data });
  }).catch(() => {});

  const orig = console.error;
  console.error = (...a: unknown[]) => {
    logConsole({ kind: "log", level: "error", source: "app", title: a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ").slice(0, 300), detail: a.map((x) => (x instanceof Error ? x.stack : x)) });
    orig(...a);
  };
  window.addEventListener("unhandledrejection", (e) => logConsole({ kind: "log", level: "error", source: "app", title: `Unhandled: ${e.reason?.message ?? e.reason}`, detail: e.reason?.stack }));
}
