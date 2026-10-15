import { describe, expect, it } from "vitest";
import { importAny } from "../importAny";
import { openApiLocation, postmanTests, toOpenApi, toPostman, toPostmanEnv, type ExportInput } from "../exportCollection";
import { defaults, type HttpItem, type Item } from "../types";

const req = (path: string, p: Partial<HttpItem>): Item => ({ ...defaults.http(), name: path.split("/").pop()!.replace(".json", ""), path, ...p }) as Item;
const input: ExportInput = {
  name: "Shop",
  root: "collections/Shop",
  items: [
    req("collections/Shop/Users/List users.json", {
      method: "GET", url: "{{baseUrl}}/users?page=1", params: [{ key: "page", value: "1", enabled: true }, { key: "debug", value: "1", enabled: false }],
      auth: { type: "oauth2", grant: "client_credentials", authUrl: "", tokenUrl: "https://id.io/token", clientId: "{{cid}}", clientSecret: "{{secret}}", scope: "read write", audience: "", username: "", password: "", pkce: false, redirectUri: "", clientAuth: "basic", tokenVar: "shopToken" },
      assertions: [{ enabled: true, source: "status", path: "", op: "eq", value: "200" }, { enabled: true, source: "jsonpath", path: "$.items[0].id", op: "exists", value: "" }],
      extractions: [{ enabled: true, variable: "userId", source: "jsonpath", path: "$.items[0].id" }],
    }),
    req("collections/Shop/Users/Get user.json", { method: "GET", url: "{{baseUrl}}/users/:id", description: "Returns one user by `id`.", pathVars: [{ key: "id", value: "42", enabled: true }], auth: { type: "digest", username: "u", password: "{{pw}}" } }),
    req("collections/Shop/Create order.json", { method: "POST", url: "https://api.shop.io/orders", bodyMode: "json", body: '{"sku":"A1","qty":2}', headers: [{ key: "X-Trace", value: "abc", enabled: true }], auth: { type: "awsv4", accessKey: "{{ak}}", secretKey: "{{sk}}", sessionToken: "", region: "eu-west-1", service: "execute-api" } }),
    { kind: "mcp", path: "collections/Shop/server.json", name: "server", transport: "stdio", command: "x", args: "", env: [], cwd: "", url: "", headers: [] } as unknown as Item,
  ],
};

describe("Postman export", () => {
  it("round-trips through Forge's own importer", () => {
    const back = importAny([{ path: "shop.postman_collection.json", content: toPostman(input) }]).collections[0];
    const by = Object.fromEntries(back.items.map((x) => [x.name, x]));
    expect(back.items).toHaveLength(3);
    expect(by["List users"].folder).toBe("Users");
    expect(by["List users"].data.auth).toMatchObject({ type: "oauth2", grant: "client_credentials", tokenUrl: "https://id.io/token", clientAuth: "basic", tokenVar: "shopToken", scope: "read write" });
    expect(by["List users"].data.params.find((p) => p.key === "debug")?.enabled).toBe(false);
    expect(by["Get user"].data.auth).toEqual({ type: "digest", username: "u", password: "{{pw}}" });
    expect(by["Get user"].data.description).toBe("Returns one user by `id`.");
    expect(by["Create order"].data).toMatchObject({ method: "POST", bodyMode: "json", body: '{"sku":"A1","qty":2}' });
    expect(by["Create order"].data.auth).toMatchObject({ type: "awsv4", region: "eu-west-1" });
  });

  it("writes test scripts that run in Postman's sandbox", () => {
    const lines = postmanTests(
      [
        { enabled: true, source: "status", path: "", op: "eq", value: "200" },
        { enabled: true, source: "jsonpath", path: "$.items[0].name", op: "contains", value: "Ada" },
        { enabled: true, source: "time", path: "", op: "lt", value: "1000" },
        { enabled: true, source: "header", path: "X-Id", op: "notExists", value: "" },
      ],
      [{ enabled: true, variable: "firstId", source: "jsonpath", path: "$.items[0].id" }],
    );
    const results: [string, boolean][] = [];
    const env: Record<string, unknown> = {};
    const chai = (v: unknown, neg = false) => {
      const ok = (c: boolean) => {
        if (c === neg) throw new Error("fail");
      };
      const api: any = {
        eql: (x: unknown) => ok(v === x), include: (x: string) => ok(String(v).includes(x)), match: (r: RegExp) => ok(r.test(String(v))),
        above: (x: number) => ok((v as number) > x), below: (x: number) => ok((v as number) < x),
        get exist() { ok(v != null); return true; }, get true() { ok(v === true); return true; },
      };
      api.to = api; api.be = api; api.not = neg ? api : chai(v, true);
      return api;
    };
    const pm = {
      response: { code: 200, responseTime: 120, responseSize: 10, json: () => ({ items: [{ id: 7, name: "Ada Lovelace" }] }), text: () => "", headers: { get: () => undefined } },
      test: (name: string, fn: () => void) => { try { fn(); results.push([name, true]); } catch { results.push([name, false]); } },
      expect: (v: unknown) => chai(v),
      environment: { set: (k: string, v: unknown) => (env[k] = v) },
    };
    new Function("pm", lines.join("\n"))(pm);
    expect(results.map((r) => r[1])).toEqual([true, true, true, true]);
    expect(env.firstId).toBe(7);
  });

  it("leaves secret values out of environment exports unless asked", () => {
    const env = { name: "Staging", path: "environments/staging.json", vars: [{ key: "baseUrl", value: "https://s.io", enabled: true }], secrets: [{ key: "token", value: "s3cret", enabled: true }] };
    expect(toPostmanEnv(env, false)).not.toContain("s3cret");
    expect(JSON.parse(toPostmanEnv(env, false)).values).toContainEqual({ key: "token", value: "", enabled: true, type: "secret" });
    expect(toPostmanEnv(env, true)).toContain("s3cret");
  });
});

describe("OpenAPI export", () => {
  it("splits servers from paths and converts parameters", () => {
    expect(openApiLocation("{{baseUrl}}/users/:id/orders?x=1", { baseUrl: "https://api.io/v1/" })).toEqual({ server: "https://api.io/v1", path: "/users/{id}/orders", pathParams: ["id"] });
    expect(openApiLocation("https://api.io/a/{{tenant}}/b")).toEqual({ server: "https://api.io", path: "/a/{tenant}/b", pathParams: ["tenant"] });
    expect(openApiLocation("{{baseUrl}}")).toMatchObject({ server: "{baseUrl}", path: "/" });
  });

  it("produces a spec Forge can import again", () => {
    const yaml = toOpenApi({ ...input, vars: { baseUrl: "https://api.shop.io" } }, "yaml");
    expect(yaml).toContain("openapi: 3.0.3");
    expect(yaml).toContain("/users/{id}:");
    const back = importAny([{ path: "openapi.yaml", content: yaml }]).collections[0];
    expect(back.items.map((x) => `${x.data.method} ${x.data.url}`).sort()).toEqual(["GET {{baseUrl}}/users", "GET {{baseUrl}}/users/{{id}}", "POST {{baseUrl}}/orders"].sort());
    const spec = JSON.parse(toOpenApi(input, "json"));
    expect(spec.components.securitySchemes.oauth2_client_credentials.flows.clientCredentials.tokenUrl).toBe("https://id.io/token");
    expect(spec.paths["/users"].get.parameters.find((p: any) => p.name === "page").example).toBe("1");
    expect(spec.paths["/users/{id}"].get.description).toBe("Returns one user by `id`.");
    expect(back.items.find((x) => x.data.url.endsWith("{{id}}"))!.data.description).toBe("Returns one user by `id`.");
  });
});
