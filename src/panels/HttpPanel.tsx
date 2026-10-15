import { useCallback, useEffect, useMemo, useState } from "react";
import { Code2, FolderOpen, Copy, Loader2, Plus, Send, Sparkles, Square, Trash2 } from "lucide-react";
import { writeText } from "../lib/clipboard";
import { formatBytes, prettyBody, runAssertions, runExtractions } from "../lib/eval";
import { http, uid } from "../lib/ipc";
import { sendItem } from "../lib/sendItem";
import { importCurl } from "../lib/importers";
import { suggestAssertions } from "../lib/suggest";
import CodeModal from "../components/CodeModal";
import DataView, { useShape } from "../components/DataView";
import { PaneLayoutToggle, usePaneDir } from "../components/PaneLayout";
import VarInput from "../components/VarInput";
import AuthEditor, { AUTH_SHORT } from "../components/AuthEditor";
import { mdToHtml } from "../lib/apiDocs";
import SuggestButton from "../components/SuggestButton";
import { COMMON_HEADERS, QUICK_HEADERS, autoHeaders, headerValues } from "../lib/httpKnowledge";
import { composeUrl, displayUrl, hasLiteralPlus, paramsFromUrl, pathVarNames, syncPathVars } from "../lib/urlParams";
import { useStore } from "../lib/store";
import type { AssertOp, AssertSource, Assertion, BodyMode, ClientCert, Extraction, HttpItem, Item, KV } from "../lib/types";
import { Editor, KvTable, Seg, Split, statusClass, type Lang } from "../components/ui";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
type ReqTab = "params" | "headers" | "auth" | "body" | "tests" | "docs" | "settings";
type ResTab = "body" | "data" | "headers" | "tests" | "raw";

/** Sends the item, runs assertions/extractions, and records the result in the store. */
export async function runHttp(item: Item & HttpItem, source = "request") {
  const s = useStore.getState();
  const requestId = uid();
  s.setResponse(item.path, { loading: true, requestId });
  try {
    // A person pressing Send can complete a browser sign-in; runs started by tools or the runner can't.
    const { res } = await sendItem(item, requestId, source, { interactive: source === "request" });
    const results = runAssertions(item.assertions, res, useStore.getState().vars());
    const extracted = runExtractions(item.extractions, res);
    s.setVars(extracted);
    s.setResponse(item.path, { res, results, extracted });
    return { res, results };
  } catch (e) {
    s.setResponse(item.path, { error: String(e) });
    return { error: String(e) };
  }
}

export default function HttpPanel({ item }: { item: Item & HttpItem }) {
  const update = useStore((s) => s.updateItem);
  const resp = useStore((s) => s.responses[item.path]);
  const [tab, setTab] = useState<ReqTab>(item.bodyMode !== "none" ? "body" : "params");
  const set = useCallback((patch: Partial<HttpItem>) => update(item.path, patch), [item.path, update]);
  const paneDir = usePaneDir();

  const send = useCallback(() => {
    if (resp?.loading && resp.requestId) http.cancel(resp.requestId);
    else runHttp(item);
  }, [item, resp]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [send]);

  /** The URL bar and the Params table stay in sync (see urlParams.ts). */
  const onUrl = (url: string) => set({ url, params: paramsFromUrl(url, item.params), pathVars: syncPathVars(url, item.pathVars) });
  const onParams = (params: KV[]) => set({ params, url: composeUrl(displayUrl(item.url, item.params), params) });

  /** Pasting a whole `curl …` command replaces the request with its parsed contents. */
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/^\s*curl\s/.test(text)) return;
    e.preventDefault();
    try {
      const parsed = importCurl(text.trim());
      set({ ...parsed, assertions: item.assertions, extractions: item.extractions });
      useStore.getState().notify(`Imported cURL: ${parsed.method} with ${parsed.headers.length} headers`);
    } catch (err) {
      useStore.getState().notify(`Could not parse cURL: ${(err as Error).message}`, "error");
    }
  };

  const [showCode, setShowCode] = useState(false);

  const isGql = item.bodyMode === "graphql";
  return (
    <div className="panel">
      <div className="urlbar">
        <div className="group">
          <select value={item.method} onChange={(e) => set({ method: e.target.value })} className={`m-${item.method}`}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <VarInput
            value={displayUrl(item.url, item.params)}
            onChange={(e) => onUrl(e.target.value)}
            onPaste={onPaste}
            placeholder={isGql ? "https://api.example.com/graphql" : "{{baseUrl}}/users  ·  paste a cURL command  ·  ⌘↵ to send"}
            spellCheck={false}
            autoFocus={!item.url}
          />
        </div>
        <button className="btn ghost" title="Generate code" onClick={() => setShowCode(true)}>
          <Code2 size={15} /> Code
        </button>
        <button className="btn primary" onClick={send} style={{ width: 92, justifyContent: "center" }}>
          {resp?.loading ? (
            <>
              <Square size={13} /> Cancel
            </>
          ) : (
            <>
              <Send size={14} /> Send
            </>
          )}
        </button>
      </div>
      <Split
        id={`http-${paneDir}`}
        dir={paneDir}
        a={
          <>
            <Seg
              value={tab}
              onChange={setTab}
              options={[
                { id: "params", label: "Params", count: item.params.filter((p) => p.enabled).length },
                { id: "headers", label: "Headers", count: item.headers.filter((p) => p.enabled).length },
                { id: "auth", label: item.auth.type === "none" ? "Auth" : <>Auth <span className="tab-note">{AUTH_SHORT[item.auth.type]}</span></> },
                { id: "body", label: isGql ? "GraphQL" : item.bodyMode === "none" ? "Body" : <>Body <span className="tab-note">{BODY_MODES.find((m) => m.id === item.bodyMode)?.short}</span></> },
                { id: "tests", label: "Tests", count: item.assertions.length + item.extractions.length },
                { id: "docs", label: item.description?.trim() ? <>Docs <span className="tab-note">✓</span></> : "Docs" },
                { id: "settings", label: "Settings" },
              ]}
            />
            <div className="scroll grow" style={{ display: "flex", flexDirection: "column" }}>
              {tab === "params" && <ParamsEditor item={item} onParams={onParams} set={set} />}
              {tab === "headers" && <HeadersEditor item={item} set={set} />}
              {tab === "auth" && <AuthEditor auth={item.auth} onChange={(auth) => set({ auth })} />}
              {tab === "body" && <BodyEditor item={item} set={set} />}
              {tab === "tests" && <TestsEditor item={item} set={set} />}
              {tab === "docs" && <DocsEditor item={item} set={set} />}
              {tab === "settings" && <SettingsEditor item={item} set={set} />}
            </div>
          </>
        }
        b={<ResponseView path={item.path} />}
      />
      {showCode && <CodeModal item={item} onClose={() => setShowCode(false)} />}
    </div>
  );
}

const BODY_MODES: { id: BodyMode; label: string; short: string }[] = [
  { id: "none", label: "None", short: "" },
  { id: "json", label: "JSON", short: "JSON" },
  { id: "text", label: "Text", short: "Text" },
  { id: "xml", label: "XML", short: "XML" },
  { id: "form", label: "Form URL-encoded", short: "Form" },
  { id: "multipart", label: "Multipart", short: "Multipart" },
  { id: "graphql", label: "GraphQL", short: "GraphQL" },
  { id: "binary", label: "File", short: "File" },
];

function ParamsEditor({ item, onParams, set }: { item: HttpItem; onParams: (p: KV[]) => void; set: (p: Partial<HttpItem>) => void }) {
  const names = pathVarNames(item.url);
  const pathVars = syncPathVars(item.url, item.pathVars);
  const plus = item.params.filter((p) => p.enabled && hasLiteralPlus(p.value));
  return (
    <>
      {plus.length > 0 && (
        <div className="kv-hint">
          <span>
            <b className="mono">+</b> in {plus.map((p) => p.key).join(", ")} is read as a space by most servers.
          </span>
          <button className="btn sm" onClick={() => onParams(item.params.map((p) => (plus.includes(p) ? { ...p, value: p.value.replace(/\+(?![^{]*\}\})/g, "%2B") } : p)))}>
            Send a literal + (%2B)
          </button>
        </div>
      )}
      <KvTable
        rows={item.params}
        onChange={onParams}
        toolbar={<SuggestButton item={item} kind="params" onAdd={(rows) => onParams([...item.params, ...rows])} />}
        empty={
          <p className="kv-empty">
            Type <code>?page=1&amp;limit=20</code> in the URL or add rows above. Both stay in sync. Use <code>/:id</code> in the path for path variables.
          </p>
        }
      />
      {names.length > 0 && (
        <>
          <div className="kv-bar" style={{ marginTop: 10 }}>
            <b style={{ fontSize: 12 }}>Path variables</b>
            <span className="muted">from :name segments in the URL</span>
          </div>
          <KvTable
            rows={pathVars}
            bulk={false}
            fixedKeys
            keyPh="Variable"
            valuePh="Value, e.g. 42 or {{userId}}"
            onChange={(rows) => set({ pathVars: rows.filter((r) => names.includes(r.key)) })}
          />
        </>
      )}
    </>
  );
}

function HeadersEditor({ item, set }: { item: HttpItem; set: (p: Partial<HttpItem>) => void }) {
  const present = new Set(item.headers.map((h) => h.key.trim().toLowerCase()));
  const quick = QUICK_HEADERS.filter(([k]) => !present.has(k.toLowerCase()));
  const add = (rows: KV[]) => set({ headers: [...item.headers, ...rows] });
  return (
    <KvTable
      rows={item.headers}
      onChange={(headers) => set({ headers })}
      keyPh="Header"
      keyOptions={COMMON_HEADERS}
      valueOptions={headerValues}
      auto={autoHeaders(item)}
      toolbar={
        <>
          <SuggestButton item={item} kind="headers" onAdd={add} />
          {quick.slice(0, 3).map(([k, v]) => (
            <button key={k} className="chip-add" title={`Add ${k}: ${v}`} onClick={() => add([{ key: k, value: v, enabled: true }])}>
              + {k}
            </button>
          ))}
        </>
      }
    />
  );
}

function BodyEditor({ item, set }: { item: HttpItem; set: (p: Partial<HttpItem>) => void }) {
  const lang: Lang = item.bodyMode === "json" ? "json" : item.bodyMode === "xml" ? "xml" : "text";
  const format = () => {
    try {
      set({ body: JSON.stringify(JSON.parse(item.body), null, 2) });
    } catch (e) {
      useStore.getState().notify(`Invalid JSON: ${(e as Error).message}`, "error");
    }
  };
  return (
    <>
      <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
        <select className="select" value={item.bodyMode} onChange={(e) => set({ bodyMode: e.target.value as BodyMode })}>
          {BODY_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {item.bodyMode === "json" && (
          <button className="btn sm" onClick={format}>
            Beautify
          </button>
        )}
      </div>
      {item.bodyMode === "none" && <div className="empty">This request has no body.</div>}
      {(item.bodyMode === "json" || item.bodyMode === "text" || item.bodyMode === "xml") && (
        <Editor value={item.body} onChange={(body) => set({ body })} lang={lang} placeholder={item.bodyMode === "json" ? '{\n  "name": "{{$randomEmail}}"\n}' : ""} />
      )}
      {item.bodyMode === "form" && <KvTable rows={item.form} onChange={(form) => set({ form })} />}
      {item.bodyMode === "multipart" && (
        <KvTable
          rows={item.multipart}
          onChange={(multipart) => set({ multipart })}
          valuePh="Value or file path"
          extra={(r, _i, s) => (
            <label className="check" style={{ fontSize: 11 }}>
              <input type="checkbox" checked={!!(r as KV & { file?: boolean }).file} onChange={(e) => s({ file: e.target.checked } as Partial<KV>)} />
              file
            </label>
          )}
        />
      )}
      {item.bodyMode === "binary" && (
        <div className="pad">
          <label className="field">
            File path
            <input className="input mono" value={item.body} onChange={(e) => set({ body: e.target.value })} placeholder="/Users/me/upload.bin" />
          </label>
        </div>
      )}
      {item.bodyMode === "graphql" && (
        <Split
          id="gql"
          dir="v"
          a={<Editor value={item.graphql.query} onChange={(query) => set({ graphql: { ...item.graphql, query } })} lang="graphql" placeholder="query { viewer { id name } }" />}
          b={
            <>
              <div className="row" style={{ padding: "6px 12px" }}>
                <h3>Variables</h3>
              </div>
              <Editor value={item.graphql.variables} onChange={(variables) => set({ graphql: { ...item.graphql, variables } })} />
            </>
          }
        />
      )}
    </>
  );
}

const SOURCES: AssertSource[] = ["status", "jsonpath", "header", "body", "time", "size"];
const OPS: { id: AssertOp; label: string }[] = [
  { id: "eq", label: "equals" },
  { id: "neq", label: "not equals" },
  { id: "contains", label: "contains" },
  { id: "notContains", label: "not contains" },
  { id: "gt", label: ">" },
  { id: "lt", label: "<" },
  { id: "exists", label: "exists" },
  { id: "notExists", label: "not exists" },
  { id: "matches", label: "matches regex" },
];

function TestsEditor({ item, set }: { item: Item & HttpItem; set: (p: Partial<HttpItem>) => void }) {
  const last = useStore((s) => s.responses[item.path]?.res);
  const suggest = () => {
    const add = suggestAssertions(last!, item.assertions);
    set({ assertions: [...item.assertions, ...add] });
    useStore.getState().notify(add.length ? `Added ${add.length} assertions from the last response` : "No new assertions to add");
  };
  const upd = (i: number, p: Partial<Assertion>) => set({ assertions: item.assertions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  const updX = (i: number, p: Partial<Extraction>) => set({ extractions: item.extractions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  return (
    <div className="pad col">
      <div className="row">
        <h3 className="grow">Assertions</h3>
        <button className="btn sm" disabled={!last} title={last ? "Generate assertions from the last response" : "Send the request first"} onClick={suggest}>
          <Sparkles size={13} /> Suggest from response
        </button>
        <button className="btn sm" onClick={() => set({ assertions: [...item.assertions, { enabled: true, source: "status", path: "", op: "eq", value: "200" }] })}>
          <Plus size={13} /> Add
        </button>
      </div>
      {!item.assertions.length && <div className="muted">No assertions yet. They run on every send and in the collection runner.</div>}
      {item.assertions.map((a, i) => (
        <div className="row" key={i}>
          <input type="checkbox" checked={a.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} />
          <select className="select" value={a.source} onChange={(e) => upd(i, { source: e.target.value as AssertSource })}>
            {SOURCES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          {(a.source === "jsonpath" || a.source === "header") && (
            <input className="input mono grow" value={a.path} placeholder={a.source === "jsonpath" ? "$.data[0].id" : "content-type"} onChange={(e) => upd(i, { path: e.target.value })} />
          )}
          <select className="select" value={a.op} onChange={(e) => upd(i, { op: e.target.value as AssertOp })}>
            {OPS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          {a.op !== "exists" && a.op !== "notExists" && <input className="input mono grow" value={a.value} onChange={(e) => upd(i, { value: e.target.value })} />}
          <button className="btn ghost icon sm" onClick={() => set({ assertions: item.assertions.filter((_, j) => j !== i) })}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <h3 className="grow">Save to environment (local secrets)</h3>
        <button className="btn sm" onClick={() => set({ extractions: [...item.extractions, { enabled: true, variable: "token", source: "jsonpath", path: "$.token" }] })}>
          <Plus size={13} /> Add
        </button>
      </div>
      {!item.extractions.length && <div className="muted">Capture values (e.g. an auth token) for later requests. They're stored in the active environment's gitignored secrets file, never in committed files.</div>}
      {item.extractions.map((x, i) => (
        <div className="row" key={i}>
          <input type="checkbox" checked={x.enabled} onChange={(e) => updX(i, { enabled: e.target.checked })} />
          <input className="input mono" style={{ width: 140 }} value={x.variable} placeholder="variable" onChange={(e) => updX(i, { variable: e.target.value })} />
          <span className="muted">←</span>
          <select className="select" value={x.source} onChange={(e) => updX(i, { source: e.target.value as Extraction["source"] })}>
            <option value="jsonpath">jsonpath</option>
            <option value="header">header</option>
          </select>
          <input className="input mono grow" value={x.path} onChange={(e) => updX(i, { path: e.target.value })} />
          <button className="btn ghost icon sm" onClick={() => set({ extractions: item.extractions.filter((_, j) => j !== i) })}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The request's description for generated API docs. Rendered with the same safe Markdown as the docs. */
function DocsEditor({ item, set }: { item: HttpItem; set: (p: Partial<HttpItem>) => void }) {
  const [view, setView] = useState<"write" | "preview">(item.description?.trim() ? "preview" : "write");
  const text = item.description ?? "";
  return (
    <div className="docs-tab">
      <div className="row" style={{ gap: 8 }}>
        <Seg value={view} onChange={setView} options={[{ id: "write", label: "Write" }, { id: "preview", label: "Preview" }]} />
        <span className="muted grow" style={{ fontSize: 12 }}>
          Shown in docs generated from the collection (right-click it, Generate docs). Markdown: **bold**, `code`, lists, links.
        </span>
      </div>
      {view === "write" ? (
        <textarea
          className="textarea"
          value={text}
          autoFocus={!text}
          onChange={(e) => set({ description: e.target.value })}
          placeholder={"What this endpoint does, when to call it, and anything a caller should know.\n\nFor example: Returns the signed-in user's orders, newest first. Use `page` and `limit` to paginate."}
        />
      ) : text.trim() ? (
        <div className="docs-preview" dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />
      ) : (
        <p className="muted" style={{ margin: 0 }}>No description yet.</p>
      )}
    </div>
  );
}

function SettingsEditor({ item, set }: { item: HttpItem; set: (p: Partial<HttpItem>) => void }) {
  const s = item.settings;
  const upd = (p: Partial<HttpItem["settings"]>) => set({ settings: { ...s, ...p } });
  return (
    <div className="pad col" style={{ maxWidth: 420 }}>
      <label className="field">
        Timeout (ms, 0 = none)
        <input className="input mono" type="number" value={s.timeoutMs} onChange={(e) => upd({ timeoutMs: Number(e.target.value) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={s.followRedirects} onChange={(e) => upd({ followRedirects: e.target.checked })} /> Follow redirects
      </label>
      <label className="check">
        <input type="checkbox" checked={s.insecure} onChange={(e) => upd({ insecure: e.target.checked })} /> Skip TLS certificate verification
      </label>
      <ClientCertFields value={s.clientCert} onChange={(clientCert) => upd({ clientCert })} />
    </div>
  );
}

/** Mutual TLS: PEM files the server asks for during the handshake. Works with any auth type. */
function ClientCertFields({ value, onChange }: { value?: ClientCert; onChange: (c: ClientCert | undefined) => void }) {
  const c = value ?? { cert: "", key: "", ca: "" };
  const set = (p: Partial<ClientCert>) => {
    const next = { ...c, ...p };
    onChange(next.cert || next.key || next.ca ? next : undefined);
  };
  const pick = async (field: keyof ClientCert, title: string) => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const f = await open({ title, filters: [{ name: "PEM", extensions: ["pem", "crt", "cer", "key"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof f === "string") set({ [field]: f });
  };
  const row = (field: keyof ClientCert, label: string, placeholder: string) => (
    <label className="field">
      {label}
      <div className="row" style={{ gap: 6 }}>
        <VarInput className="input-like grow" value={c[field]} onChange={(e) => set({ [field]: e.target.value })} placeholder={placeholder} />
        <button className="btn sm" onClick={(e) => (e.preventDefault(), pick(field, label))} title="Choose file">
          <FolderOpen size={13} />
        </button>
      </div>
    </label>
  );
  return (
    <div className="col" style={{ gap: 10, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <div>
        <b style={{ fontSize: 13 }}>Client certificate</b>
        <div className="muted field-hint">For servers that require mutual TLS. Paths stay on this computer; use {"{{variables}}"} so teammates can point at their own files.</div>
      </div>
      {row("cert", "Certificate (PEM)", "~/certs/client.crt or {{clientCert}}")}
      {row("key", "Private key (PEM, unencrypted)", "~/certs/client.key or {{clientKey}}")}
      {row("ca", "CA certificate (optional)", "for servers signed by a private CA")}
      <div className="muted field-hint">Have a .p12 or .pfx? Convert it with: openssl pkcs12 -in client.p12 -out client.pem -nodes</div>
    </div>
  );
}

export function ResponseView({ path }: { path: string }) {
  const r = useStore((s) => s.responses[path]);
  const item = useStore((s) => s.items[path]) as (Item & HttpItem) | undefined;
  const shape = useShape(r?.res);
  const [tab, setTab] = useState<ResTab>("body");
  const [view, setView] = useState<"pretty" | "raw" | "preview">("pretty");
  const ctype = r?.res?.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
  const pretty = useMemo(() => (r?.res && !r.res.bodyBase64 ? prettyBody(r.res.body, ctype) : ""), [r?.res, ctype]);

  if (!r) return <div className="empty">Send a request to see the response here.</div>;
  if (r.loading)
    return (
      <div className="empty">
        <Loader2 className="spin" size={22} />
        Sending…
      </div>
    );
  if (r.error)
    return (
      <div className="pad col">
        <div className="row">
          <span className="pill s0">Error</span>
        </div>
        <pre className="block err">{r.error}</pre>
      </div>
    );
  const res = r.res!;
  const lang: Lang = /json/.test(ctype) ? "json" : /html/.test(ctype) ? "html" : /xml/.test(ctype) ? "xml" : /javascript/.test(ctype) ? "js" : "text";
  const passed = r.results?.filter((x) => x.pass).length ?? 0;
  return (
    <>
      <div className="status">
        <span className={statusClass(res.status)}>
          {res.status} {res.statusText}
        </span>
        <span className="stat" title={`Time to first byte ${res.ttfbMs.toFixed(0)} ms`}>
          <b>{res.timeMs < 1000 ? `${res.timeMs.toFixed(0)} ms` : `${(res.timeMs / 1000).toFixed(2)} s`}</b>
        </span>
        <span className="stat">
          <b>{formatBytes(res.size)}</b>
        </span>
        <span className="stat muted">{res.httpVersion}</span>
        {!!r.results?.length && <span className={passed === r.results.length ? "ok" : "err"}>{`${passed}/${r.results.length} tests`}</span>}
        <div className="spacer" />
        <PaneLayoutToggle />
        <button className="btn ghost icon sm" title="Copy body" onClick={() => writeText(res.body).then(() => useStore.getState().notify("Copied"))}>
          <Copy size={13} />
        </button>
      </div>
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { id: "body", label: "Body" },
          ...(shape ? [{ id: "data" as ResTab, label: "Data", count: shape.datasets[0].rows.length }] : []),
          { id: "headers", label: "Headers", count: res.headers.length },
          { id: "tests", label: "Tests", count: r.results?.length },
        ]}
        right={
          tab === "body" && (
            <select className="select" style={{ height: 24, fontSize: 12 }} value={view} onChange={(e) => setView(e.target.value as typeof view)}>
              <option value="pretty">Pretty</option>
              <option value="raw">Raw</option>
              {/html/.test(ctype) && <option value="preview">Preview</option>}
            </select>
          )
        }
      />
      {tab === "body" &&
        (res.bodyBase64 ? (
          <div className="empty">
            Binary response ({formatBytes(res.size)}, {ctype || "unknown type"})
          </div>
        ) : view === "preview" ? (
          // No allow-scripts: previewed pages cannot run code inside Forge.
          <iframe sandbox="" srcDoc={res.body} style={{ flex: 1, border: "none", background: "white" }} title="preview" />
        ) : (
          <Editor value={view === "pretty" ? pretty : res.body} readOnly lang={view === "pretty" ? lang : "text"} />
        ))}
      {tab === "data" && shape && <DataView key={path} shape={shape} res={res} name={item?.name ?? "Response"} req={{ method: item?.method ?? "GET", url: item?.url ?? "" }} />}
      {tab === "data" && !shape && <div className="empty">This response has no JSON data to tabulate.</div>}
      {tab === "headers" && (
        <div className="scroll">
          <table className="kv selectable">
            <tbody>
              {res.headers.map((h, i) => (
                <tr key={i}>
                  <td className="mono dim" style={{ padding: "6px 12px", width: "35%" }}>
                    {h.key}
                  </td>
                  <td className="mono" style={{ padding: "6px 12px", wordBreak: "break-all" }}>
                    {h.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === "tests" && (
        <div className="scroll">
          {!r.results?.length && <div className="empty">No assertions on this request.</div>}
          {r.results?.map((t, i) => (
            <div className="result" key={i}>
              <span className={t.pass ? "ok" : "err"} style={{ fontWeight: 700, width: 36 }}>
                {t.pass ? "PASS" : "FAIL"}
              </span>
              <span className="mono grow">{t.label}</span>
              {!t.pass && <span className="mono muted">got {t.actual}</span>}
            </div>
          ))}
          {r.extracted && Object.keys(r.extracted).length > 0 && (
            <div className="pad muted">Saved to environment: {Object.keys(r.extracted).join(", ")}</div>
          )}
        </div>
      )}
    </>
  );
}
