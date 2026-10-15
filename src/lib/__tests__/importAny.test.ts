import { describe, expect, it } from "vitest";
import { detect, importAny } from "../importAny";

const one = (path: string, content: string) => importAny([{ path, content }]);

describe("universal import", () => {
  it("Postman collection + environment", () => {
    const r = importAny([
      { path: "c.json", content: JSON.stringify({ info: { name: "Shop" }, item: [{ name: "Orders", item: [{ name: "List", request: { method: "GET", url: { raw: "{{base}}/orders?page=1", query: [{ key: "page", value: "1" }] } } }] }] }) },
      { path: "e.json", content: JSON.stringify({ name: "Prod", values: [{ key: "token", value: "s3cret", enabled: true }, { key: "baseUrl", value: "https://api.shop.io", enabled: true }, { key: "pin", value: "1234", type: "secret", enabled: true }], _postman_variable_scope: "environment" }) },
    ]);
    expect(r.collections[0]).toMatchObject({ name: "Shop", format: "Postman", items: [{ name: "List", folder: "Orders" }] });
    // URLs stay shared (teammates need them); credentials and Postman "secret" vars stay local.
    expect(r.envs).toEqual([{ name: "Prod", vars: [{ key: "baseUrl", value: "https://api.shop.io", enabled: true }], secrets: [{ key: "token", value: "s3cret", enabled: true }, { key: "pin", value: "1234", enabled: true }] }]);
  });

  it("OpenAPI 3 in YAML with security, server variables and $refs", () => {
    const r = one("api.yaml", `openapi: 3.0.3
info: { title: Pets }
servers:
  - url: https://{region}.pets.io/v1
    variables: { region: { default: eu } }
security: [{ bearer: [] }]
components:
  securitySchemes: { bearer: { type: http, scheme: bearer } }
  schemas:
    Pet: { type: object, properties: { name: { type: string }, age: { type: integer } } }
paths:
  /pets/{id}:
    put:
      tags: [pets]
      summary: Update pet
      parameters: [{ name: id, in: path, required: true }]
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
      responses: { '200': { description: ok } }
`);
    const it = r.collections[0].items[0];
    expect(r.baseUrl).toBe("https://eu.pets.io/v1");
    expect(it).toMatchObject({ name: "Update pet", folder: "pets", data: { method: "PUT", url: "{{baseUrl}}/pets/{{id}}", auth: { type: "bearer", token: "{{token}}" }, bodyMode: "json" } });
    expect(Object.keys(JSON.parse(it.data.body))).toEqual(["name", "age"]);
  });

  it("Swagger 2 with body and formData params", () => {
    const r = one("s.json", JSON.stringify({ swagger: "2.0", host: "api.x.io", basePath: "/v2", schemes: ["http"], paths: { "/up": { post: { parameters: [{ in: "formData", name: "file", type: "file" }], responses: { 201: {} } } }, "/j": { post: { parameters: [{ in: "body", name: "b", schema: { type: "object", properties: { a: { type: "string" } } } }], responses: {} } } } }));
    expect(r.baseUrl).toBe("http://api.x.io/v2");
    expect(r.collections[0].items[0].data).toMatchObject({ bodyMode: "multipart", multipart: [{ key: "file", file: true }] });
    expect(r.collections[0].items[1].data.bodyMode).toBe("json");
  });

  it("Insomnia v4 export with nested folders, auth and environments", () => {
    const doc = {
      _type: "export", __export_format: 4,
      resources: [
        { _id: "wrk_1", _type: "workspace", name: "Billing" },
        { _id: "fld_1", _type: "request_group", parentId: "wrk_1", name: "Invoices" },
        { _id: "fld_2", _type: "request_group", parentId: "fld_1", name: "Admin" },
        { _id: "req_1", _type: "request", parentId: "fld_2", name: "Create", method: "POST", url: "{{ _.base }}/invoices?draft=true", headers: [{ name: "X-A", value: "{{_.tenant}}" }], body: { mimeType: "application/json", text: "{\"amount\":5}" }, authentication: { type: "bearer", token: "{{ _.token }}" } },
        { _id: "req_2", _type: "grpc_request", parentId: "wrk_1", name: "Stream" },
        { _id: "env_1", _type: "environment", parentId: "wrk_1", name: "Base Environment", data: { base: "https://b.io", nested: { k: 1 } } },
      ],
    };
    const r = one("insomnia.json", JSON.stringify(doc));
    expect(r.collections[0]).toMatchObject({ name: "Billing", format: "Insomnia" });
    expect(r.collections[0].items[0]).toMatchObject({ folder: "Invoices/Admin", data: { method: "POST", url: "{{base}}/invoices", params: [{ key: "draft", value: "true" }], headers: [{ key: "X-A", value: "{{tenant}}" }, { key: "Content-Type" }], auth: { type: "bearer", token: "{{token}}" }, bodyMode: "json" } });
    expect(r.envs[0].vars).toEqual([{ key: "base", value: "https://b.io", enabled: true }, { key: "nested.k", value: "1", enabled: true }]);
    expect(r.envs[0].secrets).toEqual([]);
    expect(r.skipped).toContain("Stream (grpc)");
  });

  it("Insomnia v5 YAML", () => {
    const r = one("c.yaml", `type: collection.insomnia.rest/5.0
name: Store
collection:
  - name: Items
    children:
      - url: https://s.io/items
        name: List items
        method: GET
environments:
  name: Base
  data: { base: https://s.io }
  subEnvironments:
    - name: Staging
      data: { base: https://staging.s.io }
`);
    expect(r.collections[0].items[0]).toMatchObject({ name: "List items", folder: "Items", data: { url: "https://s.io/items" } });
    expect(r.envs.map((e) => e.name)).toEqual(["Store base", "Staging"]);
  });

  it("Bruno collection folder (.bru files + environments)", () => {
    const r = importAny([
      { path: "Weather/bruno.json", content: JSON.stringify({ version: "1", name: "Weather API", type: "collection" }) },
      { path: "Weather/forecast/folder.bru", content: "meta {\n  name: forecast\n}\n" },
      {
        path: "Weather/forecast/daily.bru",
        content: `meta {
  name: Daily forecast
  type: http
  seq: 2
}

post {
  url: {{base}}/forecast/:city?days=3
  body: json
  auth: bearer
}

params:query {
  days: 3
  ~units: metric
}

params:path {
  city: pune
}

headers {
  X-Trace: abc
}

auth:bearer {
  token: {{token}}
}

body:json {
  {
    "detail": "full"
  }
}

assert {
  res.status: eq 200
  res.body.days.length: gt 0
}
`,
      },
      { path: "Weather/now.bru", content: "meta {\n  name: Now\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{base}}/now\n  body: none\n  auth: none\n}\n" },
      { path: "Weather/environments/Local.bru", content: "vars {\n  base: http://localhost:8080\n}\nvars:secret [\n  token\n]\n" },
    ]);
    const c = r.collections[0];
    expect(c).toMatchObject({ name: "Weather API", format: "Bruno" });
    expect(c.items.map((i) => i.name)).toEqual(["Now", "Daily forecast"]);
    expect(c.items[1]).toMatchObject({
      folder: "forecast",
      data: {
        method: "POST",
        url: "{{base}}/forecast/pune",
        params: [{ key: "days", value: "3", enabled: true }, { key: "units", value: "metric", enabled: false }],
        headers: [{ key: "X-Trace", value: "abc" }],
        auth: { type: "bearer", token: "{{token}}" },
        bodyMode: "json",
        assertions: [{ source: "status", op: "eq", value: "200" }, { source: "jsonpath", path: "$.days.length", op: "gt", value: "0" }],
      },
    });
    expect(JSON.parse(c.items[1].data.body)).toEqual({ detail: "full" });
    expect(r.envs).toEqual([{ name: "Local", vars: [{ key: "base", value: "http://localhost:8080", enabled: true }], secrets: [{ key: "token", value: "", enabled: true }] }]);
  });

  it("Bruno JSON export", () => {
    const r = one("b.json", JSON.stringify({ version: "1", name: "BJ", items: [{ type: "folder", name: "F", items: [{ type: "http-request", name: "R", seq: 1, request: { method: "PATCH", url: "https://x/a/:id", params: [{ name: "id", value: "7", type: "path", enabled: true }], headers: [], auth: { mode: "basic", basic: { username: "u", password: "p" } }, body: { mode: "formUrlEncoded", formUrlEncoded: [{ name: "a", value: "1", enabled: true }] } } }] }], environments: [{ name: "E", variables: [{ name: "k", value: "v", enabled: true, secret: false }] }] }));
    expect(r.collections[0].items[0]).toMatchObject({ folder: "F", data: { method: "PATCH", url: "https://x/a/7", auth: { type: "basic", username: "u" }, bodyMode: "form" } });
    expect(r.envs[0].name).toBe("E");
  });

  it("HAR: drops pseudo-headers and duplicates, groups by host", () => {
    const entry = (url: string) => ({ request: { method: "POST", url, headers: [{ name: ":authority", value: "x" }, { name: "Content-Type", value: "application/json" }, { name: "Content-Length", value: "2" }], queryString: [], postData: { mimeType: "application/json", text: "{}" } } });
    const r = one("site.har", JSON.stringify({ log: { entries: [entry("https://api.a.io/v1/x"), entry("https://api.a.io/v1/x"), entry("https://cdn.b.io/y")] } }));
    expect(r.collections[0].items.map((i) => [i.folder, i.name])).toEqual([["api.a.io", "POST /v1/x"], ["cdn.b.io", "POST /y"]]);
    expect(r.collections[0].items[0].data.headers).toEqual([{ key: "Content-Type", value: "application/json", enabled: true }]);
  });

  it("several pasted curl commands", () => {
    const r = one("pasted", "curl https://a.io/one\n\ncurl -X DELETE 'https://a.io/two' \\\n  -H 'A: 1'");
    expect(r.collections[0].items.map((i) => i.name)).toEqual(["GET /one", "DELETE /two"]);
  });

  it("spots credentials by value even with innocent names", async () => {
    const { splitEnv } = await import("../importAny");
    const e = splitEnv("x", [
      { key: "user", value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", enabled: true },
      { key: "header", value: "Bearer fake-token-for-tests-only", enabled: true },
      { key: "stripe", value: "fake_TEST_value_not_a_real_key_0001", enabled: true },
      { key: "region", value: "eu-west-1", enabled: true },
      { key: "callback", value: "https://example.com/very/long/callback/path/here", enabled: true },
      { key: "userId", value: "42", enabled: true },
    ]);
    expect(e.secrets.map((x) => x.key)).toEqual(["user", "header", "stripe"]);
    expect(e.vars.map((x) => x.key)).toEqual(["region", "callback", "userId"]);
  });

  it("explains unknown input", () => {
    expect(() => one("pasted", '{"hello": 1}')).toThrow(/not a recognised collection format/);
    expect(detect({ openapi: "3.1.0", paths: {} })).toBe("OpenAPI");
  });
});
