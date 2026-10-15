import { describe, expect, it } from "vitest";
import { buildDocModel, describeTest, docsHtml, docsMarkdown, fieldTable, mdToHtml, missingDescriptions, redact } from "../apiDocs";
import { defaults, type HttpItem, type HttpResponse, type Item } from "../types";

const req = (path: string, p: Partial<HttpItem>): Item => ({ ...defaults.http(), name: path.split("/").pop()!.replace(".json", ""), path, ...p }) as Item;
const res = (body: unknown, status = 200): HttpResponse => ({ status, statusText: "OK", httpVersion: "HTTP/1.1", url: "", headers: [{ key: "content-type", value: "application/json; charset=utf-8" }], body: JSON.stringify(body), bodyBase64: false, size: 1, timeMs: 1, ttfbMs: 1 } as unknown as HttpResponse);

const items = [
  req("collections/Shop/Users/List users.json", {
    url: "{{baseUrl}}/users?page=1", params: [{ key: "page", value: "1", enabled: true }],
    auth: { type: "bearer", token: "{{token}}" }, description: "Returns users, **newest first**.",
    assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "200" }, { enabled: true, source: "jsonpath", path: "$[0].id", op: "exists", value: "" }],
  }),
  req("collections/Shop/Users/Get user.json", { url: "{{baseUrl}}/users/:id", pathVars: [{ key: "id", value: "42", enabled: true }] }),
  req("collections/Shop/Login.json", { method: "POST", url: "{{baseUrl}}/login", bodyMode: "json", body: '{"email":"a@b.io","password":"{{password}}"}', headers: [{ key: "X-Api-Key", value: "live-key-abc", enabled: true }] }),
];
const input = {
  name: "Shop", root: "collections/Shop", items,
  vars: { baseUrl: "https://api.shop.io" },
  responses: {
    "collections/Shop/Users/List users.json": res([{ id: 1, name: "Ada", address: { city: "London" }, tags: ["a"], score: 4.5 }]),
    "collections/Shop/Login.json": res({ access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", user: { id: 1, apiKey: "k-123" } }),
  },
};
const opts = { title: "Shop API", intro: "Start with **Login**.", examples: "sample" as const, samples: ["curl" as const] };

describe("API docs", () => {
  it("builds endpoints grouped by folder with params, auth, tests and samples", () => {
    const m = buildDocModel(input, opts, new Date("2026-10-14"));
    expect(m.servers).toEqual(["https://api.shop.io"]);
    expect(m.folders.map((f) => f.name)).toEqual(["", "Users"]);
    const list = m.folders[1].endpoints.find((e) => e.name === "List users")!;
    expect(list).toMatchObject({ method: "GET", path: "/users?page=1", auth: "Bearer token in the Authorization header" });
    expect(list.params).toContainEqual({ name: "page", in: "query", example: "1", required: false });
    expect(list.tests).toEqual(["Status is 200", "`$[0].id` exists"]);
    expect(list.samples[0].code).toContain("curl");
    expect(list.response?.fields.map((f) => `${f.path}:${f.type}`)).toEqual(["id:integer", "name:string", "address:object", "address.city:string", "tags:array of string", "score:number"]);
    const get = m.folders[1].endpoints.find((e) => e.name === "Get user")!;
    expect(get.params[0]).toEqual({ name: "id", in: "path", example: "42", required: true });
  });

  it("hides secrets in examples, headers and fields", () => {
    const m = buildDocModel(input, opts);
    const login = m.folders[0].endpoints[0];
    expect(login.params.find((p) => p.name === "X-Api-Key")?.example).toBe("••••••");
    expect(login.response?.example).not.toContain("eyJhbGci");
    expect(login.response?.example).not.toContain("k-123");
    expect(JSON.stringify(redact({ password: "hunter2", note: "fine", nested: { secret_key: 5 } }))).toBe('{"password":"••••••","note":"fine","nested":{"secret_key":"••••••"}}');
    expect(fieldTable({ token: "abc" })[0].example).toBe("••••••");
    expect(docsMarkdown(m)).not.toContain("live-key-abc");
    expect(docsMarkdown(m)).toContain('"password": "{{password}}"'); // placeholders stay readable
  });

  it("hides literal credentials in code samples, keeping placeholders", async () => {
    const { sampleRequest } = await import("../apiDocs");
    const basic = sampleRequest({ ...defaults.http(), url: "https://a.io/x?api_key=sk123456&page=2", auth: { type: "basic", username: "bob", password: "hunter22" } } as HttpItem);
    expect(basic.headers.find((h) => h.key === "Authorization")?.value).toBe("Basic ••••••");
    expect(basic.url).toBe(`https://a.io/x?api_key=${encodeURIComponent("••••••")}&page=2`);
    const bearer = sampleRequest({ ...defaults.http(), url: "https://a.io", auth: { type: "bearer", token: "{{token}}" } } as HttpItem);
    expect(bearer.headers.find((h) => h.key === "Authorization")?.value).toBe("Bearer {{token}}");
    const literal = sampleRequest({ ...defaults.http(), url: "https://a.io", auth: { type: "apikey", key: "X-Key", value: "realvalue1", in: "header" } } as HttpItem);
    expect(literal.headers.find((h) => h.key === "X-Key")?.value).toBe("••••••");
  });

  it("leaves response examples out when asked", () => {
    expect(buildDocModel(input, { ...opts, examples: "off" }).folders[1].endpoints[0].response).toBeUndefined();
  });

  it("finds requests without descriptions", () => {
    expect(missingDescriptions(input).map((i) => i.name).sort()).toEqual(["Get user", "Login"]);
  });

  it("renders Markdown and HTML", () => {
    const m = buildDocModel(input, opts);
    const md = docsMarkdown(m);
    expect(md).toContain("# Shop API");
    expect(md).toContain("`GET /users/{id}`");
    expect(md).toContain("| `page` | query | no | `1` |");
    const html = docsHtml(m);
    expect(html).toContain("<strong>newest first</strong>");
    expect(html).toContain('id="users-list-users"');
  });

  it("never passes HTML or script links through descriptions", () => {
    const out = mdToHtml('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://a.io) `<b>`');
    expect(out).not.toContain("<img");
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('<a href="https://a.io" rel="noopener noreferrer">ok</a>');
    expect(out).toContain("<code>&lt;b&gt;</code>");
    const m = buildDocModel({ ...input, items: [req("collections/Shop/X.json", { url: "https://a.io", description: "<script>alert(1)</script>", name: '<img src=x>' } as Partial<HttpItem>)] }, opts);
    const html = docsHtml(m);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x>");
  });

  it("describes tests in words", () => {
    expect(describeTest({ enabled: true, source: "time", path: "", op: "lt", value: "500" })).toBe("Response time (ms) is less than 500");
  });
});

describe("personal data in examples", () => {
  const people = {
    ...input,
    responses: {
      "collections/Shop/Users/List users.json": res([{ id: 7, firstName: "Priya", last_name: "Sharma", email: "priya.sharma@acme.in", phone: "+91 98450 12345", address: { street: "12 MG Road", city: "Bengaluru", zip: "560001" }, location: { lat: 12.97, lng: 77.59 }, dob: "1988-04-02", ip: "203.0.113.9", note: "Ask priya.sharma@acme.in", plan: "pro", total: 1299 }]),
    },
  };
  const realData = ["Priya", "Sharma", "priya.sharma@acme.in", "98450", "12 MG Road", "Bengaluru", "560001", "12.97", "77.59", "1988-04-02", "203.0.113.9"];

  it("replaces personal data with sample values by default, keeping types and other fields", () => {
    const m = buildDocModel(people, opts);
    const e = m.folders[1].endpoints.find((x) => x.name === "List users")!;
    for (const leak of realData) expect(e.response!.example).not.toContain(leak);
    for (const leak of realData) expect(docsHtml(m)).not.toContain(leak);
    const ex = JSON.parse(e.response!.example)[0];
    expect(ex).toMatchObject({ id: 7, email: "user@example.com", phone: "+1 555 0100", address: { street: "1 Example Street", city: "Example City", zip: "00000" }, location: { lat: 0, lng: 0 }, plan: "pro", total: 1299, note: "Ask user@example.com" });
    expect(e.response!.fields.find((f) => f.path === "email")).toEqual({ path: "email", type: "string", example: "user@example.com" });
  });

  it("keeps real values only when asked, still hiding secrets", () => {
    const e = buildDocModel(people, { ...opts, examples: "real" }).folders[1].endpoints.find((x) => x.name === "List users")!;
    expect(e.response!.example).toContain("priya.sharma@acme.in");
    const login = buildDocModel(input, { ...opts, examples: "real" }).folders[0].endpoints[0];
    expect(login.response!.example).not.toContain("eyJhbGci");
  });

  it("OpenAPI export never includes real personal data or secrets", async () => {
    const { toOpenApi } = await import("../exportCollection");
    const spec = toOpenApi({ ...people, responses: { ...people.responses, "collections/Shop/Login.json": input.responses["collections/Shop/Login.json"] } }, "json");
    for (const leak of [...realData, "eyJhbGci", "k-123"]) expect(spec).not.toContain(leak);
    expect(spec).toContain("user@example.com");
  });
});

describe("AI drafts for docs", () => {
  it("send structure only, never example values", async () => {
    const { draftPrompt } = await import("../docsAi");
    const m = buildDocModel(input, opts);
    const all = m.folders.flatMap((f) => f.endpoints);
    const p = draftPrompt("Shop API", all, true);
    expect(p).toContain("POST /login");
    expect(p).toContain("password: string");
    expect(p).toContain("address.city: string");
    for (const leak of ["Ada", "London", "a@b.io", "live-key-abc", "eyJhbGci", "k-123", "?page=1"]) expect(p).not.toContain(leak);
  });

  it("keeps only drafts for known endpoints and strips em dashes", async () => {
    const { parseDrafts } = await import("../docsAi");
    const out = parseDrafts('Here: {"intro":"Call **Login** first \u2014 then list.","endpoints":[{"id":"login","description":"Signs in."},{"id":"nope","description":"x"},{"id":"users-get-user","description":""}]}', new Set(["login", "users-get-user"]));
    expect(out.drafts).toEqual([{ id: "login", description: "Signs in." }]);
    expect(out.intro).toBe("Call **Login** first, then list.");
    expect(parseDrafts("no json", new Set()).drafts).toEqual([]);
  });
});
