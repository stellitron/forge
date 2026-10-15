// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, type LangId } from "../codegen";
import type { RawRequest } from "../ipc";
import { importCurl } from "../importers";
import { buildRequest } from "../request";

/** Runs each generated snippet for real against an echo server and checks what arrived. */

let server: Server;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "forge-codegen-"));
const upload = join(dir, "hello.txt");
writeFileSync(upload, "file-contents-123");

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const h = (key: string, value: string) => ({ key, value, enabled: true });

const cases: Record<string, () => RawRequest> = {
  json: () => ({ method: "POST", url: `${base}/users?page=2`, headers: [h("X-Test", "it's \"quoted\""), h("Content-Type", "application/json")], body: { type: "raw", content: '{"name":"Ada","tags":["a","b"],"n":1.5,"ok":true,"none":null}' } }),
  form: () => ({ method: "PUT", url: `${base}/form`, headers: [h("Content-Type", "application/x-www-form-urlencoded")], body: { type: "form", fields: [h("a", "1 2"), h("b", "x&y")] } }),
  multipart: () => ({ method: "POST", url: `${base}/upload`, headers: [], body: { type: "multipart", fields: [h("note", "hi"), { ...h("file", upload), file: true }] } }),
};

// Async on purpose: a sync child would block this process's event loop, and with it the echo server.
const exec = async (cmd: string, args: string[]) => (await promisify(execFile)(cmd, args, { encoding: "utf8", timeout: 60_000 })).stdout;

const runners: Partial<Record<LangId, (code: string) => Promise<string>>> = {
  curl: (c) => exec("sh", ["-c", c + " -s"]),
  fetch: (c) => {
    const f = join(dir, `f${Math.random()}.mjs`);
    writeFileSync(f, c.replace("console.log(res.status, data);", "console.log(JSON.stringify(data));"));
    return exec("node", [f]);
  },
  python: (c) => {
    const f = join(dir, `p${Math.random()}.py`);
    writeFileSync(f, c);
    return exec("python3", ["-I", f]);
  },
  ruby: (c) => {
    const f = join(dir, `r${Math.random()}.rb`);
    writeFileSync(f, c);
    return exec("ruby", [f]);
  },
  java: (c) => {
    const d = mkdtempSync(join(dir, "j"));
    writeFileSync(join(d, "Main.java"), c);
    return exec("java", [join(d, "Main.java")]);
  },
};

/** Pulls the echoed JSON object out of a program's stdout (which may also print a status code). */
const echoed = (out: string) => JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));

describe.each(Object.keys(runners) as LangId[])("%s snippet", { timeout: 90_000 }, (lang) => {
  it("sends JSON with query and tricky headers", async () => {
    const e = echoed(await runners[lang]!(generate(lang, cases.json())));
    expect(e.method).toBe("POST");
    expect(e.url).toBe("/users?page=2");
    expect(e.headers["x-test"]).toBe('it\'s "quoted"');
    expect(JSON.parse(e.body)).toEqual({ name: "Ada", tags: ["a", "b"], n: 1.5, ok: true, none: null });
  });
  it("sends url-encoded forms", async () => {
    const e = echoed(await runners[lang]!(generate(lang, cases.form())));
    expect(e.method).toBe("PUT");
    expect(Object.fromEntries(new URLSearchParams(e.body))).toEqual({ a: "1 2", b: "x&y" });
  });
  // Java's built-in HttpClient has no multipart support; the snippet says so instead.
  it.skipIf(lang === "java")("uploads multipart files", async () => {
    const e = echoed(await runners[lang]!(generate(lang, cases.multipart())));
    expect(e.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(e.body).toContain("file-contents-123");
    expect(e.body).toMatch(/name="note"\r\n\r\nhi/);
  });
});

it("cURL export and import round-trip (including apostrophes)", () => {
  const original = importCurl(`curl -X PATCH 'https://api.x.io/v1/items?id=9' -H 'Authorization: Bearer abc' -H 'Content-Type: application/json' --data-raw '{"a":"it'\\''s"}'`);
  expect(original.body).toBe(`{"a":"it's"}`);
  const back = importCurl(generate("curl", buildRequest(original, {})));
  expect(back).toMatchObject({ method: "PATCH", url: original.url, params: original.params, body: original.body, bodyMode: "json" });
});

it("parses curl pasted into a single-line field (newlines stripped)", () => {
  const d = importCurl(`curl 'https://h/x' \\  -H 'A: 1' \\  --data-raw 'z'`);
  expect(d).toMatchObject({ url: "https://h/x", method: "POST", body: "z" });
  expect(d.headers).toEqual([{ key: "A", value: "1", enabled: true }]);
});
