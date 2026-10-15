import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Bot, Check, Download, FilePlus2, Loader2, Play, Settings2, Square, X } from "lucide-react";
import { AgentRun, type AgentEvent, type Severity } from "../agent/runner";
import { fs } from "../lib/ipc";
import { aiStatus, dirname, useStore } from "../lib/store";
import { openSettings } from "../lib/settingsNav";
import { defaults, type A2AItem, type AgentItem, type Item, type McpItem } from "../lib/types";
import { Seg, Split } from "../components/ui";

interface Run {
  running: boolean;
  events: AgentEvent[];
  run?: AgentRun;
  startedAt?: number;
}

const useRuns = create<{ s: Record<string, Run> }>(() => ({ s: {} }));
const push = (id: string, e: AgentEvent) =>
  useRuns.setState((st) => {
    const cur = st.s[id] ?? { running: false, events: [] };
    const done = e.type === "done" || e.type === "error";
    return { s: { ...st.s, [id]: { ...cur, running: cur.running && !done, events: [...cur.events, e] } } };
  });

const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function report(item: Item & AgentItem, events: AgentEvent[]): string {
  const tests = events.filter((e): e is Extract<AgentEvent, { type: "test" }> => e.type === "test");
  const findings = events.filter((e): e is Extract<AgentEvent, { type: "finding" }> => e.type === "finding");
  const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
  const lines = [
    `# Agent test report: ${item.name}`,
    "",
    `_${new Date().toISOString()}_`,
    "",
    `**Goal:** ${item.goal}`,
    "",
    "## Summary",
    "",
    done?.summary ?? "(run did not finish)",
    "",
    `## Findings (${findings.length})`,
    "",
    ...findings
      .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))
      .flatMap((f) => [`### [${f.severity.toUpperCase()}] ${f.title}`, "", f.description, ...(f.evidence ? ["", "```", f.evidence, "```"] : []), ""]),
    `## Tests (${tests.filter((t) => t.passed).length}/${tests.length} passed)`,
    "",
    ...tests.map((t) => `- ${t.passed ? "✅" : "❌"} **${t.name}**: ${t.details}`),
  ];
  return lines.join("\n") + "\n";
}

export default function AgentPanel({ item }: { item: Item & AgentItem }) {
  const update = useStore((s) => s.updateItem);
  const items = useStore((s) => s.items);
  const settings = useStore((s) => s.settings);
  const run = useRuns((s) => s.s[item.path]) ?? { running: false, events: [] };
  const [tab, setTab] = useState<"findings" | "tests">("findings");
  const endRef = useRef<HTMLDivElement>(null);
  const set = (p: Partial<AgentItem>) => update(item.path, p);
  const mcps = Object.values(items).filter((i): i is Item & McpItem => i.kind === "mcp");
  const a2as = Object.values(items).filter((i): i is Item & A2AItem => i.kind === "a2a");

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [run.events.length]);

  const start = () => {
    const st = useStore.getState();
    const r = new AgentRun(
      {
        item,
        settings: st.settings,
        vars: st.vars(),
        mcpItem: item.mcpRef ? (items[item.mcpRef] as Item & McpItem) : undefined,
        a2aItem: item.a2aRef ? (items[item.a2aRef] as Item & A2AItem) : undefined,
      },
      (e) => push(item.path, e),
    );
    useRuns.setState((s) => ({ s: { ...s.s, [item.path]: { running: true, events: [], run: r, startedAt: Date.now() } } }));
    r.run();
  };

  const stop = () => {
    run.run?.stop();
    // Release any pending approval so the loop can observe the stop.
    run.events.forEach((e) => e.type === "approval" && e.decide(false));
  };

  const exportReport = async () => {
    const path = `reports/${item.path.split("/").pop()!.replace(/\.json$/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    await fs.write(path, report(item, run.events));
    useStore.getState().notify(`Saved ${path}`);
  };

  const saveRequest = async (input: any) => {
    const d = defaults.http();
    d.method = String(input.method ?? "GET").toUpperCase();
    d.url = /^https?:\/\//.test(input.url) ? input.url : `${item.baseUrl.replace(/\/+$/, "")}/${String(input.url).replace(/^\/+/, "")}`;
    d.headers = Object.entries<any>(input.headers ?? {}).map(([key, value]) => ({ key, value: String(value), enabled: true }));
    if (input.body !== undefined && input.body !== null) {
      d.bodyMode = typeof input.body === "string" ? "text" : "json";
      d.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body, null, 2);
    }
    await useStore.getState().createItem(dirname(item.path), "http", `${d.method} ${String(input.url).slice(0, 40)}`, d);
  };

  const tests = run.events.filter((e): e is Extract<AgentEvent, { type: "test" }> => e.type === "test");
  const findings = run.events.filter((e): e is Extract<AgentEvent, { type: "finding" }> => e.type === "finding");
  const usage = [...run.events].reverse().find((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage");
  const results = new Map(run.events.flatMap((e) => (e.type === "result" ? [[e.id, e] as const] : [])));
  const decided = useRef(new Set<string>());
  const [, force] = useState(0);
  const ai = aiStatus(settings);
  const ready = ai.ready;

  return (
    <Split
      id="agent"
      a={
        <div className="scroll">
          <div className="pad col">
            <div className="row">
              <Bot size={18} className="dim" />
              <h2 className="grow">Agentic test</h2>
              <button className="btn ghost sm" onClick={() => openSettings("ai")} title="Model settings">
                <Settings2 size={13} /> {settings.agent.model || "choose model"}
              </button>
            </div>
            <label className="field">
              Goal: what should the agent test?
              <textarea
                className="textarea"
                rows={5}
                value={item.goal}
                onChange={(e) => set({ goal: e.target.value })}
                placeholder="e.g. Test the /users API: CRUD happy paths, validation of email/age, auth failures, pagination limits. Report spec mismatches."
              />
            </label>
            <div className="grid2">
              <label className="field">
                Base URL
                <input className="input mono" value={item.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="{{baseUrl}} or https://api…" />
              </label>
              <label className="field">
                OpenAPI spec URL (JSON, optional)
                <input className="input mono" value={item.specUrl} onChange={(e) => set({ specUrl: e.target.value })} placeholder="https://api…/openapi.json" />
              </label>
              <label className="field">
                MCP server under test
                <select className="select" value={item.mcpRef} onChange={(e) => set({ mcpRef: e.target.value })}>
                  <option value="">None</option>
                  {mcps.map((m) => (
                    <option key={m.path} value={m.path}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                A2A agent under test
                <select className="select" value={item.a2aRef} onChange={(e) => set({ a2aRef: e.target.value })}>
                  <option value="">None</option>
                  {a2as.map((m) => (
                    <option key={m.path} value={m.path}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Max model turns
                <input className="input mono" type="number" min={1} max={200} value={item.maxSteps} onChange={(e) => set({ maxSteps: Number(e.target.value) })} />
              </label>
              <label className="check" style={{ alignSelf: "end", height: 30 }}>
                <input type="checkbox" checked={item.approveMutations} onChange={(e) => set({ approveMutations: e.target.checked })} />
                Ask before non-GET requests & tool calls
              </label>
            </div>
            <div className="row">
              {run.running ? (
                <button className="btn" onClick={stop}>
                  <Square size={13} /> Stop
                </button>
              ) : (
                <button className="btn primary" onClick={start} disabled={!ready}>
                  <Play size={14} /> Run agent
                </button>
              )}
              {!ready && (
                <span className="warn">
                  {ai.missing?.replace(/ in Settings$/, "")} in{" "}
                  <a href="#" onClick={() => openSettings("ai")}>
                    Settings
                  </a>
                </span>
              )}
              <div className="spacer" />
              {usage && <span className="stat">{`${(usage.input / 1000).toFixed(1)}k in · ${(usage.output / 1000).toFixed(1)}k out`}</span>}
              {!!run.events.length && !run.running && (
                <button className="btn sm" onClick={exportReport}>
                  <Download size={12} /> Export report
                </button>
              )}
            </div>
          </div>
          <div className="trace" style={{ borderTop: "1px solid var(--line)" }}>
            {!run.events.length && <div className="muted">The trace of the agent's reasoning, requests and results will stream here.</div>}
            {run.events.map((e, i) => {
              switch (e.type) {
                case "status":
                  return (
                    <div key={i} className="ev status">
                      {e.text}
                    </div>
                  );
                case "thought":
                  return (
                    <div key={i} className="ev thought">
                      {e.text}
                    </div>
                  );
                case "call": {
                  const r = results.get(e.id);
                  const brief = e.name === "http_request" ? `${e.input.method} ${e.input.url}` : e.name.startsWith("record_") || e.name === "finish" ? "" : JSON.stringify(e.input).slice(0, 120);
                  if (e.name === "record_test" || e.name === "record_finding" || e.name === "finish") return null;
                  return (
                    <details key={i} className={`ev call ${r?.isError ? "error" : ""}`}>
                      <summary>
                        {!r ? <Loader2 size={12} className="spin" /> : r.isError ? <X size={12} className="err" /> : <Check size={12} className="ok" />}
                        <span className="mono" style={{ fontWeight: 600 }}>{e.name}</span>
                        <span className="mono dim grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{brief}</span>
                        {r && <span className="stat">{r.ms.toFixed(0)} ms</span>}
                        {e.name === "http_request" && (
                          <button className="btn ghost icon sm" title="Save as request" onClick={(ev) => (ev.preventDefault(), saveRequest(e.input))}>
                            <FilePlus2 size={12} />
                          </button>
                        )}
                      </summary>
                      <pre className="block" style={{ marginTop: 6 }}>{JSON.stringify(e.input, null, 2)}</pre>
                      {r && <pre className={`block ${r.isError ? "err" : ""}`} style={{ marginTop: 6 }}>{r.output}</pre>}
                    </details>
                  );
                }
                case "approval": {
                  const done = decided.current.has(e.id);
                  return (
                    <div key={i} className="approval">
                      <div className="row">
                        <span className="warn" style={{ fontWeight: 600 }}>Approve?</span>
                        <span className="mono grow" style={{ wordBreak: "break-all" }}>{e.summary}</span>
                        {done ? (
                          <span className="muted">answered</span>
                        ) : (
                          <>
                            <button className="btn sm" onClick={() => (decided.current.add(e.id), e.decide(false), force((n) => n + 1))}>
                              Deny
                            </button>
                            <button className="btn primary sm" onClick={() => (decided.current.add(e.id), e.decide(true), force((n) => n + 1))}>
                              Allow
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                }
                case "done":
                  return (
                    <div key={i} className="card" style={{ borderColor: "var(--accent)" }}>
                      <h3 style={{ marginBottom: 6 }}>Summary</h3>
                      <div className="selectable" style={{ whiteSpace: "pre-wrap" }}>{e.summary}</div>
                    </div>
                  );
                case "error":
                  return (
                    <pre key={i} className="block err">
                      {e.message}
                    </pre>
                  );
                default:
                  return null;
              }
            })}
            {run.running && (
              <div className="ev status row">
                <Loader2 size={12} className="spin" /> working…
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>
      }
      b={
        <>
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              { id: "findings", label: "Findings", count: findings.length },
              { id: "tests", label: `Tests ${tests.length ? `${tests.filter((t) => t.passed).length}/${tests.length}` : ""}` },
            ]}
          />
          <div className="scroll grow">
            {tab === "findings" &&
              (findings.length ? (
                <div className="pad col">
                  {[...findings]
                    .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))
                    .map((f, i) => (
                      <div key={i} className="card col" style={{ gap: 6 }}>
                        <div className="row">
                          <span className={`sev sev-${f.severity}`}>{f.severity}</span>
                          <b className="grow">{f.title}</b>
                        </div>
                        <div className="dim selectable">{f.description}</div>
                        {f.evidence && <pre className="block">{f.evidence}</pre>}
                      </div>
                    ))}
                </div>
              ) : (
                <div className="empty">No findings yet.</div>
              ))}
            {tab === "tests" &&
              (tests.length ? (
                tests.map((t, i) => (
                  <div className="result" key={i}>
                    <span className={t.passed ? "ok" : "err"} style={{ fontWeight: 700, width: 36 }}>
                      {t.passed ? "PASS" : "FAIL"}
                    </span>
                    <div className="grow">
                      <div>{t.name}</div>
                      <div className="muted selectable" style={{ fontSize: 12 }}>{t.details}</div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">No tests recorded yet.</div>
              ))}
          </div>
        </>
      }
    />
  );
}

