import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => import("../../cli/tauriShim"));
vi.mock("@tauri-apps/api/event", () => import("../../cli/tauriShim"));
vi.mock("@tauri-apps/plugin-opener", () => import("../../cli/tauriShim"));
vi.stubGlobal("window", globalThis);
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../../cli/main";
import { effectiveItem, inheritedHeaders, resolveAuth, scriptChain } from "../inherit";
import { knownHosts } from "../../agent/egress";
import { useStore } from "../store";
import { defaults, emptyFolder, type FolderSettings, type Item } from "../types";

const folder = (p: Partial<FolderSettings>): FolderSettings => ({ ...emptyFolder(), ...p });
const req = (path: string, extra: object = {}) => ({ ...defaults.http(), name: path, path, url: "{{baseUrl}}/x", ...extra }) as Item & ReturnType<typeof defaults.http>;

describe("inheritance", () => {
  const folders = {
    "collections/Shop": folder({ auth: { type: "bearer", token: "{{token}}" }, headers: [{ key: "X-Tenant", value: "acme", enabled: true }, { key: "Accept", value: "application/json", enabled: true }], vars: [{ key: "baseUrl", value: "https://shop.test", enabled: true }], preScript: "a()" }),
    "collections/Shop/Admin": folder({ auth: { type: "basic", username: "u", password: "{{pw}}" }, headers: [{ key: "X-Tenant", value: "admin", enabled: true }], postScript: "b()" }),
  };

  it("resolves auth from the nearest folder that sets it", () => {
    expect(resolveAuth("collections/Shop/list.json", { type: "inherit" }, folders)).toEqual({ auth: { type: "bearer", token: "{{token}}" }, from: "collections/Shop" });
    expect(resolveAuth("collections/Shop/Admin/users.json", { type: "inherit" }, folders).from).toBe("collections/Shop/Admin");
    expect(resolveAuth("collections/Other/x.json", { type: "inherit" }, folders)).toEqual({ auth: { type: "none" } });
    expect(resolveAuth("collections/Shop/x.json", { type: "none" }, folders)).toEqual({ auth: { type: "none" } });
  });

  it("merges headers with closer folders and the request winning", () => {
    const own = [{ key: "accept", value: "text/csv", enabled: true }];
    const d = effectiveItem(req("collections/Shop/Admin/users.json", { headers: own }), folders);
    expect(d.headers.map((h) => `${h.key}: ${h.value}`)).toEqual(["X-Tenant: admin", "accept: text/csv"]);
    expect(inheritedHeaders("collections/Shop/Admin/users.json", own, folders)).toEqual([{ key: "X-Tenant", value: "admin", from: "collections/Shop/Admin" }]);
  });

  it("lists scripts outermost first, request last", () => {
    expect(scriptChain("collections/Shop/Admin/users.json", { preScript: "c()" }, "pre", folders).map((s) => s.code)).toEqual(["a()", "c()"]);
    expect(scriptChain("collections/Shop/Admin/users.json", { postScript: "d()" }, "post", folders).map((s) => s.code)).toEqual(["b()", "d()"]);
  });
});

describe("folder settings in the workspace", () => {
  beforeEach(() => {
    useStore.setState({ root: "/ws", items: {}, envs: [], folders: {}, trustPrints: new Set(), trustAsked: true, trustEverything: false, activeEnv: null, sessionVars: {}, settings: { ...useStore.getState().settings, trust: {} } });
  });

  it("gives requests their collection's variables, overridden by the environment", () => {
    useStore.setState({ folders: { "collections/Shop": folder({ vars: [{ key: "baseUrl", value: "https://shop.test", enabled: true }, { key: "v", value: "1", enabled: true }] }) }, envs: [{ name: "E", path: "environments/e.json", vars: [{ key: "v", value: "env", enabled: true }], secrets: [] }], activeEnv: "environments/e.json" });
    expect(useStore.getState().varsFor("collections/Shop/a/b.json")).toMatchObject({ baseUrl: "https://shop.test", v: "env" });
  });

  it("stops trusting requests when their folder's settings change outside Forge", () => {
    const r = req("collections/Shop/list.json");
    useStore.setState({ items: { [r.path]: r }, folders: { "collections/Shop": folder({ vars: [{ key: "baseUrl", value: "https://shop.test", enabled: true }] }) } });
    useStore.getState().trust([r.path]);
    expect([...knownHosts({}, []).keys()]).toContain("shop.test");
    // A pull changes the collection's baseUrl: the request file is untouched, but it now goes elsewhere.
    useStore.setState({ folders: { "collections/Shop": folder({ vars: [{ key: "baseUrl", value: "https://evil.test", enabled: true }] }) } });
    expect(useStore.getState().isTrusted(useStore.getState().items[r.path])).toBe(false);
    expect([...knownHosts({}, []).keys()]).not.toContain("evil.test");
  });
});

describe("folder settings in a real run", () => {
  let server: Server;
  let ws = "";
  const seen: { url: string; auth?: string; tenant?: string }[] = [];
  beforeAll(async () => {
    server = createServer((rq, rs) => {
      seen.push({ url: rq.url ?? "", auth: rq.headers.authorization, tenant: rq.headers["x-tenant"] as string });
      rs.writeHead(rq.headers.authorization === "Bearer col-token" ? 200 : 401, { "content-type": "application/json" });
      rs.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ws = mkdtempSync(join(tmpdir(), "forge-folders-"));
    const write = (rel: string, data: object) => {
      mkdirSync(join(ws, rel, ".."), { recursive: true });
      writeFileSync(join(ws, rel), JSON.stringify(data));
    };
    // No environment at all: the collection carries the base URL, auth and a script that sets the token.
    write("collections/Shop/_folder.json", { forge: 1, kind: "folder", auth: { type: "bearer", token: "{{token}}" }, headers: [{ key: "X-Tenant", value: "acme", enabled: true }], vars: [{ key: "baseUrl", value: base, enabled: true }], preScript: 'const note = "collection";\npm.environment.set("token", "col-token");' });
    write("collections/Shop/Orders/_folder.json", { forge: 1, kind: "folder", auth: { type: "inherit" }, headers: [], vars: [], postScript: 'const note = "folder";\npm.test("folder test", () => pm.response.to.have.status(200));' });
    write("collections/Shop/Orders/list.json", { forge: 1, ...defaults.http(), name: "List", url: "{{baseUrl}}/orders", preScript: 'const note = "request";' });
  });
  afterAll(() => server.close());

  it("sends with the collection's auth, headers and variables, and runs each level's scripts separately", async () => {
    let out = "";
    const code = await cli(["run", "Shop"], { out: (s) => (out += s), err: (s) => (out += s), env: {}, cwd: ws, isTTY: false });
    expect(out).toContain("✓ GET    Shop/Orders/list.json  200");
    expect(code).toBe(0);
    expect(seen).toEqual([{ url: "/orders", auth: "Bearer col-token", tenant: "acme" }]);
  });
});
