import { describe, expect, it } from "vitest";
import { importAny } from "../importAny";
import { summarizeImport } from "../importSummary";

const collection = {
  info: { name: "Shop", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    {
      name: "Users",
      item: [
        { name: "List users", request: { method: "GET", url: "{{baseUrl}}/users?page={{page}}", auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] } },
          event: [{ listen: "test", script: { exec: ["pm.test('ok', () => pm.response.to.have.status(200))"] } }] },
        { name: "List users", request: { method: "GET", url: "{{baseUrl}}/users/v2" } },
        { name: "Create user", request: { method: "POST", url: "http://api.shop.io/users", body: { mode: "raw", raw: "{\"a\":1}", options: { raw: { language: "json" } } },
          header: [{ key: "Authorization", value: "Bearer abc123livetoken" }] },
          event: [{ listen: "prerequest", script: { exec: [""] } }] },
      ],
    },
    { name: "Broken", request: { method: "DELETE", url: "" } },
  ],
};
const env = { name: "Staging", values: [{ key: "baseUrl", value: "https://s.shop.io", enabled: true }, { key: "token", value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", enabled: true }], _postman_variable_scope: "environment" };

describe("import summary", () => {
  const sources = [
    { path: "shop.postman_collection.json", content: JSON.stringify(collection) },
    { path: "staging.postman_environment.json", content: JSON.stringify(env) },
  ];
  const s = summarizeImport(importAny(sources), sources);

  it("counts what was imported", () => {
    expect(s).toMatchObject({ requests: 4, collections: 1, folders: 1, withTests: 0, withDescriptions: 0 });
    expect(s.methods).toEqual([["GET", 2], ["POST", 1], ["DELETE", 1]]);
    expect(s.auth).toContainEqual(["Bearer", 1]);
    expect(s.bodies).toEqual([["JSON", 1]]);
    expect(s.envs).toEqual([{ name: "Staging", shared: 1, secrets: 1 }]);
  });

  it("flags things that need attention, with examples", () => {
    const text = s.issues.map((i) => `${i.level}: ${i.text}`).join("\n");
    expect(text).toContain("warn: 1 request has no URL.");
    expect(text).toMatch(/warn: 1 request has a credential typed in directly/);
    expect(s.issues.find((i) => i.text.includes("credential"))!.examples).toEqual(["Users/Create user"]);
    expect(text).toContain("info: 1 request uses plain http://");
    expect(text).toContain("info: 1 request shares a name");
    expect(s.undefinedVars).toEqual(["page"]);
    expect(text).toMatch(/1 variable is used but not defined.*\{\{page\}\}/);
    expect(text).toMatch(/1 pre-request or test script was not imported/); // the empty prerequest isn't counted
    expect(text).toMatch(/1 secret value was moved to local files/);
  });

  it("doesn't report variables the workspace already defines", () => {
    expect(summarizeImport(importAny(sources), sources, ["page"]).undefinedVars).toEqual([]);
  });

  it("is quiet for a clean import", () => {
    const clean = [{ path: "c.json", content: JSON.stringify({ info: collection.info, item: [{ name: "Ping", request: { method: "GET", url: "https://api.io/ping" } }] }) }];
    expect(summarizeImport(importAny(clean), clean).issues).toEqual([]);
  });
});
