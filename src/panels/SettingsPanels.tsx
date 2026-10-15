import { useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  CheckCircle2,
  Columns2,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  Loader2,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Rows2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { fs, http } from "../lib/ipc";
import { toPostmanEnv } from "../lib/exportCollection";
import { reveal, revealLabel } from "../lib/reveal";
import type { Environment } from "../lib/types";
import { importAny } from "../lib/importAny";
import { setPaneLayout, usePaneDir } from "../components/PaneLayout";
import ForgeMark from "../components/ForgeMark";
import VarInput from "../components/VarInput";
import { Markdown } from "../components/ChatPanel";
import { BRAND, links } from "../lib/brand";
import { useSettingsNav, type SettingsSection } from "../lib/settingsNav";
import { checkForUpdates, installUpdate, relaunchApp, useUpdates } from "../lib/updates";
import { DEFAULT_APPEARANCE, PALETTES, type Appearance, type Palette as PaletteId, type ThemeMode } from "../lib/theme";
import { PROVIDER_DEFAULTS, aiStatus, secretsPath, useStore, type ProviderId, type Settings } from "../lib/store";
import { KvTable } from "../components/ui";
import ConnectTools from "../components/ConnectTools";

const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <FolderOpen size={15} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  { id: "ai", label: "AI model", icon: <Sparkles size={15} /> },
  { id: "connect", label: "Connect AI tools", icon: <Plug size={15} /> },
  { id: "updates", label: "Updates", icon: <RefreshCw size={15} /> },
  { id: "about", label: "About", icon: <Info size={15} /> },
];

export function SettingsPanel() {
  const section = useSettingsNav((s) => s.section);
  const settings = useStore((s) => s.settings);
  const ai = aiStatus(settings);
  const upd = useUpdates((u) => u.status);
  const dot: Partial<Record<SettingsSection, boolean>> = { ai: !ai.ready, updates: upd === "available" || upd === "ready" };
  const current = SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-title">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} className={`settings-link ${s.id === section ? "on" : ""}`} onClick={() => useSettingsNav.setState({ section: s.id })}>
            {s.icon}
            <span className="grow">{s.label}</span>
            {dot[s.id] && <span className={`settings-dot ${s.id === "updates" ? "accent" : ""}`} />}
          </button>
        ))}
      </nav>
      <div className="scroll settings-body">
        <div className="settings-page" key={section}>
          <h1 className="settings-h">{current.label}</h1>
          {section === "general" && <GeneralSection />}
          {section === "appearance" && <AppearanceSection />}
          {section === "ai" && <AiSection />}
          {section === "connect" && <ConnectTools embedded />}
          {section === "updates" && <UpdatesSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

/** One line in a settings group: label and hint on the left, the control on the right. */
function Row({ label, hint, children, stack }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row ${stack ? "stack" : ""}`}>
      <div className="set-text">
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      {children && <div className="set-control">{children}</div>}
    </div>
  );
}

function Group({ title, children, note }: { title?: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-section">
      {title && <h3>{title}</h3>}
      <div className="set-group">{children}</div>
      {note && <div className="set-note">{note}</div>}
    </section>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

function GeneralSection() {
  const root = useStore((s) => s.root);
  const switchWorkspace = async () => {
    const dir = await open({ directory: true, title: "Open or create a Forge workspace folder" });
    if (typeof dir === "string") await useStore.getState().openWorkspace(dir);
  };
  return (
    <>
      <Group title="Workspace" note="Collections and environments are plain JSON files in this folder. Commit them to git to share with your team. Secrets stay in *.local.json files, which Forge keeps out of git.">
        <Row label="Folder" hint={<span className="mono selectable" style={{ wordBreak: "break-all" }}>{root}</span>}>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => reveal()}>
              {revealLabel}
            </button>
            <button className="btn sm" onClick={switchWorkspace}>
              Switch
            </button>
          </div>
        </Row>
      </Group>
      <Group title="Network">
        <Row label="Cookies" hint="Cookies servers set are kept in memory for this session and sent back automatically.">
          <button className="btn sm" onClick={() => http.resetCookies().then(() => useStore.getState().notify("Cookies cleared"))}>
            Clear cookies
          </button>
        </Row>
        <Row label="Proxy and certificates" hint="Forge uses your system proxy and trusted certificates, so it works on company VPNs without extra setup." />
      </Group>
      <Group title="Help">
        <Row label="Welcome guide" hint="The short tour shown on first launch.">
          <button className="btn sm" onClick={() => useStore.getState().saveSettings({ onboarded: false })}>
            Show again
          </button>
        </Row>
        <Row label="Keyboard shortcuts" hint={<Shortcuts />} stack />
      </Group>
    </>
  );
}

function Shortcuts() {
  const keys: [string, string][] = [
    ["⌘ ↵", "Send request"],
    ["⌘ L", "Ask about your APIs"],
    ["⌘ I", "Import"],
    ["⌘ J", "Console"],
    ["⌘ ,", "Settings"],
    ["⌘ W", "Close tab"],
  ];
  return (
    <span className="shortcuts">
      {keys.map(([k, d]) => (
        <span key={k}>
          <kbd>{k}</kbd> {d}
        </span>
      ))}
    </span>
  );
}

function AppearanceSection() {
  const appearance = { ...DEFAULT_APPEARANCE, ...useStore((s) => s.settings.appearance) };
  const save = useStore((s) => s.saveSettings);
  const set = (patch: Partial<Appearance>) => save({ appearance: { ...appearance, ...patch } });
  const modes: { id: ThemeMode; label: string }[] = [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];
  return (
    <>
      <Group title="Theme" note="Dark is true black, easy on OLED screens. System follows your computer.">
        <div className="set-pad">
          <div className="theme-modes">
            {modes.map((m) => (
              <button key={m.id} className={`theme-mode ${appearance.mode === m.id ? "on" : ""}`} onClick={() => set({ mode: m.id })}>
                <ThemePreview mode={m.id} palette={appearance.palette} />
                <span>{m.label}</span>
              </button>
            ))}
          </div>
        </div>
      </Group>
      <Group title="Accent">
        <div className="set-pad row" style={{ gap: 8, flexWrap: "wrap" }}>
          {PALETTES.map((p) => (
            <button key={p.id} className={`swatch ${appearance.palette === p.id ? "on" : ""}`} onClick={() => set({ palette: p.id })} title={p.label}>
              <span style={{ background: `linear-gradient(135deg, ${p.dark} 50%, ${p.light} 50%)` }} />
              {p.label}
            </button>
          ))}
        </div>
      </Group>
      <Group title="Layout">
        <Row label="Request and response" hint="Where the response appears. You can also switch from the response bar.">
          <PanesSetting />
        </Row>
      </Group>
    </>
  );
}

function AiSection() {
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const [advanced, setAdvanced] = useState(false);
  const [show, setShow] = useState(false);
  const a = settings.agent;
  const id = a.provider;
  const ai = aiStatus(settings);
  const setAgent = (patch: Partial<Settings["agent"]>) => save({ agent: { ...a, ...patch } });
  const p = id ? settings.providers[id] : null;
  const def = id ? PROVIDER_DEFAULTS[id] : null;
  const setProvider = (patch: Partial<Settings["providers"][ProviderId]>) => id && p && save({ providers: { ...settings.providers, [id]: { ...p, ...patch } } });

  return (
    <>
      <div className={`ai-status ${ai.ready ? "ok" : ""}`}>
        {ai.ready ? <CheckCircle2 size={16} /> : <Sparkles size={16} />}
        <div className="grow">
          <b>{ai.ready ? `Using ${a.model}` : "AI is optional"}</b>
          <div className="muted">
            {ai.ready
              ? `via ${ai.label}. Powers Ask, agentic tests, Suggest and request naming.`
              : "Everything in Forge works without it. Connect a model to use Ask, agentic tests, Suggest and smart request names."}
          </div>
        </div>
        {id && (
          <button className="btn ghost sm" onClick={() => setAgent({ provider: "", model: "" })}>
            Turn off
          </button>
        )}
      </div>

      <Group title="Provider">
        <div className="set-pad provider-grid">
          {(Object.keys(PROVIDER_DEFAULTS) as ProviderId[]).map((pid) => (
            <button key={pid} className={`provider ${pid === id ? "on" : ""}`} onClick={() => pid !== id && setAgent({ provider: pid, model: "" })}>
              <b>{PROVIDER_DEFAULTS[pid].label}</b>
              <span className="muted">{PROVIDER_NOTES[pid]}</span>
            </button>
          ))}
        </div>
      </Group>

      {id && p && def && (
        <Group title={def.label} note={def.help}>
          {def.needsKey || id === "custom" ? (
            <Row label="API key" hint={def.needsKey ? "Stored only on this computer in Forge's app settings (file mode 600), never in your workspace." : "Optional"} stack>
              <div className="row" style={{ gap: 6 }}>
                <input className="input mono grow" type={show ? "text" : "password"} value={p.apiKey} onChange={(e) => setProvider({ apiKey: e.target.value })} placeholder="Paste your key" autoComplete="off" spellCheck={false} />
                <button className="btn ghost icon sm" onClick={() => setShow(!show)} title={show ? "Hide" : "Show"}>
                  {show ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </Row>
          ) : null}
          <Row label="Model" hint={def.model ? "Pick a suggestion or type any model ID." : def.modelHint ?? "The model ID to use."} stack>
            <VarInput
              className="input-like"
              value={a.model}
              onChange={(e) => setAgent({ model: e.target.value })}
              suggestions={id === "anthropic" ? CLAUDE_MODELS : def.model ? [def.model] : undefined}
              onPick={(model) => setAgent({ model })}
              placeholder={def.modelHint ?? (id === "ollama" ? "e.g. qwen3:14b" : "model ID")}
            />
            {!a.model && def.model && (
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <span className="muted">Suggested</span>
                <button className="chip-add" onClick={() => setAgent({ model: def.model })}>
                  {def.model}
                </button>
              </div>
            )}
          </Row>
          {id === "anthropic" && (
            <Row label="Effort" hint="Higher thinks longer and costs more.">
              <select className="select" value={a.effort} onChange={(e) => setAgent({ effort: e.target.value as Settings["agent"]["effort"] })}>
                {["low", "medium", "high", "xhigh", "max"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Row>
          )}
          {(advanced || p.baseUrl || !def.baseUrl) ? (
            <Row label="Endpoint" hint={def.baseUrl ? "Leave empty for the standard endpoint. Set it for a proxy or gateway." : "Your resource endpoint."} stack>
              <input className="input mono" value={p.baseUrl} onChange={(e) => setProvider({ baseUrl: e.target.value })} placeholder={def.baseUrl || "https://…"} spellCheck={false} />
            </Row>
          ) : (
            <Row label="Endpoint" hint={<span className="mono">{def.baseUrl}</span>}>
              <button className="btn ghost sm" onClick={() => setAdvanced(true)}>
                Change
              </button>
            </Row>
          )}
        </Group>
      )}

      {id && (
        <Group title="Features">
          <Row label="Smart request names" hint="After a new request's first response, one short call turns its name into something readable, like List products.">
            <Switch label="Smart request names" on={settings.ai?.autoName !== false} onChange={(v) => save({ ai: { ...settings.ai, autoName: v } })} />
          </Row>
        </Group>
      )}

      <div className="set-note" style={{ marginTop: 4 }}>
        <ShieldCheck size={13} /> Requests and responses the assistant reads go to the provider you choose, under your own account with them. Environment variable values are never sent, and Forge asks before an AI-built request sends a secret or calls an unfamiliar host.
      </div>
    </>
  );
}

const PROVIDER_NOTES: Record<ProviderId, string> = {
  anthropic: "Claude models",
  openai: "GPT models",
  openrouter: "Hundreds of models, one key",
  gemini: "Google AI Studio key",
  azure: "Your Azure deployment",
  bedrock: "AWS, Bedrock API key",
  ollama: "Runs on your computer",
  custom: "Any OpenAI-compatible server",
};

function UpdatesSection() {
  const u = useUpdates();
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const auto = settings.updates?.auto !== false;
  const when = u.checkedAt ? new Date(u.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <>
      <Group>
        <Row
          label={
            u.status === "available" || u.status === "downloading" || u.status === "ready" ? (
              <>Forge {u.version} is available</>
            ) : (
              <>Forge {u.current || ""}</>
            )
          }
          hint={
            u.status === "unsupported"
              ? "Updates work in the installed app, not in the browser preview."
              : u.status === "checking"
                ? "Checking…"
                : u.status === "latest"
                  ? `You're up to date${when ? `, checked at ${when}` : ""}.`
                  : u.status === "error"
                    ? `Couldn't check: ${u.error}`
                    : u.status === "downloading"
                      ? `Downloading${u.progress !== undefined ? ` ${Math.round(u.progress * 100)}%` : "…"}`
                      : u.status === "ready"
                        ? "Installed. Restart Forge to finish."
                        : u.status === "available"
                          ? "Your workspace and settings are kept."
                          : "Updates are signed by Stellitron and verified before install."
          }
        >
          {u.status === "available" ? (
            <button className="btn primary sm" onClick={installUpdate}>
              <Download size={13} /> Install
            </button>
          ) : u.status === "ready" ? (
            <button className="btn primary sm" onClick={relaunchApp}>
              Restart now
            </button>
          ) : (
            <button className="btn sm" disabled={u.status === "checking" || u.status === "downloading" || u.status === "unsupported"} onClick={() => checkForUpdates(false)}>
              {u.status === "checking" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Check now
            </button>
          )}
        </Row>
        {u.status === "downloading" && (
          <div className="set-pad">
            <div className="progress">
              <i style={{ width: `${Math.round((u.progress ?? 0.05) * 100)}%` }} />
            </div>
          </div>
        )}
        {u.notes && (u.status === "available" || u.status === "ready") && (
          <div className="set-pad release-notes">
            <Markdown text={u.notes} />
          </div>
        )}
        <Row label="Check automatically" hint="Looks for a new version at launch and every few hours. Nothing installs without your click.">
          <Switch label="Check automatically" on={auto} onChange={(v) => save({ updates: { ...settings.updates, auto: v } })} />
        </Row>
      </Group>
      <div className="set-note">
        <a href="#" onClick={(e) => (e.preventDefault(), openUrl(links.releases))}>
          All releases and changelogs
        </a>
      </div>
    </>
  );
}

function AboutSection() {
  const current = useUpdates((u) => u.current);
  const go = (url: string) => (e: React.MouseEvent) => (e.preventDefault(), openUrl(url));
  return (
    <>
      <div className="about">
        <ForgeMark size={56} />
        <div>
          <div className="about-name">Forge</div>
          <div className="muted">Version {current || "dev"}</div>
          <div className="muted">
            by{" "}
            <a href="#" onClick={go(BRAND.companySite)}>
              Stellitron
            </a>
          </div>
        </div>
      </div>
      <Group note={<>Copyright 2026 Stellitron Technologies Pvt Ltd. Free and open source under the Apache License 2.0. Forge and the Forge logo are trademarks of Stellitron.</>}>
        {(
          [
            ["Website", BRAND.site],
            ["Source code", BRAND.repo],
            ["Documentation", links.docs],
            ["Report an issue", links.issues],
            ["Security policy", links.security],
            ["License", links.license],
          ] as const
        ).map(([label, url]) => (
          <Row key={label} label={label} hint={<span className="mono">{url.replace(/^https:\/\//, "")}</span>}>
            <button className="btn ghost icon sm" onClick={go(url)} title={`Open ${label}`}>
              <ExternalLink size={14} />
            </button>
          </Row>
        ))}
      </Group>
    </>
  );
}

/** Environment title that is also its rename field (Enter or blur saves, Esc reverts). */
function EnvName({ env, autoFocus, onRenamed }: { env: { path: string; name: string }; autoFocus: boolean; onRenamed: (path: string) => void }) {
  const [v, setV] = useState(env.name);
  const commit = () =>
    useStore
      .getState()
      .renameEnv(env.path, v)
      .then(onRenamed, (e) => (useStore.getState().notify(String(e), "error"), setV(env.name)));
  return (
    <input
      className="title-input grow"
      value={v}
      autoFocus={autoFocus}
      onFocus={(e) => autoFocus && e.target.select()}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") (setV(env.name), setTimeout(() => (e.target as HTMLInputElement).blur()));
      }}
      title="Rename"
      spellCheck={false}
    />
  );
}

/** Saves an environment as a Postman environment. Secret values are only included if the user says so. */
async function exportEnv(env: Environment) {
  const { save, ask } = await import("@tauri-apps/plugin-dialog");
  const withSecrets =
    env.secrets.length > 0 &&
    (await ask(`Include the values of ${env.secrets.length} secret${env.secrets.length === 1 ? "" : "s"}? Choose No to export their names with empty values, which is safer to share.`, { title: "Export environment", kind: "warning", okLabel: "Include values", cancelLabel: "No" }));
  const to = await save({ defaultPath: `${env.name.replace(/[/\\:*?"<>|]/g, "-")}.postman_environment.json`, filters: [{ name: "Postman environment", extensions: ["json"] }] });
  if (!to) return;
  await fs.saveFile(to, new TextEncoder().encode(toPostmanEnv(env, withSecrets)));
  useStore.getState().notify(`Exported ${env.name}${withSecrets ? " with secret values" : ""}`);
}

export function EnvPanel() {
  const envs = useStore((s) => s.envs);
  const active = useStore((s) => s.activeEnv);
  const sessionVars = useStore((s) => s.sessionVars);
  const [sel, setSel] = useState(active ?? envs[0]?.path ?? "");
  const [fresh, setFresh] = useState<string | null>(null); // just created: focus its name
  const env = envs.find((e) => e.path === sel);
  const create = async () => {
    const p = await st.newEnv();
    setSel(p);
    setFresh(p);
  };
  const st = useStore.getState();

  const importFile = (file: File) =>
    file.text().then(async (t) => {
      try {
        // Any environment format; credentials are split into the gitignored local file.
        const { envs } = importAny([{ path: file.name, content: t }]);
        if (!envs.length) throw new Error("No environment found in that file");
        for (const e of envs) await st.createEnv(e.name, e.vars, e.secrets);
        const secret = envs.reduce((n, e) => n + e.secrets.length, 0);
        st.notify(`Imported ${envs.map((e) => e.name).join(", ")}${secret ? ` · ${secret} secret values kept local (not in git)` : ""}`);
      } catch (e) {
        st.notify(String(e), "error");
      }
    });

  return (
    <div className="split h" style={{ ["--split" as string]: "240px" }}>
      <div className="pane" style={{ borderRight: "1px solid var(--line)" }}>
        <div className="pad col" style={{ gap: 6 }}>
          <h3>Environments</h3>
          {envs.map((e) => (
            <div key={e.path} className={`list-item row ${e.path === sel ? "on" : ""}`} onClick={() => setSel(e.path)}>
              <span className="grow">{e.name}</span>
              {e.path === active && <Check size={13} className="ok" />}
            </div>
          ))}
          <button className="btn sm" style={{ justifyContent: "center", marginTop: 6 }} onClick={create}>
            <Plus size={13} /> New environment
          </button>
          <label className="btn ghost sm" style={{ justifyContent: "center" }}>
            <Upload size={12} /> Import environment
            <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
          {Object.keys(sessionVars).length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Session variables</h3>
              <div className="muted" style={{ fontSize: 12 }}>Captured with no active environment; cleared on restart.</div>
              {Object.entries(sessionVars).map(([k, v]) => (
                <div key={k} className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                  {k} = {v.slice(0, 60)}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      <div />
      <div className="pane">
        {env ? (
          <>
            <div className="row pad" style={{ borderBottom: "1px solid var(--line)" }}>
              <EnvName key={env.path} env={env} autoFocus={fresh === env.path} onRenamed={(p) => (setSel(p), setFresh(null))} />
              <span className="muted mono">{env.path}</span>
              {env.path === active ? (
                <button className="btn sm" onClick={() => st.setActiveEnv(null)}>
                  Deactivate
                </button>
              ) : (
                <button className="btn primary sm" onClick={() => st.setActiveEnv(env.path)}>
                  Use this environment
                </button>
              )}
              <button className="btn ghost sm" onClick={() => exportEnv(env)} title="Save as a Postman environment">
                <Download size={13} /> Export
              </button>
              <button className="btn ghost icon sm danger" onClick={() => st.deleteEnv(env.path)} title="Delete">
                <Trash2 size={13} />
              </button>
            </div>
            <div className="scroll">
              <div className="pad col" style={{ gap: 4, paddingBottom: 6 }}>
                <h3>Shared</h3>
                <div className="muted" style={{ fontSize: 12 }}>
                  Saved in <span className="mono">{env.path}</span> and meant to be committed: URLs, IDs and other non-secret settings.
                </div>
              </div>
              <KvTable rows={env.vars} onChange={(vars) => st.saveEnv({ ...env, vars })} keyPh="Variable" />
              <div className="pad col" style={{ gap: 4, paddingBottom: 6, marginTop: 10 }}>
                <h3>Secrets · local only</h3>
                <div className="muted" style={{ fontSize: 12 }}>
                  Saved in <span className="mono">{secretsPath(env.path)}</span>, which the workspace <span className="mono">.gitignore</span> excludes. Tokens captured by
                  “Save to environment” land here. Values here override Shared ones with the same name.
                </div>
              </div>
              <KvTable rows={env.secrets} onChange={(secrets) => st.saveEnv({ ...env, secrets })} keyPh="Secret" valuePh="Value (never committed)" />
            </div>
          </>
        ) : (
          <div className="empty col" style={{ alignItems: "center", gap: 10 }}>
            <div>Environments hold variables like baseUrl and tokens, so one request works against local, staging and prod.</div>
            <button className="btn primary" onClick={create}>
              <Plus size={14} /> New environment
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A tiny drawing of the app in that mode; "system" is split down the middle. */
function ThemePreview({ mode, palette }: { mode: ThemeMode; palette: PaletteId }) {
  const p = PALETTES.find((x) => x.id === palette)!;
  const half = (dark: boolean) => {
    const c = dark
      ? { bg: "#000", side: "#000", line: "#26262b", text: "#3a3a40", accent: p.dark }
      : palette === "clay"
        ? { bg: "#faf9f5", side: "#f4f3ee", line: "#e1ddd1", text: "#d8d3c6", accent: p.light }
        : { bg: "#ffffff", side: "#f4f5f7", line: "#e3e5e8", text: "#dde0e4", accent: p.light };
    return (
      <div className="tp" style={{ background: c.bg, borderColor: c.line }}>
        <div className="tp-side" style={{ background: c.side, borderColor: c.line }}>
          <i style={{ background: c.accent }} />
          <i style={{ background: c.text }} />
          <i style={{ background: c.text }} />
        </div>
        <div className="tp-main">
          <i style={{ background: c.text, width: "70%" }} />
          <i style={{ background: c.text, width: "45%" }} />
          <b style={{ background: c.accent }} />
        </div>
      </div>
    );
  };
  if (mode !== "system") return <div className="tp-wrap">{half(mode === "dark")}</div>;
  return (
    <div className="tp-wrap split">
      <div>{half(false)}</div>
      <div>{half(true)}</div>
    </div>
  );
}

function PanesSetting() {
  const dir = usePaneDir();
  const options = [
    { id: "side" as const, label: "Side by side", on: dir === "h", icon: <Columns2 size={14} /> },
    { id: "stacked" as const, label: "Top and bottom", on: dir === "v", icon: <Rows2 size={14} /> },
  ];
  return (
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={o.id} className={`swatch ${o.on ? "on" : ""}`} onClick={() => setPaneLayout(o.id)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
