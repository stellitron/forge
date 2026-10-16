import { create } from "zustand";
import { fs } from "./ipc";
import { varsOf } from "./eval";
import { applyAppearance, type Appearance } from "./theme";
import { envFingerprint, fingerprint, folderFingerprint } from "./trust";
import { defaults, emptyFolder, type FolderSettings, type AssertionResult, type Environment, type HttpResponse, type Item, type ItemData, type ItemKind, type KV } from "./types";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "gemini" | "azure" | "bedrock" | "ollama" | "custom" | "request";

export interface Settings {
  lastWorkspace?: string;
  activeEnv?: Record<string, string>; // workspace root -> env path
  providers: Record<ProviderId, { apiKey: string; baseUrl: string }>;
  /** provider "" means AI isn't set up yet; Forge works fully without it. */
  agent: {
    provider: ProviderId | "";
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    /** Workspace path of the saved request the "request" provider sends each turn through. */
    request?: string;
  };
  /**
   * Workspace root → fingerprints of the requests and environments you trust (see trust.ts).
   * Kept here, outside the workspace, so a collection's own files can't grant themselves trust.
   */
  trust?: Record<string, { prints: string[] }>;
  /** Forge's own MCP + A2A server for Claude, VS Code, Cursor, Copilot and A2A clients. */
  server?: { enabled: boolean; port: number; token: string; approveWrites: boolean };
  ai?: { autoName?: boolean };
  /** Cookies are kept per environment between sessions unless turned off. */
  cookies?: { persist: boolean };
  /** Request history; on unless turned off. */
  history?: { enabled: boolean };
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
  if (id === "request") return s.agent.request ? { ready: true, label: def.label } : { ready: false, label: def.label, missing: "Pick a request to use as the AI model in Settings" };
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
  request: {
    label: "From a request",
    baseUrl: "",
    model: "",
    needsKey: false,
    help: "Each AI turn is sent through a saved request with its URL, headers and auth, so a company gateway that works in Forge works for AI too. The body format (Anthropic, Bedrock Converse or OpenAI chat) is taken from the request's JSON body; other fields in it, like anthropic_version or temperature, are kept.",
  },
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
  /** The history entry recording this response, so Compare can leave it out. */
  historyId?: string;
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

  /** Folder settings by folder path (see FolderSettings). */
  folders: Record<string, FolderSettings>;
  /** `trusted: false` for settings you didn't write (imports). */
  saveFolder(path: string, settings: FolderSettings, opts?: { trusted?: boolean }): Promise<void>;
  /** The folders above an item that can pass settings down, outermost first. */
  folderChain(path: string): string[];
  /** Variables for a request: its collection and folder variables, then the environment's. */
  varsFor(path: string): Record<string, string>;
  isFolderTrusted(path: string): boolean;
  /** `trusted: false` for items you didn't write (imports, AI): they don't vouch for their hosts. */
  createItem(folder: string, kind: ItemKind, name: string, data?: ItemData, opts?: { trusted?: boolean }): Promise<string>;
  /** `trusted: false` for changes you didn't make (the AI): the item stops vouching for its hosts. */
  updateItem(path: string, patch: Partial<ItemData> & { name?: string }, opts?: { trusted?: boolean }): void;
  deleteItem(path: string): Promise<void>;
  duplicateItem(path: string): Promise<void>;
  /** Moves to another folder; returns the new path. */
  moveItem(path: string, folder: string): Promise<string>;
  /** Renames the item and its file (slug of the name); returns the new path. */
  renameItem(path: string, name: string): Promise<string>;
  createFolder(path: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;

  /** `trust`: the change comes from you (the environment editor), so its URLs count as yours. */
  saveEnv(env: Environment, opts?: { trust?: boolean }): Promise<void>;
  createEnv(name: string, vars?: KV[], secrets?: KV[], opts?: { trusted?: boolean }): Promise<void>;

  /** Fingerprints of trusted content in this workspace (see trust.ts). */
  trustPrints: Set<string>;
  /** Whether you've answered "trust this workspace?" for it. */
  trustAsked: boolean;
  /** The CLI runs a checked-out repo, which it trusts like any test runner trusts its repo. */
  trustEverything: boolean;
  isTrusted(item: Item): boolean;
  isEnvTrusted(env: Environment): boolean;
  /** Trusts the items under these folders or paths, and these environments, as they are now. */
  trust(paths: string[], envPaths?: string[]): void;
  /** Answers the first-open question: trust everything as it is now, or nothing yet. */
  decideWorkspaceTrust(trusted: boolean): void;
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
  /** Closes several tabs at once; the active tab stays if it isn't one of them. */
  closeTabs(ids: string[]): void;
  setResponse(path: string, r: ResponseState): void;
}

export const COLLECTIONS = "collections";
/** Folder settings file name; request files are slugs, which never start with "_". */
export const FOLDER_FILE = "_folder.json";
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

  // Fingerprints are cached per object; items and environments are replaced, never mutated.
  const prints = new WeakMap<object, string>();
  const fp = (it: Item) => prints.get(it) ?? (prints.set(it, fingerprint(it)), prints.get(it)!);
  const efp = (e: Environment) => prints.get(e) ?? (prints.set(e, envFingerprint(e)), prints.get(e)!);
  const ffp = (path: string, f: FolderSettings) => prints.get(f) ?? (prints.set(f, folderFingerprint(path, f)), prints.get(f)!);
  const folderPrints = () => Object.entries(get().folders).map(([p, f]) => ffp(p, f));
  const folderTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let trustTimer: ReturnType<typeof setTimeout> | undefined;
  const saveTrust = () => {
    clearTimeout(trustTimer);
    trustTimer = setTimeout(() => {
      const { root, trustPrints, settings } = get();
      if (!root || get().trustEverything) return;
      get().saveSettings({ trust: { ...settings.trust, [root]: { prints: [...trustPrints].slice(-20000) } } }).catch(() => {});
    }, 500);
  };
  /** Records `next` as trusted, dropping `prev`'s print unless something else still has it. */
  const addTrust = (next: string[], prev: string[] = []) => {
    const s = new Set(get().trustPrints);
    const inUse = new Set([...Object.values(get().items).map(fp), ...get().envs.map(efp), ...folderPrints()]);
    for (const p of prev) if (!next.includes(p) && !inUse.has(p)) s.delete(p);
    next.forEach((p) => s.add(p));
    set({ trustPrints: s });
    saveTrust();
  };

  const persist = (item: Item) =>
    fs
      .write(item.path, serialize(item))
      .then(() => set((s) => (s.saving[item.path] ? { saving: { ...s.saving, [item.path]: false } } : {})))
      .catch((e) => get().notify(`Save failed: ${e}`, "error"));

  return {
    root: null,
    folders: {},
    trustPrints: new Set(),
    trustAsked: true,
    trustEverything: false,
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
      const folders: Record<string, FolderSettings> = {};
      const envs: Environment[] = [];
      const secrets: Record<string, KV[]> = {};
      for (const f of tree.files) {
        let json: any;
        try {
          json = JSON.parse(f.content);
        } catch {
          continue;
        }
        if (f.path.startsWith(`${COLLECTIONS}/`) && f.path.endsWith(`/${FOLDER_FILE}`) && json?.kind === "folder") {
          const { forge: _v, kind: _k, ...rest } = json;
          folders[dirname(f.path)] = { ...emptyFolder(), ...rest };
        } else if (f.path.startsWith(`${COLLECTIONS}/`) && json?.kind && json.kind in defaults) {
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
      const record = prev.settings.trust?.[tree.root];
      set({
        root: tree.root,
        folders,
        trustPrints: new Set(record?.prints ?? []),
        // A workspace you just created is yours; anything else is asked about once.
        trustAsked: !!record || isNew || prev.trustEverything,
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
        saveTrust();
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

    async createItem(folder, kind, name, data, opts = {}) {
      const path = uniquePath(folder, name);
      const item = { ...(data ?? defaults[kind]()), name, path } as Item;
      set((s) => ({ items: { ...s.items, [path]: item } }));
      if (opts.trusted !== false) addTrust([fp(item)]);
      await persist(item);
      get().openTab(path);
      return path;
    },

    updateItem(path, patch, opts = {}) {
      const cur = get().items[path];
      if (!cur) return;
      const next = { ...cur, ...patch } as Item;
      set((s) => ({ items: { ...s.items, [path]: next }, saving: { ...s.saving, [path]: true } }));
      // Changing what a request does means you've looked at it. Names and descriptions aren't
      // part of the fingerprint, so an AI-written description trusts nothing. (After the set, so
      // the superseded print can be dropped.)
      if (fp(next) !== fp(cur) && opts.trusted !== false) addTrust([fp(next)], [fp(cur)]);
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

    async saveEnv(env, opts = {}) {
      const prev = get().envs.find((e) => e.path === env.path);
      set((s) => ({ envs: s.envs.map((e) => (e.path === env.path ? env : e)) }));
      if (opts.trust) addTrust([efp(env)], prev ? [efp(prev)] : []);
      await fs.write(env.path, JSON.stringify({ name: env.name, vars: env.vars }, null, 2) + "\n");
      if (env.secrets.length || prev?.secrets.length)
        await fs.write(secretsPath(env.path), JSON.stringify({ name: env.name, vars: env.secrets }, null, 2) + "\n");
    },

    async createEnv(name, vars = [], secrets = [], opts = {}) {
      const env: Environment = { name, vars, secrets, path: `${ENVIRONMENTS}/${slug(name)}.json` };
      if (opts.trusted !== false) addTrust([efp(env)]);
      if (get().envs.some((e) => e.path === env.path)) throw new Error(`Environment ${name} exists`);
      set((s) => ({ envs: [...s.envs, env].sort((a, b) => a.name.localeCompare(b.name)) }));
      await get().saveEnv(env);
      if (!get().activeEnv) get().setActiveEnv(env.path);
    },

    isTrusted(item) {
      const { trustEverything, trustPrints, isFolderTrusted, folderChain } = get();
      return trustEverything || (trustPrints.has(fp(item)) && folderChain(item.path).every(isFolderTrusted));
    },

    isFolderTrusted(path) {
      const f = get().folders[path];
      return !f || get().trustEverything || get().trustPrints.has(ffp(path, f));
    },

    folderChain(path) {
      // collections/Shop/Users/list.json → collections/Shop, collections/Shop/Users
      const parts = path.split("/").slice(1, -1);
      return parts.map((_, i) => [COLLECTIONS, ...parts.slice(0, i + 1)].join("/"));
    },

    varsFor(path) {
      const out: Record<string, string> = {};
      for (const f of get().folderChain(path)) for (const v of get().folders[f]?.vars ?? []) if (v.enabled && v.key) out[v.key] = v.value;
      return { ...out, ...get().vars() };
    },

    async saveFolder(path, settings, opts = {}) {
      const prev = get().folders[path];
      set((s) => ({ folders: { ...s.folders, [path]: settings } }));
      if (opts.trusted !== false) addTrust([ffp(path, settings)], prev ? [ffp(path, prev)] : []);
      clearTimeout(folderTimers.get(path));
      // Typing in the folder editor saves once it pauses, like requests.
      await new Promise<void>((resolve) =>
        folderTimers.set(
          path,
          setTimeout(() => {
            const cur = get().folders[path];
            if (cur) fs.write(`${path}/${FOLDER_FILE}`, JSON.stringify({ forge: 1, kind: "folder", ...cur }, null, 2) + "\n").catch((e) => get().notify(`Save failed: ${e}`, "error"));
            resolve();
          }, opts.trusted === false ? 0 : 300),
        ),
      );
    },

    isEnvTrusted(env) {
      return get().trustEverything || get().trustPrints.has(efp(env));
    },

    trust(paths, envPaths = []) {
      const under = (p: string) => paths.some((f) => p === f || p.startsWith(`${f}/`));
      // A request is only as trusted as the folders above it, so trusting it trusts their settings.
      const above = new Set(paths.flatMap((p) => get().folderChain(p.endsWith(".json") ? p : `${p}/x`)));
      const folders = Object.entries(get().folders).filter(([p]) => under(p) || above.has(p));
      addTrust([...Object.values(get().items).filter((i) => under(i.path)).map(fp), ...folders.map(([p, f]) => ffp(p, f)), ...get().envs.filter((e) => envPaths.includes(e.path)).map(efp)]);
    },

    decideWorkspaceTrust(trusted) {
      set({ trustAsked: true });
      if (trusted) addTrust([...Object.values(get().items).map(fp), ...get().envs.map(efp), ...folderPrints()]);
      else saveTrust();
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

    closeTabs(ids) {
      set((s) => {
        const gone = new Set(ids);
        const tabs = s.tabs.filter((t) => !gone.has(t));
        const kept = s.active && !gone.has(s.active);
        // Otherwise the nearest tab left of the old active one.
        const left = s.tabs.slice(0, Math.max(0, s.tabs.indexOf(s.active ?? ""))).filter((t) => !gone.has(t));
        return { tabs, active: kept ? s.active : (left[left.length - 1] ?? tabs[0] ?? null) };
      });
    },

    setResponse(path, r) {
      set((s) => ({ responses: { ...s.responses, [path]: r } }));
    },
  };
});
