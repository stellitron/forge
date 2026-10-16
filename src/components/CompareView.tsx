import { useMemo, useState } from "react";
import { secretValues } from "../agent/egress";
import { headerDiff, hunks, jsonDiff, lineDiff, type JsonChange } from "../lib/diff";
import { tryJson } from "../lib/eval";
import { historyOf, maskEntry, useHistory } from "../lib/history";
import type { HttpResponse } from "../lib/types";

const show = (v: unknown) => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Changes({ list, empty }: { list: JsonChange[]; empty: string }) {
  if (!list.length) return <div className="muted" style={{ padding: "6px 14px" }}>{empty}</div>;
  return (
    <div className="selectable">
      {list.map((c, i) => (
        <div key={i} className="result mono" style={{ fontSize: 12 }}>
          <span className={c.kind === "added" ? "ok" : c.kind === "removed" ? "err" : "warn"} style={{ width: 14, flexShrink: 0 }}>
            {c.kind === "added" ? "+" : c.kind === "removed" ? "−" : "~"}
          </span>
          <span style={{ flexShrink: 0, maxWidth: "40%", wordBreak: "break-all" }}>{c.path}</span>
          <span className="dim" style={{ wordBreak: "break-all" }}>
            {c.kind === "changed" ? (
              <>
                <span className="err">{show(c.before)}</span> → <span className="ok">{show(c.after)}</span>
              </>
            ) : c.kind === "added" ? (
              <span className="ok">{show(c.after)}</span>
            ) : (
              <span className="err">{show(c.before)}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * This response against an earlier one of the same request: from before a change, or sent with
 * another environment (staging vs production). Both sides are masked the same way, so a token
 * isn't reported as different from its {{placeholder}}.
 */
export default function CompareView({ path, current, currentId }: { path: string; current: HttpResponse; currentId?: string }) {
  const entries = useHistory((s) => s.entries);
  const candidates = useMemo(() => historyOf(path, entries).filter((e) => e.id !== currentId), [path, entries, currentId]);
  const [baseId, setBaseId] = useState<string>("");
  const [lines, setLines] = useState(false);
  const [allHeaders, setAllHeaders] = useState(false);
  const base = candidates.find((e) => e.id === baseId) ?? candidates[0];
  const now = useMemo(() => maskEntry({ id: "", ts: 0, name: "", source: "", req: { method: "", url: "", headers: [] }, res: current }, secretValues()).res!, [current]);

  const result = useMemo(() => {
    if (!base?.res) return null;
    const a = tryJson(base.res.body);
    const b = tryJson(now.body);
    const json = a !== undefined && b !== undefined && typeof a === "object" && typeof b === "object";
    const pretty = (s: string, j: unknown) => (j !== undefined && typeof j === "object" ? JSON.stringify(j, null, 2) : s);
    const ops = lineDiff(pretty(base.res.body, a).split("\n"), pretty(now.body, b).split("\n"));
    return { json, body: json ? jsonDiff(a, b) : null, ops };
  }, [base, now]);

  if (!candidates.length) return <div className="empty">Send this request again to compare. Earlier responses come from its history.</div>;
  const r = base!.res!;
  const pct = (x: number, y: number) => (x ? `${y >= x ? "+" : ""}${Math.round(((y - x) / x) * 100)}%` : "");
  const headers = headerDiff(r.headers, now.headers, !allHeaders);
  return (
    <div className="scroll">
      <div className="row pad" style={{ flexWrap: "wrap" }}>
        <span className="muted">Compared with</span>
        <select className="select" value={base!.id} onChange={(e) => setBaseId(e.target.value)}>
          {candidates.map((e) => (
            <option key={e.id} value={e.id}>
              {when(e.ts)}
              {e.env ? ` · ${e.env}` : ""} · {e.res!.status}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ padding: "0 14px 8px", gap: 16, flexWrap: "wrap" }}>
        <span className={r.status !== now.status ? "warn" : "muted"}>
          Status {r.status} → {now.status}
        </span>
        <span className="muted">
          Time {Math.round(r.timeMs)} → {Math.round(now.timeMs)} ms {pct(r.timeMs, now.timeMs)}
        </span>
        <span className="muted">
          Size {r.size} → {now.size} B
        </span>
      </div>
      <div className="row" style={{ padding: "6px 14px", borderTop: "1px solid var(--line)" }}>
        <h3 className="grow">Body</h3>
        {result?.json && (
          <label className="check">
            <input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} /> Show lines
          </label>
        )}
      </div>
      {result?.json && !lines ? (
        <>
          <Changes list={result.body!.changes} empty="No differences." />
          {result.body!.more && <div className="muted" style={{ padding: "4px 14px" }}>More differences not shown.</div>}
        </>
      ) : !result?.ops ? (
        <div className="muted" style={{ padding: "6px 14px" }}>The bodies are too different to show line by line.</div>
      ) : !result.ops.some((o) => o.op !== "same") ? (
        <div className="muted" style={{ padding: "6px 14px" }}>No differences.</div>
      ) : (
        <pre className="block selectable" style={{ margin: "0 14px", padding: 0 }}>
          {hunks(result.ops).map((h, i) =>
            h.op === "skip" ? (
              <div key={i} className="muted" style={{ padding: "0 8px" }}>
                ⋯ {h.count} unchanged line{h.count === 1 ? "" : "s"}
              </div>
            ) : (
              <div key={i} style={{ padding: "0 8px", background: h.op === "add" ? "color-mix(in srgb, var(--ok, #22c55e) 14%, transparent)" : h.op === "del" ? "color-mix(in srgb, var(--err, #ef4444) 14%, transparent)" : undefined }}>
                {h.op === "add" ? "+ " : h.op === "del" ? "− " : "  "}
                {h.text}
              </div>
            ),
          )}
        </pre>
      )}
      <div className="row" style={{ padding: "10px 14px 6px", borderTop: "1px solid var(--line)", marginTop: 10 }}>
        <h3 className="grow">Headers</h3>
        <label className="check" title="Date, Age, ETag, request and trace IDs and similar change on every response">
          <input type="checkbox" checked={allHeaders} onChange={(e) => setAllHeaders(e.target.checked)} /> Include ones that always change
        </label>
      </div>
      <Changes list={headers} empty="No differences." />
    </div>
  );
}
