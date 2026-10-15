import { describe, expect, it } from "vitest";
import { interpolate, jsonPath, runAssertions, runExtractions, SseParser } from "../eval";
import { importCurl, importPostman } from "../importers";
import { buildRequest } from "../request";
import { splitArgs } from "../ipc";
import { defaults, type HttpResponse } from "../types";

const res = (body: unknown, status = 200): HttpResponse => ({
  status, statusText: "OK", httpVersion: "HTTP/1.1", url: "http://x", body: JSON.stringify(body), bodyBase64: false,
  size: 10, timeMs: 42, ttfbMs: 10, headers: [{ key: "content-type", value: "application/json", enabled: true }],
});

describe("variables", () => {
  it("substitutes env vars and leaves unknown ones", () => {
    expect(interpolate("{{base}}/u/{{ id }}?q={{nope}}", { base: "http://h", id: "7" })).toBe("http://h/u/7?q={{nope}}");
    expect(interpolate("{{$uuid}}", {})).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("jsonPath", () => {
  const data = { data: [{ id: 1, "a b": { c: true } }], n: null };
  it("walks dotted, indexed and quoted paths", () => {
    expect(jsonPath(data, "$.data[0].id")).toBe(1);
    expect(jsonPath(data, 'data.0["a b"].c')).toBe(true);
    expect(jsonPath(data, "$.data.length")).toBe(1);
    expect(jsonPath(data, "$.missing.x")).toBeUndefined();
  });
});

describe("assertions & extraction", () => {
  it("evaluates every operator", () => {
    const r = res({ token: "abc", items: [1, 2, 3] }, 201);
    const out = runAssertions([
      { enabled: true, source: "status", path: "", op: "eq", value: "201" },
      { enabled: true, source: "jsonpath", path: "$.items.length", op: "gt", value: "2" },
      { enabled: true, source: "header", path: "Content-Type", op: "contains", value: "json" },
      { enabled: true, source: "time", path: "", op: "lt", value: "10" },
      { enabled: true, source: "jsonpath", path: "$.nope", op: "notExists", value: "" },
      { enabled: false, source: "status", path: "", op: "eq", value: "500" },
    ], r);
    expect(out.map((o) => o.pass)).toEqual([true, true, true, false, true]);
    expect(runExtractions([{ enabled: true, variable: "tok", source: "jsonpath", path: "$.token" }], r)).toEqual({ tok: "abc" });
  });
});

describe("request building", () => {
  it("applies params, auth, json content-type and graphql", () => {
    const d = defaults.http();
    Object.assign(d, { method: "POST", url: "{{base}}/x", bodyMode: "json", body: '{"a":"{{v}}"}' });
    d.params = [{ key: "q", value: "a b", enabled: true }, { key: "off", value: "1", enabled: false }];
    d.auth = { type: "basic", username: "u", password: "p" };
    const r = buildRequest(d, { base: "https://api", v: "1" });
    expect(r.url).toBe("https://api/x?q=a%20b");
    expect(r.headers).toContainEqual({ key: "Authorization", value: "Basic dTpw", enabled: true });
    expect(r.headers).toContainEqual({ key: "Content-Type", value: "application/json", enabled: true });
    expect(r.body).toEqual({ type: "raw", content: '{"a":"1"}' });
    const g = { ...defaults.http(), url: "localhost:4000/graphql", bodyMode: "graphql" as const, graphql: { query: "{ me }", variables: "{\"x\":1}" } };
    const gr = buildRequest(g, {});
    expect(gr.method).toBe("POST");
    expect(gr.url).toBe("http://localhost:4000/graphql");
    expect(JSON.parse((gr.body as { content: string }).content)).toEqual({ query: "{ me }", variables: { x: 1 } });
  });
});

describe("importers", () => {
  it("parses devtools-style curl", () => {
    const d = importCurl(`curl 'https://api.x.com/v1/users?page=2' \\\n  -H 'Authorization: Bearer t' -H 'content-type: application/json' --data-raw '{"a":1}' --compressed`);
    expect(d.method).toBe("POST");
    expect(d.url).toBe("https://api.x.com/v1/users");
    expect(d.params).toEqual([{ key: "page", value: "2", enabled: true }]);
    expect(d.bodyMode).toBe("json");
    expect(d.headers[0]).toEqual({ key: "Authorization", value: "Bearer t", enabled: true });
  });
  it("imports Postman v2.1 folders, auth inheritance and bodies", () => {
    const out = importPostman({
      info: { name: "Shop" }, auth: { type: "bearer", bearer: [{ key: "token", value: "{{tok}}" }] },
      variable: [{ key: "base", value: "http://h" }],
      item: [{ name: "Orders", item: [{ name: "Create", request: { method: "POST", url: { raw: "{{base}}/orders?x=1", query: [{ key: "x", value: "1" }] }, body: { mode: "raw", raw: "{}", options: { raw: { language: "json" } } } } }] }],
    });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ name: "Create", folder: "Orders" });
    expect(out.items[0].data).toMatchObject({ method: "POST", url: "{{base}}/orders", bodyMode: "json", auth: { type: "bearer", token: "{{tok}}" } });
    expect(out.variables).toEqual([{ key: "base", value: "http://h", enabled: true }]);
  });
});

describe("misc", () => {
  it("parses SSE across chunk boundaries", () => {
    const p = new SseParser();
    expect(p.feed("event: a\r\nda")).toEqual([]);
    expect(p.feed("ta: 1\r\n\r\ndata: 2\n\n")).toEqual([{ event: "a", data: "1" }, { data: "2" }]);
  });
  it("splits quoted args", () => {
    expect(splitArgs(`-y "@scope/server x" --dir '/a b' ""`)).toEqual(["-y", "@scope/server x", "--dir", "/a b", ""]);
  });
});

describe("suggested assertions", async () => {
  const { suggestAssertions } = await import("../suggest");
  it("all pass against the response they came from, and skip volatile fields", () => {
    const r = { ...res({ id: 42, name: "Ada", role: "admin", created_at: "2026-01-01", profile: { city: "Pune" }, tags: ["x"] }), timeMs: 120 };
    const s = suggestAssertions(r, []);
    expect(runAssertions(s, r).every((x) => x.pass)).toBe(true);
    const labels = runAssertions(s, r).map((x) => x.label);
    expect(labels).toContain("jsonpath $.name eq Ada");
    expect(labels).toContain("jsonpath $.profile.city exists");
    expect(labels.some((l) => l.startsWith("jsonpath $.id eq"))).toBe(false); // ids change between runs
    expect(labels).toContain("time lt 500");
    expect(suggestAssertions(r, s)).toEqual([]); // no duplicates on a second click
  });
});
