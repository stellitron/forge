import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { oneDark } from "@codemirror/theme-one-dark";
import { X, Trash2 } from "lucide-react";
import type { KV } from "../lib/types";
import { useDarkTheme } from "../lib/theme";
import VarInput from "./VarInput";

export type Lang = "json" | "graphql" | "xml" | "html" | "text" | "js";

/** Follows Forge's theme setting (System / Light / Dark), not just the OS. */
export const useDark = useDarkTheme;

export function Editor({
  value,
  onChange,
  lang = "json",
  readOnly,
  placeholder,
  wrap = true,
}: {
  value: string;
  onChange?: (v: string) => void;
  lang?: Lang;
  readOnly?: boolean;
  placeholder?: string;
  wrap?: boolean;
}) {
  const dark = useDark();
  const extensions = useMemo(() => {
    const ext = [];
    if (lang === "json") ext.push(json());
    if (lang === "js" || lang === "graphql") ext.push(javascript());
    if (lang === "html") ext.push(html());
    if (lang === "xml") ext.push(xml());
    if (wrap) ext.push(EditorView.lineWrapping);
    return ext;
  }, [lang, wrap]);
  return (
    <div className="editor">
      <CodeMirror
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        editable={!readOnly}
        extensions={extensions}
        theme={dark ? oneDark : "light"}
        placeholder={placeholder}
        height="100%"
        basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, autocompletion: !readOnly }}
      />
    </div>
  );
}

export interface AutoRow {
  key: string;
  value: string;
  /** Why it's there, e.g. "from the Auth tab". */
  note: string;
}

/** Text form used by bulk edit: one `key: value` per line, `//` to disable. */
export function toBulk(rows: KV[]): string {
  return rows.map((r) => `${r.enabled ? "" : "// "}${r.key}: ${r.value}`).join("\n");
}

/** Accepts `key: value`, `key=value` and `a=1&b=2` lines (pasted headers or query strings). */
export function fromBulk(text: string): KV[] {
  const out: KV[] = [];
  for (let line of text.split(/\r?\n/)) {
    let enabled = true;
    if (/^\s*\/\//.test(line)) {
      enabled = false;
      line = line.replace(/^\s*\/\/\s?/, "");
    }
    if (!line.trim()) continue;
    const pairs = !line.includes(":") && line.includes("&") ? line.split("&") : [line];
    for (const pair of pairs) {
      const c = pair.indexOf(":");
      const e = pair.indexOf("=");
      const at = c < 0 ? e : e < 0 ? c : Math.min(c, e);
      const key = (at < 0 ? pair : pair.slice(0, at)).trim();
      if (key) out.push({ key, value: at < 0 ? "" : pair.slice(at + 1).trim(), enabled });
    }
  }
  return out;
}

/**
 * Editable key/value rows: an empty row at the end for quick entry, {{variable}} highlighting,
 * optional autocomplete, read-only "auto" rows showing what Forge adds, and a bulk text mode.
 */
export function KvTable({
  rows,
  onChange,
  keyPh = "Key",
  valuePh = "Value",
  extra,
  keyOptions,
  valueOptions,
  auto,
  toolbar,
  empty,
  bulk = true,
  fixedKeys = false,
}: {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPh?: string;
  valuePh?: string;
  extra?: (row: KV, i: number, set: (r: Partial<KV>) => void) => ReactNode;
  keyOptions?: string[];
  valueOptions?: (key: string) => string[] | undefined;
  auto?: AutoRow[];
  /** Shown on the left of the table's toolbar (quick-add chips, suggestions…). */
  toolbar?: ReactNode;
  /** Shown under the table while there are no rows. */
  empty?: ReactNode;
  bulk?: boolean;
  /** Keys come from elsewhere (e.g. :name in the URL): no adding, renaming or removing rows. */
  fixedKeys?: boolean;
}) {
  const [bulkText, setBulkText] = useState<string | null>(null);
  const id = useId();
  const shown = fixedKeys ? rows : [...rows, { key: "", value: "", enabled: true }];
  const set = (i: number, patch: Partial<KV>) => {
    const next = [...rows];
    if (i === rows.length) next.push({ key: "", value: "", enabled: true, ...patch });
    else next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const on = rows.filter((r) => r.enabled && r.key).length;
  const allOn = rows.length > 0 && rows.every((r) => r.enabled);
  return (
    <div className="kvwrap">
      {(bulk || toolbar || rows.length > 0) && (
        <div className="kv-bar">
          <div className="kv-tools">{toolbar}</div>
          {rows.length > 0 && bulkText === null && (
            <span className="muted">
              {on} of {rows.length} on
            </span>
          )}
          {bulk && (
            <button className="btn ghost sm" onClick={() => setBulkText(bulkText === null ? toBulk(rows) : null)} title="Edit as text: one key: value per line, // to turn a row off">
              {bulkText === null ? "Bulk edit" : "Table"}
            </button>
          )}
        </div>
      )}
      {bulkText !== null ? (
        <textarea
          className="kv-bulk"
          value={bulkText}
          autoFocus
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          spellCheck={false}
          placeholder={`${keyPh}: ${valuePh.toLowerCase()}\n// disabled-${keyPh.toLowerCase()}: value\nor paste a=1&b=2`}
          onChange={(e) => {
            setBulkText(e.target.value);
            onChange(fromBulk(e.target.value));
          }}
        />
      ) : (
        <table className="kv">
          <thead>
            <tr>
              <th>{rows.length > 0 && <input type="checkbox" checked={allOn} title={allOn ? "Turn all off" : "Turn all on"} onChange={() => onChange(rows.map((r) => ({ ...r, enabled: !allOn })))} />}</th>
              <th>{keyPh}</th>
              <th>{valuePh}</th>
              {extra && <th />}
              <th />
            </tr>
          </thead>
          <tbody>
            {auto?.map((a) => (
              <tr key={`auto-${a.key}`} className="auto" title={`Added by Forge ${a.note}. Add your own ${a.key} row to override it.`}>
                <td>
                  <span className="auto-tag">auto</span>
                </td>
                <td className="mono">{a.key}</td>
                <td className="mono">
                  {a.value} <span className="muted">· {a.note}</span>
                </td>
                {extra && <td />}
                <td />
              </tr>
            ))}
            {shown.map((r, i) => {
              const ghost = i === rows.length;
              const vals = valueOptions?.(r.key);
              return (
                <tr key={i} className={`${r.enabled ? "" : "off"} ${ghost ? "ghost" : ""}`}>
                  <td>{!ghost && <input type="checkbox" checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />}</td>
                  <td>
                    <VarInput value={r.key} readOnly={fixedKeys} placeholder={ghost ? `Add ${keyPh.toLowerCase()}` : keyPh} list={keyOptions ? `${id}k` : undefined} onChange={(e) => set(i, { key: e.target.value })} />
                  </td>
                  <td>
                    <VarInput value={r.value} placeholder={valuePh} list={vals?.length ? `${id}v${i}` : undefined} onChange={(e) => set(i, { value: e.target.value })} />
                    {!!vals?.length && (
                      <datalist id={`${id}v${i}`}>
                        {vals.map((v) => (
                          <option key={v} value={v} />
                        ))}
                      </datalist>
                    )}
                  </td>
                  {extra && <td style={{ width: 70 }}>{!ghost && extra(r, i, (p) => set(i, p))}</td>}
                  <td className="del">
                    {!ghost && !fixedKeys && (
                      <button className="btn ghost icon sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Remove">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {keyOptions && (
        <datalist id={`${id}k`}>
          {keyOptions.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      )}
      {rows.length === 0 && bulkText === null && empty}
    </div>
  );
}

export function Seg<T extends string>({
  value,
  onChange,
  options,
  right,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: ReactNode; count?: number }[];
  right?: ReactNode;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
          {!!o.count && <span className="count">{o.count}</span>}
        </button>
      ))}
      {right && (
        <>
          <div className="spacer" />
          <div className="row">{right}</div>
        </>
      )}
    </div>
  );
}

/** Two resizable panes. The split ratio persists per `id`. */
export function Split({ a, b, dir = "h", id, min = 20 }: { a: ReactNode; b: ReactNode; dir?: "h" | "v"; id: string; min?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(() => Number(safeGet(`split:${id}`)) || 50);
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const p = dir === "h" ? ((e.clientX - r.left) / r.width) * 100 : ((e.clientY - r.top) / r.height) * 100;
      setPct(Math.min(100 - min, Math.max(min, p)));
    };
    const up = () => setDrag(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, dir, min]);
  useEffect(() => {
    if (!drag) safeSet(`split:${id}`, String(pct));
  }, [drag, pct, id]);
  return (
    <div ref={ref} className={`split ${dir}`} style={{ ["--split" as string]: `${pct}%`, cursor: drag ? (dir === "h" ? "col-resize" : "row-resize") : undefined }}>
      <div className="pane">{a}</div>
      <div className={`gutter ${drag ? "drag" : ""}`} onMouseDown={(e) => (e.preventDefault(), setDrag(true))} />
      <div className="pane">{b}</div>
    </div>
  );
}

export function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}

export function Modal({ title, onClose, children, width }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 92vw)` } : undefined}>
        <div className="modal-head">
          <h2 className="grow">{title}</h2>
          <button className="btn ghost icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** Toggle-style items leave the menu open. */
  keepOpen?: boolean;
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | "-")[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [x, y, onClose]);
  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it === "-" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? "err" : ""}
            onClick={() => {
              if (!it.keepOpen) onClose();
              it.onClick();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export function statusClass(status: number) {
  return `pill s${Math.floor(status / 100)}`;
}

export function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** Builds a starter JSON value from a JSON Schema (used for MCP tool args and A2A payloads). */
export function skeleton(schema: any, depth = 0): unknown {
  if (!schema || depth > 5) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries<any>(schema.properties ?? {})) out[k] = skeleton(v, depth + 1);
      return out;
    }
    case "array":
      return [];
    case "string":
      return "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return schema.properties ? skeleton({ ...schema, type: "object" }, depth) : null;
  }
}
