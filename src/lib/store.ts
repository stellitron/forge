import { create } from "zustand";
import { fs } from "./ipc";
import { varsOf } from "./eval";
import { applyAppearance, type Appearance } from "./theme";
import { defaults, type AssertionResult, type Environment, type HttpResponse, type Item, type ItemData, type ItemKind, type KV } from "./types";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "gemini" | "azure" | "bedrock" | "ollama" | "custom";

export interface Settings {
  lastWorkspace?: string;
  activeEnv?: Record<string, string>; // workspace root -> env path
  providers: Record<ProviderId, { apiKey: string; baseUrl: string }>;
  /** provider "" means AI isn't set up yet; Forge works fully without it. */
  agent: { provider: ProviderId | ""; model: string; effort: "low" | "medium" | "high" | "xhigh" | "max" };
  /** Forge's own MCP + A2A server for Claude, VS Code, Cursor, Copilot and A2A clients. */
  server?: { enabled: boolean; port: number; token: string; approveWrites: boolean };
  ai?: { autoName?: boolean };
  appearance?: Appearance;
  layout?: { panes?: "side" | "stacked" };
  /** Set once the first-run guide is finished or skipped. */
  onboarded?: boolean;
  updates?: { auto?: boolean };
}

/** Whether an AI model is ready to use, and if not, what's missing (for buttons and hints). */
export function aiStatus(s: Settings): { ready: boolean; label: string; missing?: string } {
  const id = s.agent.provider;
  if (!id) return { ready: false, label: "No AI model", missing: "Choose an AI provider in Settings" };
  const def = PROVIDER_DEFAULTS[id];
  if (def.needsKey && !s.providers[id]?.apiKey) return { ready: false, label: def.label, missing: `Add your ${def.label} API key in Settings` };
  if (!s.agent.model) return { ready: false, label: def.label, missing: "Choose a model in Settings" };
  return { ready: true, label: def.label };
}

export const PROVIDER_DEFAULTS: Record<ProviderId, { label: string; baseUrl: string; model: string; needsKey: boolean; modelHint?: string; help?: string }> = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", needsKey: true },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "", needsKey: true, modelHint: "e.g. anthropic/claude-sonnet-4.5", help: "Any model on openrouter.ai/models that supports tool calling." },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    needsKey: true,
    help: "API key from Google AI Studio (aistudio.google.com/apikey).",
  },
  azure: {
    label: "Azure OpenAI",
    baseUrl: "",
    model: "",
    needsKey: true,
    modelHint: "your deployment name",
    help: "Base URL is your resource endpoint, e.g. https://my-resource.openai.azure.com (Azure AI Foundry endpoints work too). Model is the deployment name. The key is sent as the api-key header.",
  },
  bedrock: {
    label: "Amazon Bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    model: "",
    needsKey: true,
    modelHint: "model or inference profile ID",
    help: "Uses a Bedrock API key (Bedrock console → API keys) and the Converse API. Set the region in the base URL. Model is a model ID or inference profile ID with tool use, e.g. us.anthropic.claude-… from the Bedrock console.",
  },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "", needsKey: false },
  custom: { label: "Custom OpenAI-compatible", baseUrl: "http://localhost:1234/v1", model: "", needsKey: false },
};

const defaultSettings = (): Settings => ({
  providers: Object.fromEntries(
    Object.keys(PROVIDER_DEFAULTS).map((id) => [id, { apiKey: "", baseUrl: "" }]),
  ) as Settings["providers"],
  // Nothing is chosen for a new user; an empty base URL means the provider's standard endpoint.
  agent: { provider: "", model: "", effort: "high" },
});

/** Special, non-file tabs. */
export const SETTINGS_TAB = "::settings";
export const ENV_TAB = "::environments";
export const runnerTab = (folder: string) => `::runner:${folder}`;

export interface ResponseState {
  loading?: boolean;
  requestId?: string;
  res?: HttpResponse;
  error?: string;
  results?: AssertionResult[];
  extracted?: Record<string, string>;
}

interface State {
  root: string | null;
  dirs: string[];
  items: Record<string, Item>;
  envs: Environment[];
  activeEnv: string | null;
  sessionVars: Record<string, string>;
  tabs: string[];
  active: string | null;
  settings: Settings;
  responses: Record<string, ResponseState>;
  toast: { text: string; kind: "info" | "error" } | null;
  importing: boolean;
  setImporting(open: boolean): void;
  startupError: string | null;
  /** Items with edits not yet on disk (autosave runs 300 ms after the last change). */
  saving: Record<string, boolean>;

  init(): Promise<void>;
  openWorkspace(path: string): Promise<void>;
  reload(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  notify(text: string, kind?: "info" | "error"): void;

  createItem(folder: string, kind: ItemKind, name: string, data?: ItemData): Promise<string>;
  updateItem(path: string, patch: Partial<ItemData> & { name?: string }): void;
  deleteItem(path: string): Promise<void>;
  duplicateItem(path: string): Promise<void>;
  /** Moves to another folder; returns the new path. */
  moveItem(path: string, folder: string): Promise<string>;
  /** Renames the item and its file (slug of the name); returns the new path. */
  renameItem(path: string, name: string): Promise<string>;
  createFolder(path: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;

  saveEnv(env: Environment): Promise<void>;
  createEnv(name: string, vars?: KV[], secrets?: KV[]): Promise<void>;
  /** One-click "New Environment" (unique name), activated if none is. Returns its path. */
  newEnv(): Promise<string>;
  renameEnv(path: string, name: string): Promise<string>;
  deleteEnv(path: string): Promise<void>;
  setActiveEnv(path: string | null): void;
  vars(): Record<string, string>;
  setVars(vals: Record<string, string>): void;
  /** Saves a value as a secret of the active environment (gitignored file); returns the variable name used. */
  storeSecret(name: string, value: string): Promise<string>;

  openTab(id: string): void;
  closeTab(id: string): void;
  setResponse(path: string, r: ResponseState): void;
}

export const COLLECTIONS = "collections";
const ENVIRONMENTS = "environments";
const LOCAL = ".local.json";
/** Lines every workspace .gitignore must contain so secrets never reach git. */
const GITIGNORE = ["*.json.tmp", `*${LOCAL}`];
export const secretsPath = (envPath: string) => envPath.replace(/\.json$/, LOCAL);

export const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

const serialize = (item: Item) => {
  const { path: _p, ...rest } = item;
  return JSON.stringify({ forge: 1, ...rest }, null, 2) + "\n";
};

export const dirname = (p: string) => p.split("/").slice(0, -1).join("/");
export const basename = (p: string) => p.split("/").pop() ?? p;

const timers = new Map<string, number>();

export const useStore = create<State>((set, get) => {
  const uniquePath = (folder: string, name: string) => {
    const taken = new Set(Object.keys(get().items));
    let n = 1;
    let p = `${folder}/${slug(name)}.json`;
    while (taken.has(p)) p = `${folder}/${slug(name)}-${++n}.json`;
    return p;
  };

  /** Renames the file and re-keys everything that refers to the item by path. */
  const relocate = async (from: string, to: string, item: Item) => {
    clearTimeout(timers.get(from));
    await fs.rename(from, to);
    set((s) => {
      const { [from]: _old, ...items } = s.items;
      const { [from]: resp, ...responses } = s.responses;
      return {
        items: { ...items, [to]: { ...item, path: to } as Item },
        responses: resp ? { ...responses, [to]: resp } : responses,
        tabs: s.tabs.map((t) => (t === from ? to : t)),
        active: s.active === from ? to : s.active,
      };
    });
  };

  const persist = (item: Item) =>
    fs
      .write(item.path, serialize(item))
      .then(() => set((s) => (s.saving[item.path] ? { saving: { ...s.saving, [item.path]: false } } : {})))
      .catch((e) => get().notify(`Save failed: ${e}`, "error"));

  return {
    root: null,
    dirs: [],
    items: {},
    envs: [],
    activeEnv: null,
    sessionVars: {},
    tabs: [],
    active: null,
    settings: defaultSettings(),
    responses: {},
    toast: null,
    importing: false,
    startupError: null,
    saving: {},
    setImporting: (importing) => set({ importing }),

    async init() {
      try {
        const saved = JSON.parse(await fs.readSettings());
        const base = defaultSettings();
        const settings: Settings = {
          ...base,
          ...saved,
          providers: { ...base.providers, ...(saved.providers ?? {}) },
          agent: { ...base.agent, ...(saved.agent ?? {}) },
        };
        set({ settings });
        if (settings.appearance) applyAppearance(settings.appearance);
        if (settings.lastWorkspace) await get().openWorkspace(settings.lastWorkspace);
      } catch (e) {
        console.error(e);
        set({ startupError: `Couldn't reopen ${get().settings.lastWorkspace ?? "your last workspace"}: ${e}` });
      }
    },

    async openWorkspace(path) {
      const tree = await fs.open(path);
      const items: Record<string, Item> = {};
      const envs: Environment[] = [];
      const secrets: Record<string, KV[]> = {};
      for (const f of tree.files) {
        let json: any;
        try {
          json = JSON.parse(f.content);
        } catch {
          continue;
        }
        if (f.path.startsWith(`${COLLECTIONS}/`) && json?.kind && json.kind in defaults) {
          const { forge: _v, ...rest } = json;
          items[f.path] = { ...defaults[json.kind as ItemKind](), ...rest, path: f.path } as Item;
        } else if (f.path.startsWith(`${ENVIRONMENTS}/`) && Array.isArray(json?.vars)) {
          if (f.path.endsWith(LOCAL)) secrets[f.path] = json.vars;
          else envs.push({ name: json.name ?? basename(f.path), vars: json.vars, secrets: [], path: f.path });
        }
      }
      for (const e of envs) e.secrets = secrets[secretsPath(e.path)] ?? [];
      const dirs = tree.dirs.filter((d) => d.startsWith(`${COLLECTIONS}/`));
      const isNew = tree.files.length === 0 && tree.dirs.length === 0;
      const prev = get();
      // Saved keys may use the path as typed (e.g. /tmp/x) rather than the resolved one (/private/tmp/x).
      const activeEnv = prev.settings.activeEnv?.[tree.root] || prev.settings.activeEnv?.[path] || null;
      set({
        root: tree.root,
        items,
        dirs,
        envs: envs.sort((a, b) => a.name.localeCompare(b.name)),
        activeEnv: envs.some((e) => e.path === activeEnv) ? activeEnv : null,
        tabs: prev.root === tree.root ? prev.tabs.filter((t) => t.startsWith("::") || items[t]) : [],
        active: prev.root === tree.root ? prev.active : null,
      });
      if (prev.settings.lastWorkspace !== tree.root) await get().saveSettings({ lastWorkspace: tree.root });
      await fs.ensureGitignore(GITIGNORE).catch((e) => get().notify(`Could not update .gitignore: ${e}`, "error"));
      if (isNew) {
        await fs.mkdir(`${COLLECTIONS}/My Collection`);
        await get().createEnv("Local", [{ key: "baseUrl", value: "http://localhost:3000", enabled: true }]);
        await get().reload();
      }
    },

    async reload() {
      const root = get().root;
      if (root) await get().openWorkspace(root);
    },

    async saveSettings(patch) {
      if (patch.appearance) applyAppearance(patch.appearance);
      const settings = { ...get().settings, ...patch };
      set({ settings });
      await fs.writeSettings(JSON.stringify(settings, null, 2));
    },

    notify(text, kind = "info") {
      set({ toast: { text, kind } });
      setTimeout(() => get().toast?.text === text && set({ toast: null }), kind === "error" ? 6000 : 2500);
    },

    async createItem(folder, kind, name, data) {
      const path = uniquePath(folder, name);
      const item = { ...(data ?? defaults[kind]()), name, path } as Item;
      set((s) => ({ items: { ...s.items, [path]: item } }));
      await persist(item);
      get().openTab(path);
      return path;
    },

    updateItem(path, patch) {
      const cur = get().items[path];
      if (!cur) return;
      const next = { ...cur, ...patch } as Item;
      set((s) => ({ items: { ...s.items, [path]: next }, saving: { ...s.saving, [path]: true } }));
      clearTimeout(timers.get(path));
      timers.set(path, window.setTimeout(() => {
        const it = get().items[path];
        if (it) persist(it); // may have been renamed/moved meanwhile
      }, 300));
    },

    async deleteItem(path) {
      await fs.remove(path);
      set((s) => {
        const { [path]: _gone, ...items } = s.items;
        return { items, tabs: s.tabs.filter((t) => t !== path), active: s.active === path ? null : s.active };
      });
    },

    async duplicateItem(path) {
      const it = get().items[path];
      if (!it) return;
      const { path: _p, name, ...data } = it;
      await get().createItem(dirname(path), it.kind, `${name} copy`, structuredClone(data) as ItemData);
    },

    async moveItem(path, folder) {
      if (dirname(path) === folder) return path;
      const it = get().items[path];
      const to = uniquePath(folder, it.name);
      await relocate(path, to, it);
      return to;
    },

    async renameItem(path, name) {
      const it = get().items[path];
      name = name.trim();
      if (!it || !name) return path;
      if (name === it.name) return path;
      // Keep the file name in step with the display name so the repo stays readable.
      const want = `${dirname(path)}/${slug(name)}.json`;
      const to = want === path || slug(name) === slug(it.name) ? path : uniquePath(dirname(path), name);
      const next = { ...it, name, path: to } as Item;
      if (to === path) {
        set((s) => ({ items: { ...s.items, [path]: next } }));
        await persist(next);
        return path;
      }
      await relocate(path, to, next);
      await persist(next);
      return to;
    },

    async createFolder(path) {
      await fs.mkdir(path);
      set((s) => ({ dirs: [...new Set([...s.dirs, path])].sort() }));
    },

    async deleteFolder(path) {
      await fs.remove(path);
      await get().reload();
    },

    async saveEnv(env) {
      const prev = get().envs.find((e) => e.path === env.path);
      set((s) => ({ envs: s.envs.map((e) => (e.path === env.path ? env : e)) }));
      await fs.write(env.path, JSON.stringify({ name: env.name, vars: env.vars }, null, 2) + "\n");
      if (env.secrets.length || prev?.secrets.length)
        await fs.write(secretsPath(env.path), JSON.stringify({ name: env.name, vars: env.secrets }, null, 2) + "\n");
    },

    async createEnv(name, vars = [], secrets = []) {
      const env: Environment = { name, vars, secrets, path: `${ENVIRONMENTS}/${slug(name)}.json` };
      if (get().envs.some((e) => e.path === env.path)) throw new Error(`Environment ${name} exists`);
      set((s) => ({ envs: [...s.envs, env].sort((a, b) => a.name.localeCompare(b.name)) }));
      await get().saveEnv(env);
      if (!get().activeEnv) get().setActiveEnv(env.path);
    },

    async newEnv() {
      const taken = new Set(get().envs.map((e) => e.path));
      let name = "New Environment";
      for (let i = 2; taken.has(`${ENVIRONMENTS}/${slug(name)}.json`); i++) name = `New Environment ${i}`;
      await get().createEnv(name, [{ key: "baseUrl", value: "", enabled: true }]);
      return `${ENVIRONMENTS}/${slug(name)}.json`;
    },

    async renameEnv(path, name) {
      const env = get().envs.find((e) => e.path === path);
      name = name.trim();
      if (!env || !name || name === env.name) return path;
      const to = `${ENVIRONMENTS}/${slug(name)}.json`;
      if (to !== path && get().envs.some((e) => e.path === to)) throw new Error(`Environment ${name} exists`);
      const renamed = { ...env, name, path: to };
      if (to !== path) {
        await fs.remove(path);
        await fs.remove(secretsPath(path)).catch(() => {});
      }
      set((s) => ({ envs: s.envs.map((e) => (e.path === path ? renamed : e)).sort((a, b) => a.name.localeCompare(b.name)) }));
      await get().saveEnv(renamed);
      if (get().activeEnv === path) get().setActiveEnv(to);
      return to;
    },

    async deleteEnv(path) {
      await fs.remove(path);
      await fs.remove(secretsPath(path)).catch(() => {});
      set((s) => ({ envs: s.envs.filter((e) => e.path !== path), activeEnv: s.activeEnv === path ? null : s.activeEnv }));
    },

    setActiveEnv(path) {
      const { root, settings } = get();
      set({ activeEnv: path });
      if (root) get().saveSettings({ activeEnv: { ...settings.activeEnv, [root]: path ?? "" } });
    },

    vars() {
      const { envs, activeEnv, sessionVars } = get();
      const env = envs.find((e) => e.path === activeEnv);
      return { ...sessionVars, ...(env ? { ...varsOf(env.vars), ...varsOf(env.secrets) } : {}) };
    },

    async storeSecret(name, value) {
      const { envs, activeEnv } = get();
      let env = envs.find((e) => e.path === activeEnv);
      if (!env) {
        if (envs.length) throw new Error("Choose an environment first (top right), so the secret has somewhere to live.");
        await get().createEnv("Local", [], [{ key: name, value, enabled: true }]);
        return name;
      }
      // Reuse the name if it already holds this value; otherwise pick a free one.
      const taken = new Map([...env.vars, ...env.secrets].map((v) => [v.key, v.value]));
      let key = name;
      for (let i = 2; taken.has(key) && taken.get(key) !== value; i++) key = `${name}${i}`;
      if (taken.get(key) !== value) {
        env = { ...env, secrets: [...env.secrets, { key, value, enabled: true }] };
        await get().saveEnv(env);
      }
      return key;
    },

    /** Writes captured values into the active environment's gitignored secrets file, or session vars when none is active. */
    setVars(vals) {
      if (!Object.keys(vals).length) return;
      const { envs, activeEnv } = get();
      const env = envs.find((e) => e.path === activeEnv);
      if (!env) {
        // First capture in a workspace without environments: make "Local" so the value persists.
        if (!envs.length && get().root) {
          get()
            .createEnv("Local", [], Object.entries(vals).map(([key, value]) => ({ key, value, enabled: true })))
            .then(() => get().notify("Created the Local environment to hold captured values"))
            .catch(() => set((s) => ({ sessionVars: { ...s.sessionVars, ...vals } })));
          return;
        }
        set((s) => ({ sessionVars: { ...s.sessionVars, ...vals } }));
        return;
      }
      const secrets = [...env.secrets];
      for (const [key, value] of Object.entries(vals)) {
        const i = secrets.findIndex((v) => v.key === key);
        if (i >= 0) secrets[i] = { ...secrets[i], value };
        else secrets.push({ key, value, enabled: true });
      }
      get().saveEnv({ ...env, secrets });
    },

    openTab(id) {
      set((s) => ({ tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id }));
    },

    closeTab(id) {
      set((s) => {
        const i = s.tabs.indexOf(id);
        const tabs = s.tabs.filter((t) => t !== id);
        const active = s.active === id ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.active;
        return { tabs, active };
      });
    },

    setResponse(path, r) {
      set((s) => ({ responses: { ...s.responses, [path]: r } }));
    },
  };
});
