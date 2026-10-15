import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => import("../../cli/tauriShim"));
vi.mock("@tauri-apps/api/event", () => import("../../cli/tauriShim"));
vi.mock("@tauri-apps/plugin-opener", () => import("../../cli/tauriShim"));
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../../cli/main";
import { defaults } from "../types";

const TOKEN = "issued-token-7f3a9c";
const SECRET = "ci-secret-5d1e8b";
let server: Server;
let base = "";
let ws = "";

function write(rel: string, data: unknown) {
  const p = join(ws, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}
const req = (name: string, p: object) => ({ forge: 1, ...defaults.http(), name, ...p });

async function run(args: string[], env: Record<string, string> = {}) {
  let out = "";
  let err = "";
  const code = await cli(args, { out: (s) => (out += s), err: (s) => (err += s), env, cwd: ws, isTTY: false });
  return { code, out, err };
}

beforeAll(async () => {
  server = createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      const send = (status: number, data: unknown) => (rs.writeHead(status, { "content-type": "application/json" }), rs.end(JSON.stringify(data)));
      if (rq.url === "/login" && rq.method === "POST") return JSON.parse(body).key === SECRET ? send(200, { token: TOKEN }) : send(401, { error: "bad key" });
      if (rq.url?.startsWith("/orders")) return rq.headers.authorization === `Bearer ${TOKEN}` ? send(200, { items: [{ id: 1 }], echoToken: TOKEN }) : send(401, { error: "no token" });
      if (rq.url?.startsWith("/sku/")) return send(200, { sku: rq.url.slice(5) });
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ws = mkdtempSync(join(tmpdir(), "forge-cli-"));
  write("environments/ci.json", { name: "CI", vars: [{ key: "baseUrl", value: base, enabled: true }] });
  write("collections/Shop/1 Login.json", req("Login", {
    method: "POST", url: "{{baseUrl}}/login", bodyMode: "json", body: '{"key":"{{apiKey}}"}',
    assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "200" }],
    extractions: [{ enabled: true, variable: "token", source: "jsonpath", path: "$.token" }],
  }));
  write("collections/Shop/2 Orders.json", req("List orders", {
    url: "{{baseUrl}}/orders", auth: { type: "bearer", token: "{{token}}" },
    assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "200" }, { enabled: true, source: "jsonpath", path: "$.echoToken", op: "eq", value: "wrong" }],
  }));
  write("collections/Catalog/SKU.json", req("Get SKU", { url: "{{baseUrl}}/sku/{{sku}}", assertions: [{ enabled: true, source: "jsonpath", path: "$.sku", op: "eq", value: "{{sku}}" }] }));
  write("collections/Catalog/server.json", { forge: 1, kind: "mcp", name: "server", transport: "stdio", command: "x", args: "", env: [], cwd: "", url: "", headers: [] });
});
afterAll(() => server.close());

describe("forge CLI", () => {
  it("runs a collection, chains a captured token, and fails on a broken check", async () => {
    const r = await run(["run", "Shop", "--env", "ci"], { FORGE_VAR_apiKey: SECRET });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✓ POST   Shop/1 Login.json  200");
    expect(r.out).toContain("✗ GET    Shop/2 Orders.json  200");
    expect(r.out).toMatch(/✗ .*echoToken.* \(got \*\*\*\)/);
    expect(r.out).toContain("FAIL");
    // Neither the CI secret nor the captured token appears anywhere.
    expect(r.out + r.err).not.toContain(SECRET);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it("exits 0 when everything passes and writes a JUnit report", async () => {
    const r = await run(["run", "Shop/1 Login", "-e", "CI", "--var", `apiKey=${SECRET}`, "--reporter", "junit", "--output", "results.xml"]);
    expect(r.code).toBe(0);
    const xml = readFileSync(join(ws, "results.xml"), "utf8");
    expect(xml).toContain('<testsuite name="Shop" tests="1" failures="0" errors="0"');
    expect(xml).toContain('name="POST Login"');
    expect(xml).not.toContain(SECRET);
  });

  it("runs once per data row and skips non-HTTP items", async () => {
    writeFileSync(join(ws, "skus.csv"), "sku\nA-1\n\"B,2\"\n");
    const r = await run(["run", "Catalog", "--env", "ci", "--data", "skus.csv", "--reporter", "json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.results.map((x: any) => `${x.iteration}:${x.passed}`)).toEqual(["1:true", "2:true"]);
    expect(report.skipped).toEqual([{ path: "Catalog/server.json", kind: "mcp" }]);
    expect(report.summary).toMatchObject({ requests: 2, passed: 2, failed: 0 });
  });

  it("stops at the first failure with --bail", async () => {
    const r = await run(["run", "Shop", "--env", "ci", "--bail"]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("Orders");
  });

  it("reports usage mistakes with exit code 2 and never writes to the workspace", async () => {
    const before = readdirSync(join(ws, "environments")).sort();
    expect((await run(["run", "--env", "nope"])).code).toBe(2);
    expect((await run(["run", "Missing/Folder", "--env", "ci"])).err).toMatch(/Nothing matches "Missing\/Folder"/);
    expect((await run(["frobnicate"])).code).toBe(2);
    expect((await run(["run", "--iterations", "x"])).err).toMatch(/must be a number/);
    expect(readdirSync(join(ws, "environments")).sort()).toEqual(before);
    expect(existsSync(join(ws, "environments/ci.local.json"))).toBe(false);
  });

  it("lists requests", async () => {
    const r = await run(["list"]);
    expect(r.out).toContain("POST    Shop/1 Login");
    expect(r.out).toContain("MCP     Catalog/server");
  });
});
