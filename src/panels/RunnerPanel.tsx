import { useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { useStore } from "../lib/store";
import type { HttpItem, Item } from "../lib/types";
import type { AssertionResult } from "../lib/types";
import { runHttp } from "./HttpPanel";
import { statusClass } from "../components/ui";

interface Row {
  path: string;
  name: string;
  method: string;
  status?: number;
  timeMs?: number;
  error?: string;
  results?: AssertionResult[];
  running?: boolean;
}

/** Runs every HTTP request in a folder, in order, chaining extracted variables between them. */
export default function RunnerPanel({ folder }: { folder: string }) {
  const items = useStore((s) => s.items);
  const reqs = Object.values(items)
    .filter((i): i is Item & HttpItem => i.kind === "http" && i.path.startsWith(`${folder}/`))
    .sort((a, b) => a.path.localeCompare(b.path));
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [delay, setDelay] = useState(0);
  const [iterations, setIterations] = useState(1);
  const [stopOnFail, setStopOnFail] = useState(false);
  const stop = useRef(false);

  const start = async () => {
    stop.current = false;
    setRunning(true);
    const all: Row[] = [];
    setRows([]);
    outer: for (let it = 0; it < iterations; it++) {
      for (const r of reqs) {
        if (stop.current) break outer;
        const row: Row = { path: r.path, name: iterations > 1 ? `${r.name} #${it + 1}` : r.name, method: r.method, running: true };
        all.push(row);
        setRows([...all]);
        // Read fresh from the store: an earlier request may have changed variables.
        const out = await runHttp(useStore.getState().items[r.path] as Item & HttpItem, "runner");
        Object.assign(row, { running: false, status: out.res?.status, timeMs: out.res?.timeMs, error: out.error, results: out.results });
        setRows([...all]);
        const failed = !!out.error || out.results?.some((x) => !x.pass) || (out.res && out.res.status >= 400 && !out.results?.length);
        if (failed && stopOnFail) break outer;
        if (delay) await new Promise((res) => setTimeout(res, delay));
      }
    }
    setRunning(false);
  };

  const total = rows.reduce((a, r) => a + (r.results?.length ?? 0), 0);
  const passed = rows.reduce((a, r) => a + (r.results?.filter((x) => x.pass).length ?? 0), 0);
  const errors = rows.filter((r) => r.error || (r.status ?? 0) >= 400).length;
  const name = folder.split("/").slice(1).join(" / ") || "All collections";
  return (
    <div className="panel">
      <div className="pad row" style={{ borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
        <div className="grow">
          <h2>Run · {name}</h2>
          <div className="muted">{reqs.length} requests, run in file order. Saved-to-environment values flow to later requests.</div>
        </div>
        <label className="check">
          iterations <input className="input mono" style={{ width: 60 }} type="number" min={1} value={iterations} onChange={(e) => setIterations(Math.max(1, Number(e.target.value)))} />
        </label>
        <label className="check">
          delay ms <input className="input mono" style={{ width: 70 }} type="number" min={0} value={delay} onChange={(e) => setDelay(Number(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={stopOnFail} onChange={(e) => setStopOnFail(e.target.checked)} /> stop on failure
        </label>
        {running ? (
          <button className="btn" onClick={() => (stop.current = true)}>
            <Square size={13} /> Stop
          </button>
        ) : (
          <button className="btn primary" onClick={start} disabled={!reqs.length}>
            <Play size={14} /> Run
          </button>
        )}
      </div>
      {!!rows.length && (
        <div className="row" style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
          <span>{rows.length} requests</span>
          <span className={passed === total ? "ok" : "err"}>
            {passed}/{total} assertions passed
          </span>
          {errors > 0 && <span className="err">{errors} errors / 4xx-5xx</span>}
          <span className="stat">{rows.reduce((a, r) => a + (r.timeMs ?? 0), 0).toFixed(0)} ms total</span>
        </div>
      )}
      <div className="scroll grow">
        {!rows.length && <div className="empty">Press Run to execute the folder.</div>}
        {rows.map((r, i) => (
          <div className="result" key={i} style={{ flexDirection: "column", gap: 4 }}>
            <div className="row" style={{ width: "100%" }}>
              <span className={`method m-${r.method}`}>{r.method}</span>
              <span className="grow link" style={{ cursor: "pointer" }} onClick={() => useStore.getState().openTab(r.path)}>
                {r.name}
              </span>
              {r.running && <Loader2 size={13} className="spin" />}
              {r.status !== undefined && <span className={statusClass(r.status)}>{r.status}</span>}
              {r.timeMs !== undefined && <span className="stat">{r.timeMs.toFixed(0)} ms</span>}
              {r.error && <span className="err mono">{r.error.slice(0, 80)}</span>}
            </div>
            {r.results?.map((t, j) => (
              <div key={j} className="mono" style={{ paddingLeft: 46, fontSize: 12 }}>
                <span className={t.pass ? "ok" : "err"}>{t.pass ? "✓" : "✗"}</span> {t.label}
                {!t.pass && <span className="muted">, got {t.actual}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
