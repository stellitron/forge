import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../ipc", () => ({ fs: { write: async () => {}, mkdir: async () => {}, remove: async () => {}, writeSettings: async () => {}, readAppData: async () => "", writeAppData: async () => {} }, http: {}, uid: () => "x", afterSend: new Set() }));
vi.stubGlobal("window", globalThis);
import { WORKSPACE_TOOLS, type ToolCtx } from "../../agent/workspaceTools";
import { useHistory } from "../history";
import { useStore } from "../store";
import { defaults, type HttpResponse, type Item } from "../types";

const run = (name: string, input: unknown, ctx: ToolCtx) => WORKSPACE_TOOLS.find((t) => t.spec.name === name)!.run(input, ctx);
const asked: { summary: string; always?: boolean }[] = [];
let answer = true;
const ctx: ToolCtx = { client: "Ask", approve: async (summary, o) => (asked.push({ summary, always: o?.always }), answer) };
const res = (body: unknown, status = 200): HttpResponse => ({ status, statusText: "OK", httpVersion: "", url: "", headers: [{ key: "Content-Type", value: "application/json", enabled: true }], body: JSON.stringify(body), bodyBase64: false, size: 1, timeMs: 10, ttfbMs: 1 });

beforeEach(async () => {
  asked.length = 0;
  answer = true;
  const item = { ...defaults.http(), name: "List orders", path: "collections/Shop/list.json", url: "https://api.shop.test/orders" } as Item;
  useStore.setState({
    root: "/ws",
    items: { [item.path]: item },
    dirs: ["collections/Shop"],
    folders: {},
    envs: [{ name: "Dev", path: "environments/dev.json", vars: [], secrets: [] }],
    activeEnv: "environments/dev.json",
    responses: {},
    trustPrints: new Set(),
    trustEverything: false,
    settings: { ...useStore.getState().settings, server: undefined },
  });
  useStore.getState().trust([item.path]);
  useHistory.setState({ root: "/ws", entries: [] });
});

describe("assistant tools that change the workspace", () => {
  it("update_request changes fields after approval, and the edit isn't trusted", async () => {
    const before = useStore.getState().items["collections/Shop/list.json"];
    expect(useStore.getState().isTrusted(before)).toBe(true);
    const out = await run("update_request", { path: "Shop/list.json", set: { headers: [{ key: "X-Tenant", value: "acme" }], assertions: [{ source: "status", path: "", op: "eq", value: "200" }], postScript: "pm.test('ok', () => {})" } }, ctx);
    expect(out).toMatch(/Updated headers, assertions, postScript/);
    expect(asked[0].summary).toMatch(/Change headers, assertions, postScript of "List orders"/);
    const after = useStore.getState().items["collections/Shop/list.json"] as any;
    expect(after.headers).toEqual([{ key: "X-Tenant", value: "acme", enabled: true }]);
    expect(after.postScript).toBe("pm.test('ok', () => {})");
    expect(useStore.getState().isTrusted(after)).toBe(false);
  });

  it("update_request refuses literal secrets and invalid values, and respects a no", async () => {
    await expect(run("update_request", { path: "Shop/list.json", set: { auth: { type: "bearer", token: "sk_live_abcdef123" } } }, ctx)).rejects.toThrow(/literal secret/);
    await expect(run("update_request", { path: "Shop/list.json", set: { headers: [{ key: "Authorization", value: "Bearer abcdef123456" }] } }, ctx)).rejects.toThrow(/literal secret/);
    await expect(run("update_request", { path: "Shop/list.json", set: { assertions: [{ source: "vibes", op: "eq" }] } }, ctx)).rejects.toThrow(/source must be/);
    expect(await run("update_request", { path: "Shop/list.json", set: { auth: { type: "bearer", token: "{{token}}" } } }, ctx)).toMatch(/Updated auth/);
    answer = false;
    await expect(run("update_request", { path: "Shop/list.json", set: { url: "https://elsewhere.test" } }, ctx)).rejects.toThrow(/declined/);
    expect((useStore.getState().items["collections/Shop/list.json"] as any).url).toBe("https://api.shop.test/orders");
  });

  it("edits still ask when the 'approve writes' switch for connected apps is off", async () => {
    useStore.setState({ settings: { ...useStore.getState().settings, server: { enabled: true, port: 1, token: "", approveWrites: false } } });
    for (const [tool, input] of [
      ["update_request", { path: "Shop/list.json", set: { url: "https://elsewhere.test" } }],
      ["folder_settings", { path: "Shop", set: { preScript: "pm.request.url = 'x'" } }],
      ["set_variable", { name: "baseUrl", value: "https://elsewhere.test" }],
      ["import_collection", { content: JSON.stringify({ info: { name: "P" }, item: [{ name: "r", request: { method: "GET", url: "https://p.test" } }] }) }],
    ] as const) {
      answer = false;
      await expect(run(tool, input, ctx)).rejects.toThrow(/declined/);
    }
    expect(asked).toHaveLength(4);
    expect((useStore.getState().items["collections/Shop/list.json"] as any).url).toBe("https://api.shop.test/orders");
  });

  it("delete_items always asks, even when writes don't need approval", async () => {
    useStore.setState({ settings: { ...useStore.getState().settings, server: { enabled: false, port: 1, token: "", approveWrites: false } } });
    answer = false;
    await expect(run("delete_items", { paths: ["Shop/list.json"] }, ctx)).rejects.toThrow(/declined/);
    expect(asked[0].always).toBe(true);
    expect(useStore.getState().items["collections/Shop/list.json"]).toBeTruthy();
  });

  it("folder_settings reads and writes, keeping secrets out of committed variables", async () => {
    expect(JSON.parse(await run("folder_settings", { path: "Shop" }, ctx))).toEqual({ auth: { type: "inherit" }, headers: [], vars: [] });
    await expect(run("folder_settings", { path: "Shop", set: { vars: [{ key: "apiToken", value: "abcdef123456" }] } }, ctx)).rejects.toThrow(/looks secret/);
    await run("folder_settings", { path: "Shop", set: { auth: { type: "bearer", token: "{{token}}" }, vars: [{ key: "baseUrl", value: "https://api.shop.test" }] } }, ctx);
    expect(useStore.getState().folders["collections/Shop"]).toMatchObject({ auth: { type: "bearer", token: "{{token}}" }, vars: [{ key: "baseUrl", value: "https://api.shop.test", enabled: true }] });
    // AI-written folder settings don't vouch for the requests below them.
    expect(useStore.getState().isFolderTrusted("collections/Shop")).toBe(false);
    await expect(run("folder_settings", { path: "Nope" }, ctx)).rejects.toThrow(/No folder/);
  });

  it("set_variable files secrets as secrets and never echoes their values", async () => {
    const out = await run("set_variable", { name: "apiToken", value: "tok-1234567890" }, ctx);
    expect(out).toBe("Set {{apiToken}} as a secret in Dev.");
    expect(asked[0].summary).not.toContain("tok-1234567890");
    expect(useStore.getState().envs[0].secrets).toEqual([{ key: "apiToken", value: "tok-1234567890", enabled: true }]);
    await run("set_variable", { name: "region", value: "eu" }, ctx);
    expect(useStore.getState().envs[0].vars).toEqual([{ key: "region", value: "eu", enabled: true }]);
    await expect(run("set_variable", { name: "bad name!", value: "x" }, ctx)).rejects.toThrow(/letters, digits/);
  });

  it("compare_responses reports field changes against the previous send", async () => {
    const path = "collections/Shop/list.json";
    const first = useHistory.getState().add({ path, name: "List orders", source: "request", req: { method: "GET", url: "x", headers: [] }, res: res({ total: 2, items: [{ price: 10 }] }) });
    const latest = useHistory.getState().add({ path, name: "List orders", source: "request", req: { method: "GET", url: "x", headers: [] }, res: res({ total: 3, items: [{ price: 12 }] }) });
    useStore.setState({ responses: { [path]: { res: res({ total: 3, items: [{ price: 12 }] }), historyId: latest!.id } } });
    const out = await run("compare_responses", { path: "Shop/list.json" }, ctx);
    expect(out).toContain("2 body changes:");
    expect(out).toContain("~ $.total: 2 → 3");
    expect(out).toContain("~ $.items[0].price: 10 → 12");
    expect(first).toBeTruthy();
  });

  it("import_collection brings a pasted collection in, untrusted, after approval", async () => {
    const postman = { info: { name: "Pets" }, item: [{ name: "List pets", request: { method: "GET", url: "https://pets.test/pets" } }] };
    const out = await run("import_collection", { content: JSON.stringify(postman) }, ctx);
    expect(out).toMatch(/Imported 1 request\(s\) into Pets/);
    expect(asked[0].summary).toMatch(/Import 1 request\(s\) into Pets/);
    const imported = Object.values(useStore.getState().items).find((i) => i.name === "List pets")!;
    expect(useStore.getState().isTrusted(imported)).toBe(false);
  });
});
