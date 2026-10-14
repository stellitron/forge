import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Columns3, Download, MessageSquare } from "lucide-react";
import { exportAndNotify } from "../lib/exporter";
import { FORMATS, type Format } from "../lib/report";
import { analyze, cell, highlights, pickColumns, query, type Shape } from "../lib/shape";
import type { HttpResponse } from "../lib/types";
import { Menu } from "./ui";
import { askAbout } from "../lib/chatUi";

const PAGE = 200;

/** Parses once per response; null when the body isn't JSON with anything tabular in it. */
export function useShape(res: HttpResponse | undefined): Shape | null {
  return useMemo(() => {
    if (!res || res.bodyBase64) return null;
    try {
      const s = analyze(JSON.parse(res.body));
      return s.datasets.length ? s : null;
    } catch {
      return null;
    }
  }, [res]);
}

export default function DataView({ shape, res, name, req }: { shape: Shape; res: HttpResponse; name: string; req: { method: string; url: string } }) {
  const [dsId, setDsId] = useState(shape.datasets[0].id);
  const ds = shape.datasets.find((d) => d.id === dsId) ?? shape.datasets[0];
  const [hidden, setHidden] = useState<Record<string, Set<string>>>({});
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "export" | "columns" } | null>(null);

  // Wide tables start with the most readable columns; the rest are one click away.
  const hide = hidden[ds.id] ?? new Set(ds.columns.length > 10 ? ds.columns.map((c) => c.key).filter((k) => !pickColumns(ds, 10).includes(k)) : []);
  const cols = ds.columns.filter((c) => !hide.has(c.key));
  const result = useMemo(() => {
    const where = q.trim() ? undefined : [];
    const r = query(ds, { sort: sort ? [sort] : [], where });
    if (!q.trim()) return r;
    const needle = q.toLowerCase();
    const rows = r.rows.filter((row) => Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(needle)));
    return { ...r, rows, total: rows.length };
  }, [ds, sort, q]);
  const facts = shape.facts;
  const notes = useMemo(() => highlights(ds), [ds]);

  const toggleSort = (k: string) => setSort((s) => (s?.column !== k ? { column: k, dir: "asc" } : s.dir === "asc" ? { column: k, dir: "desc" } : null));
  const exportAs = (f: Format, saveAs = false) =>
    exportAndNotify(name, req, res, f, { dataset: ds.id, saveAs, query: { columns: cols.map((c) => c.key), sort: sort ? [sort] : undefined } });

  return (
    <div className="dataview">
      <div className="data-bar">
        <select className="select" value={ds.id} onChange={(e) => (setDsId(e.target.value), setShown(PAGE), setSort(null))} style={{ height: 26, fontSize: 12, maxWidth: 260 }}>
          {shape.datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} · {d.rows.length.toLocaleString()} rows
            </option>
          ))}
        </select>
        <input className="input" placeholder="Search rows" value={q} onChange={(e) => (setQ(e.target.value), setShown(PAGE))} style={{ height: 26, fontSize: 12, width: 160 }} />
        <span className="muted" style={{ fontSize: 12 }}>
          {result.total.toLocaleString()} rows · {cols.length}/{ds.columns.length} columns
        </span>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, kind: "columns" })}>
          <Columns3 size={13} /> Columns
        </button>
        <button className="btn ghost sm" title="Chat about this data" onClick={() => askAbout(`Look at the ${ds.label} data in the response of the open request and tell me what stands out.`)}>
          <MessageSquare size={13} /> Ask
        </button>
        <button className="btn sm" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, kind: "export" })}>
          <Download size={13} /> Export
        </button>
      </div>
      {(facts.length > 0 || notes.length > 1) && (
        <div className="data-notes">
          {facts.slice(0, 6).map(([k, v]) => (
            <span key={k} className="fact">
              <span className="muted">{k}</span> <b>{cell(v, 30)}</b>
            </span>
          ))}
          {notes.slice(1, 4).map((n) => (
            <span key={n} className="muted note">
              {n}
            </span>
          ))}
        </div>
      )}
      <div className="data-scroll">
        <table className="data">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {cols.map((c) => (
                <th key={c.key} onClick={() => toggleSort(c.key)} title={`${c.key} · ${c.type} · ${c.filled}/${ds.rows.length} filled`} className={c.numeric ? "num" : ""}>
                  {c.label}
                  {sort?.column === c.key && (sort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.slice(0, shown).map((r, i) => (
              <tr key={i}>
                <td className="rownum">{i + 1}</td>
                {cols.map((c) => (
                  <td key={c.key} className={c.numeric ? "num" : c.type === "boolean" ? "bool" : ""} title={String(ds.rows.length < 5000 ? (r[c.key] ?? "") : "")}>
                    {c.type === "url" && r[c.key] ? <span className="link">{cell(r[c.key], 60)}</span> : cell(r[c.key], 80)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.total > shown && (
          <div className="pad" style={{ textAlign: "center" }}>
            <button className="btn sm" onClick={() => setShown((s) => s + PAGE * 5)}>
              Show more ({(result.total - shown).toLocaleString()} left)
            </button>
          </div>
        )}
      </div>
      {menu?.kind === "export" && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...FORMATS.map((f) => ({ label: `${f.label}  →  reports/`, onClick: () => exportAs(f.id) })),
            "-" as const,
            ...FORMATS.map((f) => ({ label: `${f.label}  ·  Save as…`, onClick: () => exportAs(f.id, true) })),
          ]}
        />
      )}
      {menu?.kind === "columns" && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Show all", onClick: () => setHidden((h) => ({ ...h, [ds.id]: new Set() })) },
            { label: "Best 8 columns", onClick: () => setHidden((h) => ({ ...h, [ds.id]: new Set(ds.columns.map((c) => c.key).filter((k) => !pickColumns(ds, 8).includes(k))) })) },
            "-" as const,
            ...ds.columns.map((c) => ({
              label: `${hide.has(c.key) ? "   " : "✓ "} ${c.label}`,
              keepOpen: true,
              onClick: () =>
                setHidden((h) => {
                  const n = new Set(hide);
                  n.has(c.key) ? n.delete(c.key) : n.add(c.key);
                  return { ...h, [ds.id]: n };
                }),
            })),
          ]}
        />
      )}
    </div>
  );
}
