/**
 * Dev-only browser preview: lets the UI run in a normal browser (npm run dev) with an
 * in-memory workspace and fetch-backed HTTP, so layouts can be checked without the Rust shell.
 * MCP/WebSocket/stdio need the real app.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const files = new Map<string, string>();
const dirs = new Set<string>();
let settings = "{}";

function seed() {
  const put = (p: string, v: unknown) => files.set(p, JSON.stringify(v, null, 2));
  dirs.add("collections").add("collections/Demo API").add("collections/Demo API/Users").add("environments");
  put("environments/local.json", { name: "Local", vars: [{ key: "baseUrl", value: "https://jsonplaceholder.typicode.com", enabled: true }] });
  put("collections/Demo API/Users/list-users.json", {
    forge: 1, kind: "http", name: "List users", method: "GET", url: "{{baseUrl}}/users", params: [{ key: "_limit", value: "3", enabled: true }], headers: [],
    auth: { type: "none" }, bodyMode: "none", body: "", form: [], multipart: [], graphql: { query: "", variables: "{}" },
    assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "200" }, { enabled: true, source: "jsonpath", path: "$.length", op: "eq", value: "3" }],
    extractions: [{ enabled: true, variable: "userId", source: "jsonpath", path: "$[0].id" }],
    settings: { timeoutMs: 30000, followRedirects: true, insecure: false },
  });
  put("collections/Demo API/Users/create-user.json", {
    forge: 1, kind: "http", name: "Create user", method: "POST", url: "{{baseUrl}}/users", params: [], headers: [], auth: { type: "bearer", token: "{{token}}" },
    bodyMode: "json", body: '{\n  "name": "Ada",\n  "email": "{{$randomEmail}}"\n}', form: [], multipart: [], graphql: { query: "", variables: "{}" },
    assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "201" }], extractions: [], settings: { timeoutMs: 30000, followRedirects: true, insecure: false },
  });
  put("collections/Demo API/everything-server.json", { forge: 1, kind: "mcp", name: "Everything MCP", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-everything", env: [], cwd: "", url: "", headers: [] });
  put("collections/Demo API/travel-agent.json", { forge: 1, kind: "a2a", name: "Travel agent", url: "http://localhost:10000", headers: [] });
  put("collections/Demo API/qa-agent.json", { forge: 1, kind: "agent", name: "Users API QA", goal: "Test the users API: CRUD, validation, error handling.", baseUrl: "{{baseUrl}}", specUrl: "", mcpRef: "", a2aRef: "", maxSteps: 30, approveMutations: true });
  put("collections/Demo API/site-check.json", { forge: 1, kind: "web", name: "Homepage check", url: "https://example.com", maxLinks: 20 });
  // ?many=1 adds a long collection, for checking scrolling.
  if (new URLSearchParams(location.search).get("many") === "1") {
    for (const folder of ["pet", "store", "user"]) {
      dirs.add(`collections/Petstore/${folder}`).add("collections/Petstore");
      for (let i = 1; i <= 20; i++)
        put(`collections/Petstore/${folder}/req-${i}.json`, { forge: 1, kind: "http", name: `${folder} request ${i}`, method: i % 3 ? "GET" : "POST", url: `{{baseUrl}}/${folder}/${i}`, params: [], headers: [], auth: { type: "none" }, bodyMode: "none", body: "" });
    }
  }
  // ?tour=0 skips the first-run guide, ?theme=light|dark and ?palette=forest pick the look (used by scripts/screenshots.mjs).
  const q = new URLSearchParams(location.search);
  const theme = q.get("theme");
  settings = JSON.stringify({
    lastWorkspace: "/preview/workspace",
    activeEnv: { "/preview/workspace": "environments/local.json" },
    ...(q.get("tour") === "0" ? { onboarded: true } : {}),
    ...(theme ? { appearance: { mode: theme, palette: q.get("palette") ?? "forge" } } : {}),
    // ?ai=demo marks AI as set up with a placeholder key, so the Ask UI can be checked without calling a model.
    ...(q.get("ai") === "demo" ? { agent: { provider: "openai", model: "demo", effort: "high" }, providers: { openai: { apiKey: "demo-not-a-key", baseUrl: "" } } } : {}),
  });
}

async function send(request: any) {
  const t0 = performance.now();
  const headers = Object.fromEntries((request.headers ?? []).map((h: any) => [h.key, h.value]));
  const body = request.body?.type === "raw" ? request.body.content : undefined;
  const r = await fetch(request.url, { method: request.method, headers, body });
  const ttfb = performance.now() - t0;
  const text = await r.text();
  return {
    status: r.status, statusText: r.statusText, httpVersion: "HTTP/1.1", url: r.url,
    headers: [...r.headers].map(([key, value]) => ({ key, value, enabled: true })),
    body: text, bodyBase64: false, size: new Blob([text]).size, timeMs: performance.now() - t0, ttfbMs: ttfb,
  };
}

export function installPreview() {
  seed();
  mockWindows("main");
  mockIPC(
    async (cmd, args: any) => {
      switch (cmd) {
        case "settings_read":
          return settings;
        case "settings_write":
          settings = args.content;
          return;
        case "workspace_open":
          return { root: "/preview/workspace", dirs: [...dirs].sort(), files: [...files].map(([path, content]) => ({ path, content })) };
        case "workspace_write":
          files.set(args.path, args.content);
          return;
        case "workspace_mkdir":
          dirs.add(args.path);
          return;
        case "workspace_delete":
          files.delete(args.path);
          for (const f of [...files.keys()]) if (f.startsWith(`${args.path}/`)) files.delete(f);
          for (const d of [...dirs]) if (d === args.path || d.startsWith(`${args.path}/`)) dirs.delete(d);
          return;
        case "workspace_ensure_gitignore":
          return;
        case "workspace_rename":
          files.set(args.to, files.get(args.from)!);
          files.delete(args.from);
          return;
        case "http_send":
          return send(args.request);
        case "http_cancel":
        case "http_reset_cookies":
          return true;
        case "server_stop":
          return { running: false, url: null };
        case "server_start":
          throw new Error("Browser preview: the Forge server needs the desktop app (npm run app).");
        case "import_read":
          return [];
        case "workspace_write_bytes":
          return `/preview/${args.path}`;
        case "file_save":
          return null;
        case "mcp_connect":
        case "ws_connect":
          throw new Error("Browser preview: MCP and WebSocket need the desktop app (npm run app).");
        default:
          if (cmd.startsWith("plugin:event|")) return 0;
          if (cmd.startsWith("plugin:dialog|")) return cmd.endsWith("ask") ? window.confirm(args.message) : null;
          throw new Error(`Browser preview does not implement ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
}
