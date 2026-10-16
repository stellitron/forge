import { describe, expect, it } from "vitest";
import { defaultExample, exampleFromResponse, uniqueExampleName } from "../examples";
import { importAny, openApiExamples } from "../importAny";
import { toOpenApi, toPostman } from "../exportCollection";
import { defaults, type HttpResponse } from "../types";
import { parse as parseYaml } from "yaml";

const res = (body: string, headers: [string, string][] = []): HttpResponse => ({ status: 200, statusText: "OK", httpVersion: "HTTP/1.1", url: "", headers: headers.map(([key, value]) => ({ key, value, enabled: true })), body, bodyBase64: false, size: body.length, timeMs: 1, ttfbMs: 1 });

describe("saving a response as an example", () => {
  it("masks secrets and drops cookies and per-response headers", () => {
    const ex = exampleFromResponse(res('{"token":"tok_123456789"}', [["Content-Type", "application/json"], ["Set-Cookie", "sid=abc"], ["Date", "Mon"], ["X-Request-Id", "r1"], ["X-RateLimit-Remaining", "9"]]), "200 OK", [["token", "tok_123456789"]]);
    expect(ex).toEqual({ name: "200 OK", status: 200, headers: [{ key: "Content-Type", value: "application/json", enabled: true }, { key: "X-RateLimit-Remaining", value: "9", enabled: true }], body: '{"token":"{{token}}"}' });
  });
  it("refuses binary and oversized bodies, and numbers duplicate names", () => {
    expect(() => exampleFromResponse({ ...res(""), bodyBase64: true }, "x", [])).toThrow(/Binary/);
    expect(() => exampleFromResponse(res("x".repeat(600_000)), "x", [])).toThrow(/too large/);
    expect(uniqueExampleName("200 OK", [{ name: "200 OK" } as any, { name: "200 OK 2" } as any])).toBe("200 OK 3");
    expect(defaultExample([{ name: "a" } as any, { name: "b" } as any])!.name).toBe("a");
  });
});

describe("examples from OpenAPI", () => {
  it("reads named examples, single examples, schema skeletons, Swagger 2 and empty responses", () => {
    const ex = openApiExamples({
      "200": { content: { "application/json": { examples: { one: { summary: "One user", value: { id: 1 } }, two: { value: { id: 2 } } } } } },
      "201": { content: { "application/json": { example: { id: 3 } } } },
      "400": { content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
      "404": { examples: { "application/json": { error: "missing" } } },
      "204": { description: "Gone" },
      default: { description: "ignored" },
    });
    // Status keys come out in numeric order (how JavaScript orders integer-like keys).
    expect(ex.map((e) => [e.name, e.status])).toEqual([["200 One user", 200], ["200 two", 200], ["201 Created", 201], ["204 No Content", 204], ["400 Bad Request", 400], ["404 Not Found", 404]]);
    expect(JSON.parse(ex[0].body)).toEqual({ id: 1 });
    expect(ex[3]).toMatchObject({ body: "", headers: [] });
    expect(JSON.parse(ex[4].body)).toHaveProperty("error");
  });
  it("come through a spec import, $refs resolved", () => {
    const spec = { openapi: "3.0.0", info: { title: "T" }, paths: { "/u/{id}": { get: { responses: { "200": { $ref: "#/components/responses/U" } } } } }, components: { responses: { U: { description: "ok", content: { "application/json": { example: { id: 7 } } } } } } };
    const d = importAny([{ path: "s.json", content: JSON.stringify(spec) }]).collections[0].items[0].data;
    expect(d.examples).toEqual([{ name: "200 OK", status: 200, headers: [{ key: "Content-Type", value: "application/json", enabled: true }], body: '{\n  "id": 7\n}' }]);
  });
});

describe("examples in Postman and OpenAPI exports", () => {
  const item = { ...defaults.http(), name: "Get user", path: "collections/C/u.json", url: "https://api.test/u/1", examples: [{ name: "Found", status: 200, headers: [{ key: "Content-Type", value: "application/json", enabled: true }], body: '{"id":1,"email":"ada@example.com"}' }, { name: "Missing", status: 404, headers: [], body: "" }] };

  it("round-trip through Postman saved responses", () => {
    const json = toPostman({ name: "C", root: "collections/C", items: [item] } as any);
    expect(JSON.parse(json).item[0].response.map((r: any) => [r.name, r.code, r.status])).toEqual([["Found", 200, "OK"], ["Missing", 404, "Not Found"]]);
    const back = importAny([{ path: "c.json", content: json }]).collections[0].items[0].data;
    expect(back.examples).toEqual(item.examples.map((e) => ({ ...e, headers: e.headers })));
  });

  it("become OpenAPI response examples, redacted like other examples", () => {
    const doc = parseYaml(toOpenApi({ name: "C", root: "collections/C", items: [item] } as any, "yaml"));
    const op = Object.values<any>(doc.paths)[0].get;
    expect(Object.keys(op.responses)).toEqual(["200", "404"]);
    const value = op.responses["200"].content["application/json"].examples.Found.value;
    expect(value.id).toBe(1);
    expect(value.email).not.toBe("ada@example.com");
  });
});
