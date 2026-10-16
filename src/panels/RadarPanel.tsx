import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { ChevronRight, Download, Loader2, LogOut, Play, Radar, Settings2, Sparkles, Square, Trash2, X } from "lucide-react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { RadarAgent, organizeWithAi, type RadarAgentEvent } from "../agent/radarAgent";
import { suggestName } from "../lib/autoname";
import { interpolate } from "../lib/eval";
import { bestSample, defaultName, toEndpoints, toImport, type Endpoint, type Organized } from "../lib/radar";
import { RadarSession, clearRadarProfiles, radarBrowsers, useRadars, type Browser } from "../lib/radarSession";
import { saveCollections } from "../lib/saveImport";
import { openSettings } from "../lib/settingsNav";
import { aiStatus, slug, useStore } from "../lib/store";
import { kv, type Item, type KV, type RadarItem } from "../lib/types";
import { Split, statusClass } from "../components/ui";

interface Ui {
  /** The user's (or the AI pick's) explicit choices; anything else follows the default. */
  picked: Record<string, boolean>;
  organized: Record<string, Organized>;
  log: RadarAgentEvent[];
  agent?: RadarAgent;
  picking?: boolean;
}

const useUi = create<{ s: Record<string, Ui> }>(() => ({ s: {} }));
const EMPTY: Ui = { picked: {}, organized: {}, log: [] };
const patchUi = (id: string, p: Partial<Ui> | ((u: Ui) => Partial<Ui>)) =>
  useUi.setState((st) => {
    const cur = st.s[id] ?? EMPTY;
    return { s: { ...st.s, [id]: { ...cur, ...(typeof p === "function" ? p(cur) : p) } } };
  });

const byDefault = (ep: Endpoint) => ep.firstParty && !ep.noise;

const normalizeUrl = (raw: string) => {
  const u = interpolate(raw.trim(), useStore.getState().vars());
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export default function RadarPanel({ item }: { item: Item & RadarItem }) {
  const update = useStore((s) => s.updateItem);
  const settings = useStore((s) => s.settings);
  const set = (p: Partial<RadarItem>) => update(item.path, p);
  const session = RadarSession.get(item.path);
  const radar = useRadars((s) => s.s[item.path]) ?? session.state;
  const ui = useUi((s) => s.s[item.path]) ?? EMPTY;
  const [browsers, setBrowsers] = useState<Browser[] | null>(null);
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [open_, setOpen] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [importing, setImporting] = useState(false);
  const ai = aiStatus(settings);

  useEffect(() => {
    radarBrowsers().then(setBrowsers, () => setBrowsers([]));
  }, []);

  const startUrl = item.url ? normalizeUrl(item.url) : "";
  const endpoints = useMemo(() => toEndpoints(radar.captures, radar.pageUrl && !startUrl ? radar.pageUrl : startUrl), [radar.captures, startUrl, radar.pageUrl]);
  const isPicked = (ep: Endpoint) => ui.picked[ep.key] ?? byDefault(ep);
  const hidden = endpoints.filter((e) => !byDefault(e)).length;
  const q = filter.trim().toLowerCase();
  const shown = endpoints.filter((e) => (showAll || byDefault(e) || ui.picked[e.key]) && (!q || `${e.method} ${e.origin}${e.path} ${e.op ?? ""} ${ui.organized[e.key]?.name ?? ""}`.toLowerCase().includes(q)));
  const chosen = endpoints.filter(isPicked);
  const groups = [...new Set(shown.map((e) => e.origin))];
  const running = radar.status === "open";
  const exploring = !!ui.agent;

  const startBrowser = () => {
    if (!item.url.trim()) return useStore.getState().notify("Enter the website's URL first", "error");
    session.start(normalizeUrl(item.url), item.browser);
  };

  const explore = async () => {
    const agent = new RadarAgent(session, { settings, goal: item.goal, startUrl, maxSteps: item.maxSteps, allowWrites: item.allowWrites }, (e) => {
      patchUi(item.path, (u) => ({ log: [...u.log, e].slice(-300) }));
      if (e.type === "done" || e.type === "error") patchUi(item.path, { agent: undefined });
    });
    patchUi(item.path, { agent, log: [] });
    agent.run();
  };

  const pickWithAi = async () => {
    patchUi(item.path, { picking: true });
    try {
      const { keep, organized } = await organizeWithAi(settings, endpoints, instruction);
      patchUi(item.path, { picked: Object.fromEntries(endpoints.map((e) => [e.key, keep.has(e.key)])), organized });
      setShowAll(true);
    } catch (e) {
      useStore.getState().notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      patchUi(item.path, { picking: false });
    }
  };

  const pickBrowser = async () => {
    const r = await open({ multiple: false, directory: false });
    if (typeof r === "string") set({ browser: r });
  };

  const forgetLogins = async () => {
    if (!(await ask("Sign out of every site you logged into through the radar browser? This deletes its profile.", { kind: "warning" }))) return;
    try {
      await clearRadarProfiles();
      useStore.getState().notify("Radar browser profile deleted");
    } catch (e) {
      useStore.getState().notify(String(e), "error");
    }
  };

  const doImport = async () => {
    const st = useStore.getState();
    const site = hostOf(startUrl || radar.pageUrl) || "Website radar";
    setImporting(true);
    try {
      const { result, secrets, baseUrl } = toImport(chosen, { name: site, startUrl, organized: ui.organized });
      // Requests without an AI name get the same readable names new requests get.
      result.collections[0].items.forEach((it, i) => {
        if (!ui.organized[chosen[i].key]?.name && it.name === defaultName(chosen[i])) it.name = suggestName({ ...it.data, name: "", path: "" }) ?? it.name;
      });
      // One environment per site holds its base URL and the session credentials (gitignored).
      const vars: KV[] = baseUrl ? [kv("baseUrl", baseUrl)] : [];
      const secretKv = Object.entries(secrets).map(([k, v]) => kv(k, v));
      const envName = `${site} (radar)`;
      const existing = st.envs.find((e) => e.name === envName);
      if (existing) {
        const merge = (old: KV[], add: KV[]) => [...old.filter((o) => !add.some((a) => a.key === o.key)), ...add];
        await st.saveEnv({ ...existing, vars: merge(existing.vars, vars), secrets: merge(existing.secrets, secretKv) }, { trust: true });
      } else await st.createEnv(envName, vars, secretKv);
      st.setActiveEnv(existing?.path ?? `environments/${slug(envName)}.json`);
      const { n, bases } = await saveCollections({ ...result, baseUrl: undefined });
      st.notify(`Imported ${n} requests into ${bases[0]?.name ?? site}, using the "${envName}" environment${Object.keys(secrets).length ? " for your session credentials" : ""}`);
    } catch (e) {
      st.notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setImporting(false);
    }
  };

  const toggleGroup = (origin: string, on: boolean) =>
    patchUi(item.path, (u) => ({ picked: { ...u.picked, ...Object.fromEntries(shown.filter((e) => e.origin === origin).map((e) => [e.key, on])) } }));
  const toggleAll = (on: boolean) => patchUi(item.path, (u) => ({ picked: { ...u.picked, ...Object.fromEntries(shown.map((e) => [e.key, on])) } }));

  const left = (
    <div className="scroll">
      <div className="pad col">
        <div className="row">
          <Radar size={18} className="dim" />
          <h2 className="grow">Website radar</h2>
        </div>
        <label className="field">
          Website
          <input
            className="input mono"
            value={item.url}
            onChange={(e) => set({ url: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && !running && startBrowser()}
            placeholder="https://app.example.com"
            spellCheck={false}
          />
        </label>
        <label className="field">
          Browser
          <div className="row">
            <select className="select grow" value={item.browser} onChange={(e) => (e.target.value === "::pick" ? pickBrowser() : set({ browser: e.target.value }))}>
              <option value="">{browsers?.[0] ? `${browsers[0].name} (default)` : browsers ? "None found" : "Looking…"}</option>
              {browsers?.slice(1).map((b) => (
                <option key={b.path} value={b.path}>
                  {b.name}
                </option>
              ))}
              {item.browser && !browsers?.some((b) => b.path === item.browser) && <option value={item.browser}>{item.browser.split(/[\\/]/).pop()}</option>}
              <option value="::pick">Choose a program…</option>
            </select>
          </div>
        </label>
        <div className="row">
          {running ? (
            <button className="btn" onClick={() => session.stop()}>
              <Square size={13} /> Close browser
            </button>
          ) : (
            <button className="btn primary" onClick={startBrowser} disabled={radar.status === "starting"}>
              {radar.status === "starting" ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Open browser
            </button>
          )}
          {!!radar.captures.length && (
            <button className="btn ghost sm" onClick={() => (session.clear(), patchUi(item.path, { picked: {}, organized: {} }))} title="Forget captured calls">
              <Trash2 size={13} /> Clear
            </button>
          )}
          <div className="spacer" />
          <button className="btn ghost sm" onClick={forgetLogins} disabled={running} title={running ? "Close the browser first" : "Delete the radar browser's profile, signing out of every site used in it"}>
            <LogOut size={13} /> Forget logins
          </button>
        </div>
        {radar.error && <pre className="block err">{radar.error}</pre>}
        {running ? (
          <div className="card col">
            <div className="row">
              <span className="ok">●</span>
              <b>Recording</b>
              <span className="muted">in {radar.browser}</span>
            </div>
            <div className="muted">Log in and use the app in the browser window. Every API call it makes shows up here, including ones from other tabs and popups.</div>
            {radar.pageUrl && <div className="mono dim" style={{ wordBreak: "break-all" }}>{radar.pageUrl}</div>}
            {radar.private === false && (
              <div className="warn-text">While this browser is open, other programs on this computer can connect to its debugging port and read the sites logged in there. Close it when you're done.</div>
            )}
          </div>
        ) : (
          <div className="muted">
            Forge opens the site in a separate browser with its own profile, so logins stay apart from your everyday browser and are remembered for next time. Log in yourself (password managers, SSO and 2FA all work), then click around, or let the AI explore. Use a test account where you can, and keep banking and other sensitive accounts out of it.
          </div>
        )}

        <div className="card col">
          <div className="row">
            <Sparkles size={15} className="dim" />
            <h3 className="grow">Explore with AI</h3>
            <button className="btn ghost sm" onClick={() => openSettings("ai")} title="Model settings">
              <Settings2 size={13} /> {settings.agent.model || "choose model"}
            </button>
          </div>
          <label className="field">
            Focus (optional)
            <textarea className="textarea" rows={2} value={item.goal} onChange={(e) => set({ goal: e.target.value })} placeholder="e.g. The billing and team settings pages" />
          </label>
          <div className="row">
            <label className="check" title="Without this, requests that create, change or delete data are blocked but still recorded">
              <input type="checkbox" checked={item.allowWrites} onChange={(e) => set({ allowWrites: e.target.checked })} />
              Let it change data
            </label>
            <div className="spacer" />
            <label className="check">
              steps
              <input className="input mono" style={{ width: 56 }} type="number" min={1} max={300} value={item.maxSteps} onChange={(e) => set({ maxSteps: Number(e.target.value) })} />
            </label>
          </div>
          <div className="row">
            {exploring ? (
              <button className="btn" onClick={() => ui.agent?.stop()}>
                <Square size={13} /> Stop
              </button>
            ) : (
              <button className="btn primary" onClick={explore} disabled={!running || !ai.ready}>
                <Sparkles size={14} /> Explore
              </button>
            )}
            {!ai.ready ? (
              <span className="warn">
                {ai.missing?.replace(/ in Settings$/, "")} in{" "}
                <a href="#" onClick={() => openSettings("ai")}>
                  Settings
                </a>
              </span>
            ) : (
              !running && <span className="muted">Open the browser and log in first</span>
            )}
          </div>
          {item.allowWrites && <div className="warn-text">The agent can create and change data in this account. It still skips delete, pay and sign-out controls.</div>}
          {!!ui.log.length && (
            <div className="col" style={{ gap: 4 }}>
              {ui.log
                .filter((e) => e.type !== "usage")
                .map((e, i) => (
                  <div key={i} className={`mono ${e.type === "error" || (e.type === "step" && e.error) ? "err" : e.type === "thought" ? "dim" : ""}`} style={{ fontSize: 11.5, whiteSpace: "pre-wrap" }}>
                    {e.type === "step" ? `› ${e.text}` : e.type === "thought" ? e.text : e.type === "done" ? `✓ ${e.summary}` : e.type === "error" ? e.message : ""}
                  </div>
                ))}
              {(() => {
                const u = [...ui.log].reverse().find((e): e is Extract<RadarAgentEvent, { type: "usage" }> => e.type === "usage");
                return u && <div className="muted" style={{ fontSize: 11 }}>{(u.input + u.output).toLocaleString()} tokens</div>;
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const right = (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="row pad" style={{ borderBottom: "1px solid var(--line)" }}>
        <input className="input grow" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${endpoints.length} endpoints`} />
        {!!hidden && (
          <label className="check" title="Other sites, analytics and monitoring calls">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Third-party & tracking ({hidden})
          </label>
        )}
      </div>
      {!!endpoints.length && (
        <div className="row pad" style={{ borderBottom: "1px solid var(--line)" }}>
          <input
            className="input grow"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ai.ready && pickWithAi()}
            placeholder="Pick with AI, e.g. only orders and payments (it also names and groups them)"
          />
          <button className="btn sm" onClick={pickWithAi} disabled={!ai.ready || ui.picking} title={ai.ready ? "Choose, name and group endpoints with AI. Only methods, paths and field names are sent." : ai.missing}>
            {ui.picking ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Pick
          </button>
        </div>
      )}
      <div className="scroll grow">
        {!endpoints.length ? (
          <div className="empty">
            <div className="big">{running ? "Waiting for API calls…" : "No endpoints yet"}</div>
            {running ? "Use the app in the radar browser: open pages, search, filter, open dialogs." : "Open the browser, log in and use the app. Its API calls are grouped into endpoints here."}
          </div>
        ) : (
          <div>
            <div className="row" style={{ padding: "6px 14px" }}>
              <a href="#" onClick={(e) => (e.preventDefault(), toggleAll(true))}>
                Select all
              </a>
              <a href="#" onClick={(e) => (e.preventDefault(), toggleAll(false))}>
                None
              </a>
            </div>
            {groups.map((origin) => {
              const eps = shown.filter((e) => e.origin === origin);
              const on = eps.filter(isPicked).length;
              return (
                <div key={origin}>
                  <label className="row" style={{ padding: "8px 14px", background: "var(--bg-1)", borderBottom: "1px solid var(--line)" }}>
                    <input type="checkbox" checked={on === eps.length} ref={(el) => void (el && (el.indeterminate = on > 0 && on < eps.length))} onChange={(e) => toggleGroup(origin, e.target.checked)} />
                    <b className="mono">{new URL(origin).host}</b>
                    {!eps[0].firstParty && <span className="tag">third-party</span>}
                    <span className="muted">
                      {on}/{eps.length}
                    </span>
                  </label>
                  {eps.map((ep) => (
                    <EndpointRow
                      key={ep.key}
                      ep={ep}
                      picked={isPicked(ep)}
                      name={ui.organized[ep.key]}
                      open={open_ === ep.key}
                      onOpen={() => setOpen(open_ === ep.key ? null : ep.key)}
                      onPick={(v) => patchUi(item.path, (u) => ({ picked: { ...u.picked, [ep.key]: v } }))}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="row pad" style={{ borderTop: "1px solid var(--line)" }}>
        <span className="muted grow">
          {radar.captures.length} calls · {endpoints.length} endpoints
          {Object.keys(ui.organized).length ? " · named by AI" : ""}
        </span>
        <button className="btn primary" onClick={doImport} disabled={!chosen.length || importing}>
          {importing ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Import {chosen.length} request{chosen.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );

  return <Split id="radar" a={left} b={right} />;
}

function EndpointRow({ ep, picked, name, open, onOpen, onPick }: { ep: Endpoint; picked: boolean; name?: Organized; open: boolean; onOpen: () => void; onPick: (v: boolean) => void }) {
  const c = bestSample(ep);
  const body = (t?: string) => {
    if (!t) return "";
    try {
      return JSON.stringify(JSON.parse(t), null, 2).slice(0, 4000);
    } catch {
      return t.slice(0, 4000);
    }
  };
  return (
    <div style={{ borderBottom: "1px solid var(--line)" }}>
      <div className="row" style={{ padding: "6px 14px", cursor: "pointer" }} onClick={onOpen}>
        <input type="checkbox" checked={picked} onClick={(e) => e.stopPropagation()} onChange={(e) => onPick(e.target.checked)} />
        <ChevronRight size={12} className="dim" style={{ transform: open ? "rotate(90deg)" : undefined, flexShrink: 0 }} />
        <span className={`method m-${ep.method}`} style={{ width: 44, flexShrink: 0 }}>
          {ep.method === "DELETE" ? "DEL" : ep.method}
        </span>
        <span className="mono grow" style={{ wordBreak: "break-all" }}>
          {ep.path}
          {ep.op && <span className="k-gql"> {ep.op}</span>}
          {name?.name && (
            <span className="muted">
              {"  "}
              {name.folder ? `${name.folder} / ` : ""}
              {name.name}
            </span>
          )}
        </span>
        {c.blocked && <span className="tag" title="Blocked by Forge while the agent explored, so nothing changed. The request is still captured.">blocked</span>}
        {ep.noise && <span className="tag">tracking</span>}
        <span className="muted" style={{ fontSize: 11 }}>×{ep.count}</span>
        <span className={c.status ? statusClass(c.status) : c.failed ? "err" : "muted"} style={{ width: 34, textAlign: "right", fontSize: 11 }}>
          {c.status ?? (c.blocked ? "–" : c.failed ? <X size={11} /> : "…")}
        </span>
      </div>
      {open && (
        <div className="col" style={{ padding: "4px 14px 12px 40px", gap: 6 }}>
          <div className="mono dim selectable" style={{ wordBreak: "break-all", fontSize: 11.5 }}>
            {c.method} {c.url}
          </div>
          {c.page && <div className="muted" style={{ fontSize: 11 }}>from {c.page}{c.byAgent ? " · during AI exploration" : ""}</div>}
          {c.postData && (
            <>
              <div className="muted">Request body</div>
              <pre className="block selectable">{body(c.postData)}</pre>
            </>
          )}
          {c.responseBody && (
            <>
              <div className="muted">Response{c.mimeType ? ` · ${c.mimeType}` : ""}</div>
              <pre className="block selectable">{body(c.responseBody)}</pre>
            </>
          )}
          {c.failed && !c.blocked && <div className="err">{c.failed}</div>}
        </div>
      )}
    </div>
  );
}
