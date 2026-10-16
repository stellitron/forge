import { ExternalLink, FilePlus2, Loader2, RotateCw } from "lucide-react";
import { useState } from "react";
import { historyTab } from "../components/HistoryList";
import { Split } from "../components/ui";
import { HIDDEN, entryToItem, resendEntry, useHistory, type HistoryEntry } from "../lib/history";
import { COLLECTIONS, dirname, useStore } from "../lib/store";
import { ResponseView } from "./HttpPanel";

export async function sendAgain(e: HistoryEntry) {
  try {
    const next = await resendEntry(e);
    if (next) useStore.getState().openTab(historyTab(next.id));
  } catch (err) {
    useStore.getState().notify(err instanceof Error ? err.message : String(err), "error");
  }
}

/** Saves the entry as a new request next to the one it came from (or in a History collection). */
export async function saveHistoryAsRequest(e: HistoryEntry) {
  const st = useStore.getState();
  const folder = e.path && st.items[e.path] ? dirname(e.path) : `${COLLECTIONS}/History`;
  if (!st.dirs.includes(folder) && folder !== COLLECTIONS) await st.createFolder(folder);
  await st.createItem(folder, "http", e.path ? `${e.name} (from history)` : e.name, entryToItem(e));
  if (JSON.stringify(e.req).includes(HIDDEN)) st.notify("Saved. A credential typed into the original wasn't kept; add it back in Auth or Headers.");
}

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

export default function HistoryPanel({ id }: { id: string }) {
  const e = useHistory((s) => s.entries.find((x) => x.id === id));
  const exists = useStore((s) => !!(e?.path && s.items[e.path]));
  const [busy, setBusy] = useState(false);
  if (!e) return <div className="empty">This entry is no longer in the history.</div>;
  const body = e.req.body;
  const bodyText =
    body?.type === "raw" ? body.content
    : body?.type === "form" || body?.type === "multipart" ? body.fields.filter((f) => f.enabled).map((f) => `${f.key}=${f.value}`).join("\n")
    : body?.type === "binary" ? `File: ${body.path}`
    : "";
  return (
    <div className="panel">
      <div className="urlbar">
        <span className={`method m-${e.req.method}`} style={{ padding: "0 4px" }}>
          {e.req.method}
        </span>
        <div className="group mono" style={{ padding: "0 10px", display: "flex", alignItems: "center", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }} title={e.req.url}>
          {e.req.url}
        </div>
        {exists && (
          <button className="btn sm" onClick={() => useStore.getState().openTab(e.path!)} title="Open the saved request">
            <ExternalLink size={13} /> Open request
          </button>
        )}
        <button className="btn sm" onClick={() => saveHistoryAsRequest(e)} title="Save as a new request">
          <FilePlus2 size={13} /> Save as request
        </button>
        <button className="btn primary sm" disabled={busy} onClick={async () => (setBusy(true), await sendAgain(e), setBusy(false))} title="Send again with today's variable values">
          {busy ? <Loader2 size={13} className="spin" /> : <RotateCw size={13} />} Send again
        </button>
      </div>
      <div className="muted" style={{ padding: "6px 14px", fontSize: 12, borderBottom: "1px solid var(--line)" }}>
        {e.name} · {when(e.ts)}
        {e.env ? ` · ${e.env}` : ""} · from {e.source}
        {e.truncated ? " · response body shortened" : ""}
      </div>
      <Split
        id="history"
        a={
          <div className="scroll pad col">
            <h3>Headers</h3>
            {e.req.headers.length ? (
              <table className="kv selectable">
                <tbody>
                  {e.req.headers.map((h, i) => (
                    <tr key={i}>
                      <td className="mono dim" style={{ padding: "4px 10px", width: "35%" }}>
                        {h.key}
                      </td>
                      <td className="mono" style={{ padding: "4px 10px", wordBreak: "break-all" }}>
                        {h.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="muted">None</div>
            )}
            {bodyText && (
              <>
                <h3>Body</h3>
                <pre className="block selectable">{bodyText}</pre>
              </>
            )}
            <div className="muted" style={{ fontSize: 11.5 }}>
              Secret values are stored as their {"{{placeholders}}"}, so history never holds your tokens.
            </div>
          </div>
        }
        b={e.res || e.error ? <ResponseView path={e.path ?? ""} state={e.res ? { res: e.res, results: e.results, historyId: e.id } : { error: e.error }} /> : <div className="empty">No response.</div>}
      />
    </div>
  );
}
