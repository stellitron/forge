import { describe, expect, it } from "vitest";
import { describeForAi, defaultFolder, graphqlOp, isApi, siteOf, templatePath, toEndpoints, toImport, type Capture } from "../radar";
import { readOnlyPost } from "../radarSession";

const cap = (p: Partial<Capture> & { url: string }): Capture => ({
  id: Math.random().toString(36),
  method: "GET",
  type: "Fetch",
  requestHeaders: {},
  page: "https://app.acme.com/dashboard",
  ts: 0,
  status: 200,
  mimeType: "application/json",
  ...p,
});

describe("templatePath", () => {
  it("names ids after the collection they're in", () => {
    expect(templatePath("/api/users/42/posts/9f1c2d3e-1111-2222-3333-444455556666")).toEqual({
      path: "/api/users/:userId/posts/:postId",
      values: { userId: "42", postId: "9f1c2d3e-1111-2222-3333-444455556666" },
    });
    expect(templatePath("/categories/12").path).toBe("/categories/:categoryId");
    expect(templatePath("/line-items/507f1f77bcf86cd799439011").path).toBe("/line-items/:lineItemId");
  });
  it("leaves words and versions alone", () => {
    expect(templatePath("/api/v2/me/settings").path).toBe("/api/v2/me/settings");
  });
  it("numbers clashing names", () => {
    expect(templatePath("/7/8").path).toBe("/:id/:id2");
  });
});

describe("classifying calls", () => {
  it("keeps API calls and drops assets, preflights and page loads", () => {
    expect(isApi(cap({ url: "https://api.acme.com/v1/orders" }))).toBe(true);
    expect(isApi(cap({ url: "https://app.acme.com/main.js", type: "Fetch" }))).toBe(false);
    expect(isApi(cap({ url: "https://api.acme.com/v1/orders", method: "OPTIONS" }))).toBe(false);
    expect(isApi(cap({ url: "https://app.acme.com/", type: "Document" }))).toBe(false);
    expect(isApi(cap({ url: "https://app.acme.com/sw-call", type: "Other", mimeType: "application/json" }))).toBe(true);
    expect(isApi(cap({ url: "https://app.acme.com/x", type: "Other", mimeType: "text/html" }))).toBe(false);
  });
  it("treats subdomains as first-party", () => {
    expect(siteOf("api.acme.com")).toBe("acme.com");
    expect(siteOf("app.acme.co.uk")).toBe("acme.co.uk");
    expect(siteOf("localhost:3000")).toBe("localhost");
  });
});

describe("toEndpoints", () => {
  const caps = [
    cap({ url: "https://api.acme.com/v1/orders/1" }),
    cap({ url: "https://api.acme.com/v1/orders/2" }),
    cap({ url: "https://api.acme.com/v1/orders", method: "POST", postData: '{"item":"x"}' }),
    cap({ url: "https://api.acme.com/graphql", method: "POST", postData: '{"operationName":"Viewer","query":"query Viewer { me { id } }"}' }),
    cap({ url: "https://api.acme.com/graphql", method: "POST", postData: '{"query":"mutation Rename($n: String) { rename(n: $n) }"}' }),
    cap({ url: "https://www.google-analytics.com/g/collect?v=2", type: "Ping" as any }),
    cap({ url: "https://www.google-analytics.com/g/collect?v=2", type: "XHR" }),
    cap({ url: "https://cdn.other.io/config" }),
  ];
  const eps = toEndpoints(caps, "https://app.acme.com");

  it("groups by method and URL template, with GraphQL operations apart", () => {
    const keys = eps.map((e) => `${e.method} ${e.path}${e.op ? ` ${e.op}` : ""}`);
    expect(keys).toContain("GET /v1/orders/:orderId");
    expect(keys).toContain("POST /v1/orders");
    expect(keys).toContain("POST /graphql Viewer");
    expect(keys).toContain("POST /graphql Rename");
    expect(eps.find((e) => e.path === "/v1/orders/:orderId")!.count).toBe(2);
  });
  it("flags third parties and tracking", () => {
    expect(eps.find((e) => e.origin.includes("google-analytics"))).toMatchObject({ firstParty: false, noise: true });
    expect(eps.find((e) => e.origin.includes("other.io"))).toMatchObject({ firstParty: false, noise: false });
    expect(eps.filter((e) => e.firstParty).every((e) => !e.noise)).toBe(true);
  });
  it("finds GraphQL operation names", () => {
    expect(graphqlOp(cap({ url: "https://x.com/gql?operationName=Feed&query=x" }))).toBe("Feed");
    expect(graphqlOp(cap({ url: "https://x.com/gql", method: "POST", postData: '{"query":"{ me { id } }"}' }))).toBe("query");
    expect(graphqlOp(cap({ url: "https://x.com/api", method: "POST", postData: '{"a":1}' }))).toBeUndefined();
  });
});

describe("toImport", () => {
  const caps = [
    cap({
      url: "https://api.acme.com/v1/orders/17?expand=items",
      requestHeaders: { Authorization: "Bearer eyJhbGciOi.abc.def", Cookie: "sid=s3cr3t", "X-CSRF-Token": "csrf123", Accept: "application/json", "User-Agent": "Chrome", "sec-ch-ua": "x", "X-Tenant": "acme" },
    }),
    cap({
      url: "https://api.acme.com/v1/orders",
      method: "POST",
      postData: '{"item":"x","qty":2}',
      requestHeaders: { Authorization: "Bearer eyJhbGciOi.abc.def", "Content-Type": "application/json" },
      status: 201,
    }),
    cap({ url: "https://api.acme.com/graphql", method: "POST", postData: '{"operationName":"Viewer","query":"query Viewer { me { id } }","variables":{"a":1}}' }),
    cap({ url: "https://api.acme.com/session", method: "POST", postData: "user=a&remember=1", requestHeaders: { "content-type": "application/x-www-form-urlencoded" } }),
    cap({ url: "https://files.partner.io/upload-url" }),
  ];
  const eps = toEndpoints(caps, "https://app.acme.com");
  const { result, secrets, baseUrl } = toImport(eps, { name: "app.acme.com", startUrl: "https://app.acme.com", when: new Date("2026-10-16") });
  const items = result.collections[0].items;
  const get = (path: string) => items.find((i) => i.data.url.endsWith(path))!;

  it("uses {{baseUrl}} for the main API and keeps other origins literal", () => {
    expect(baseUrl).toBe("https://api.acme.com");
    expect(get("/v1/orders/:orderId").data.url).toBe("{{baseUrl}}/v1/orders/:orderId");
    expect(get("/upload-url").data.url).toBe("https://files.partner.io/upload-url");
    expect(get("/upload-url").folder).toBe("files.partner.io");
    expect(get("/v1/orders/:orderId").folder).toBe("orders");
  });
  it("fills path variables and query params from the sample", () => {
    const d = get("/v1/orders/:orderId").data;
    expect(d.pathVars).toEqual([{ key: "orderId", value: "17", enabled: true }]);
    expect(d.params).toEqual([{ key: "expand", value: "items", enabled: true }]);
  });
  it("moves credentials into secrets and drops browser-only headers", () => {
    const d = get("/v1/orders/:orderId").data;
    expect(d.auth).toEqual({ type: "bearer", token: "{{token}}" });
    expect(d.headers.map((h) => `${h.key}: ${h.value}`)).toEqual(["Cookie: {{cookie}}", "X-CSRF-Token: {{x_csrf_token}}", "Accept: application/json", "X-Tenant: acme"]);
    expect(secrets).toEqual({ token: "eyJhbGciOi.abc.def", cookie: "sid=s3cr3t", x_csrf_token: "csrf123" });
    // The same token on another request reuses the variable.
    expect(get("/v1/orders").data.auth).toEqual({ type: "bearer", token: "{{token}}" });
    expect(JSON.stringify(items)).not.toContain("s3cr3t");
  });
  it("rebuilds JSON, GraphQL and form bodies", () => {
    expect(get("/v1/orders").data).toMatchObject({ bodyMode: "json", body: '{\n  "item": "x",\n  "qty": 2\n}' });
    expect(get("/graphql").data).toMatchObject({ bodyMode: "graphql", graphql: { query: "query Viewer { me { id } }", variables: '{\n  "a": 1\n}' } });
    expect(get("/graphql").name).toBe("Viewer");
    expect(get("/session").data.form).toEqual([
      { key: "user", value: "a", enabled: true },
      { key: "remember", value: "1", enabled: true },
    ]);
  });
  it("uses names and folders from the AI when given", () => {
    const ep = eps.find((e) => e.path === "/v1/orders/:orderId")!;
    const r = toImport([ep], { name: "x", startUrl: "https://app.acme.com", organized: { [ep.key]: { name: "Get Order", folder: "Orders" } } });
    expect(r.result.collections[0].items[0]).toMatchObject({ name: "Get Order", folder: "Orders" });
  });
  it("describes endpoints to the model without values", () => {
    const text = describeForAi(eps);
    expect(text).toContain("POST /v1/orders body:{item,qty} →201");
    expect(text).toContain("query:expand");
    expect(text).not.toMatch(/s3cr3t|eyJhbG|csrf123|items|"x"/);
  });
});

describe("helpers", () => {
  it("picks the folder from the first meaningful segment", () => {
    expect(defaultFolder("/api/v2/orders/:id/items")).toBe("orders");
    expect(defaultFolder("/graphql")).toBe("");
  });
  it("lets GraphQL queries through the write guard, but not mutations", () => {
    expect(readOnlyPost('{"query":"query A { a }"}')).toBe(true);
    expect(readOnlyPost('[{"query":"{ a }"},{"query":"query B { b }"}]')).toBe(true);
    expect(readOnlyPost('{"query":"mutation M { m }"}')).toBe(false);
    expect(readOnlyPost('{"name":"x"}')).toBe(false);
    expect(readOnlyPost(undefined)).toBe(false);
  });
});
