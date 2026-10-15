import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { createSession } from "../agent/llm";
import { aiStatus, useStore } from "../lib/store";
import { openSettings } from "../lib/settingsNav";
import type { HttpItem, KV } from "../lib/types";
import { splitUrl, parseQuery } from "../lib/urlParams";

interface Suggestion {
  key: string;
  value: string;
  why: string;
  on: boolean;
}

/** Field names of the last response (never values), so the model can spot pagination, filters… */
function responseShape(path: string): string {
  const res = useStore.getState().responses[path]?.res;
  if (!res) return "";
  try {
    const j = JSON.parse(res.body);
    const o = Array.isArray(j) ? j[0] : j;
    return o && typeof o === "object" ? `Last response: HTTP ${res.status}, top-level fields: ${Object.keys(o).slice(0, 25).join(", ")}` : `Last response: HTTP ${res.status}`;
  } catch {
    return `Last response: HTTP ${res.status}`;
  }
}

/** What the model sees: structure only. Query values and header values are left out. */
export function suggestPrompt(item: HttpItem, kind: "params" | "headers", shape: string): string {
  const { base, query } = splitUrl(item.url);
  const queryKeys = parseQuery(query ?? "").map((p) => p.key);
  const have = (kind === "params" ? [...queryKeys, ...item.params.map((p) => p.key)] : item.headers.map((h) => h.key)).filter(Boolean);
  return [
    `Request: ${item.method} ${base}`,
    queryKeys.length ? `Query parameter names: ${queryKeys.join(", ")}` : "",
    `Body type: ${item.bodyMode}; auth: ${item.auth.type}`,
    shape,
    `Already present ${kind}: ${[...new Set(have)].join(", ") || "none"}`,
    "",
    kind === "params"
      ? "Suggest up to 6 useful query parameters this endpoint most likely supports (pagination, filtering, sorting, field selection, search)."
      : "Suggest up to 6 useful request headers for this request (content negotiation, caching, tracing, idempotency, conditional requests). Don't suggest Authorization or Content-Type; Forge sets those from the Auth and Body tabs.",
    'Reply with only a JSON array: [{"key": "...", "value": "example value", "why": "under 12 words"}]. Use {{variable}} placeholders for anything secret or user-specific. Don\'t repeat ones already present.',
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseSuggestions(text: string, existing: string[]): Suggestion[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const seen = new Set(existing.map((k) => k.toLowerCase()));
  const out: Suggestion[] = [];
  for (const x of Array.isArray(arr) ? arr : []) {
    const key = typeof x?.key === "string" ? x.key.trim() : "";
    if (!key || seen.has(key.toLowerCase()) || !/^[\w.\-[\]$]+$/.test(key)) continue;
    seen.add(key.toLowerCase());
    out.push({ key, value: String(x.value ?? ""), why: String(x.why ?? "").slice(0, 90), on: true });
  }
  return out.slice(0, 8);
}

/** AI-proposed rows the user ticks before anything is added. */
export default function SuggestButton({ item, kind, onAdd }: { item: HttpItem & { path?: string }; kind: "params" | "headers"; onAdd: (rows: KV[]) => void }) {
  const settings = useStore((s) => s.settings);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<Suggestion[] | null>(null);
  const [error, setError] = useState("");
  const ready = aiStatus(settings).ready;

  const run = async () => {
    if (!ready) return openSettings("ai");
    setBusy(true);
    setError("");
    try {
      const existing = kind === "params" ? item.params.map((x) => x.key) : item.headers.map((x) => x.key);
      const session = createSession(settings, "You are an HTTP API expert helping fill in a request in an API client.", [], suggestPrompt(item, kind, item.path ? responseShape(item.path) : ""));
      const s = parseSuggestions((await session.next()).text, existing);
      if (!s.length) setError("No new suggestions.");
      setList(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setList([]);
    } finally {
      setBusy(false);
    }
  };

  const chosen = list?.filter((s) => s.on) ?? [];
  return (
    <span className="suggest">
      <button className="btn ghost sm" onClick={run} disabled={busy} title={ready ? `Ask ${settings.agent.model} for likely ${kind}. Sends the method, URL path and names only, never values.` : "Set up an AI model in Settings to get suggestions"}>
        {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Suggest
      </button>
      {list !== null && (
        <div className="suggest-pop">
          {error && <div className="muted" style={{ padding: "4px 2px" }}>{error}</div>}
          {list.map((s, i) => (
            <label key={s.key} className="suggest-row">
              <input type="checkbox" checked={s.on} onChange={() => setList(list.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} />
              <span className="mono">
                {s.key}
                {s.value && <span className="muted">{kind === "params" ? "=" : ": "}{s.value}</span>}
              </span>
              <span className="muted why">{s.why}</span>
            </label>
          ))}
          <div className="row" style={{ justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
            <span className="muted" style={{ marginRight: "auto", fontSize: 11 }}>AI suggestions, check before use</span>
            <button className="btn sm" onClick={() => setList(null)}>
              Close
            </button>
            {chosen.length > 0 && (
              <button
                className="btn primary sm"
                onClick={() => {
                  onAdd(chosen.map((s) => ({ key: s.key, value: s.value, enabled: true })));
                  setList(null);
                }}
              >
                Add {chosen.length}
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
