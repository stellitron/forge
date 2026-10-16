import { useMemo, useState } from "react";
import { Copy, Loader2, Play, Square } from "lucide-react";
import { writeText } from "../lib/clipboard";
import { mockRoutes, parseOrigins, setMockOrigins, startMock, stopMock, useMocks } from "../lib/mock";
import { basename, COLLECTIONS, slug, useStore } from "../lib/store";
import { kv } from "../lib/types";
import { statusClass } from "../components/ui";

export const mockTab = (folder: string) => `::mock:${folder}`;

/** Points {{baseUrl}} at the mock through its own environment, so switching back is one click. */
async function pointBaseUrlAtMock(folder: string, url: string) {
  const st = useStore.getState();
  const name = `Mock · ${basename(folder) === COLLECTIONS ? "All" : basename(folder)}`;
  const existing = st.envs.find((e) => e.name === name);
  if (existing) await st.saveEnv({ ...existing, vars: [...existing.vars.filter((v) => v.key !== "baseUrl"), kv("baseUrl", url)] }, { trust: true });
  else await st.createEnv(name, [kv("baseUrl", url)]);
  st.setActiveEnv(existing?.path ?? `environments/${slug(name)}.json`);
  st.notify(`"${name}" is active: {{baseUrl}} now points at the mock`);
}

export default function MockPanel({ folder }: { folder: string }) {
  const items = useStore((s) => s.items);
  const url = useMocks((s) => s.running[folder]);
  const logs = useMocks((s) => s.logs[folder]) ?? [];
  const origins = useMocks((s) => s.origins[folder]);
  const [port, setPort] = useState(4010);
  const [busy, setBusy] = useState(false);
  const routes = useMemo(() => mockRoutes(Object.values(items), folder), [items, folder]);
  const withExamples = routes.filter((r) => r.examples.length).length;
  const usesBaseUrl = Object.values(items).some((i) => i.kind === "http" && i.path.startsWith(`${folder}/`) && i.url.trim().startsWith("{{baseUrl}}"));
  const label = basename(folder) === COLLECTIONS ? "all collections" : basename(folder);

  const start = async () => {
    setBusy(true);
    try {
      await startMock(folder, port);
    } catch (e) {
      useStore.getState().notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scroll">
      <div className="pad col">
        <div className="row">
          <h2 className="grow">Mock server · {label}</h2>
          {url ? (
            <button className="btn" onClick={() => stopMock(folder)}>
              <Square size={13} /> Stop
            </button>
          ) : (
            <>
              <label className="check">
                port
                <input className="input mono" style={{ width: 72 }} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 0)} />
              </label>
              <button className="btn primary" onClick={start} disabled={busy}>
                {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Start
              </button>
            </>
          )}
        </div>
        <div className="muted">
          Serves the saved examples of the {routes.length} request{routes.length === 1 ? "" : "s"} in {label} ({withExamples} with examples) on this computer, so a frontend can be built before the backend exists. It updates as you edit requests and examples.
        </div>
        {url && (
          <div className="card col">
            <div className="row">
              <span className="ok">●</span>
              <b className="mono selectable grow">{url}</b>
              <button className="btn ghost sm" onClick={() => writeText(url).then(() => useStore.getState().notify("Copied"))}>
                <Copy size={13} /> Copy
              </button>
              {usesBaseUrl && (
                <button className="btn sm" onClick={() => pointBaseUrlAtMock(folder, url)} title="Create or update a Mock environment with baseUrl set to this server, and switch to it">
                  Point {"{{baseUrl}}"} here
                </button>
              )}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Pick a response with <code>Prefer: example=Name</code> or <code>Prefer: code=404</code>, or add <code>?__example=Name</code> to the URL. Otherwise each request returns its first example. Browsers only get answers for pages served from localhost or the origins you allow below, because any website open in your browser runs on this computer too. Stop the mock when you're done.
            </div>
          </div>
        )}
        <label className="field">
          Also allow pages from
          <input
            className="input mono"
            defaultValue={(origins ?? []).join(", ")}
            onBlur={(e) => setMockOrigins(folder, parseOrigins(e.target.value))}
            placeholder="https://app.dev.test, https://staging.myapp.com"
            spellCheck={false}
          />
          <span className="muted field-hint">Pages on localhost, 127.0.0.1 and [::1] (any port) are always allowed. Add your own dev domains here; leave others out.</span>
        </label>
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "10px 14px" }}>
            <h3>Routes</h3>
          </div>
          {!routes.length && <div className="muted" style={{ padding: "0 14px 12px" }}>No HTTP requests in this folder.</div>}
          {routes.map((r, i) => (
            <div className="result" key={i}>
              <span className={`method m-${r.method}`} style={{ width: 52, flexShrink: 0 }}>
                {r.method}
              </span>
              <span className="mono grow" style={{ wordBreak: "break-all" }}>
                {r.path}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                {r.examples.length ? r.examples.map((e) => `${e.status} ${e.name}`).join(" · ") : "no examples: returns 501"}
              </span>
            </div>
          ))}
        </div>
        {url && (
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: "10px 14px" }}>
              <h3>Requests</h3>
            </div>
            {!logs.length && <div className="muted" style={{ padding: "0 14px 12px" }}>Calls to the mock show up here.</div>}
            {logs.map((l, i) => (
              <div className="result mono" key={i} style={{ fontSize: 12 }}>
                <span className="muted" style={{ flexShrink: 0 }}>{new Date(l.ts).toLocaleTimeString()}</span>
                <span style={{ width: 52, flexShrink: 0 }}>{l.method}</span>
                <span className="grow" style={{ wordBreak: "break-all" }}>{l.path}</span>
                <span className={statusClass(l.status)}>{l.status}</span>
                <span className="muted">{l.example ?? (l.route ? "no example" : "no route")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
