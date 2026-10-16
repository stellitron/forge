import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
import { mockPath, mockRoutes, parseOrigins } from "../mock";
import { defaults, type Item } from "../types";

describe("mock routes", () => {
  it("take the path a client calls, whatever the host is", () => {
    expect(mockPath("{{baseUrl}}/users/:id?expand=1")).toBe("/users/:id");
    expect(mockPath("https://api.test/v1/orders/{{orderId}}/")).toBe("/v1/orders/{{orderId}}");
    expect(mockPath("{{host}}:{{port}}/health")).toBe("/health");
    expect(mockPath("api.test/x#frag")).toBe("/x");
    expect(mockPath("{{baseUrl}}")).toBe("/");
  });

  it("cover the folder's HTTP requests with their examples", () => {
    const items = [
      { ...defaults.http(), name: "Get user", path: "collections/A/u.json", url: "{{baseUrl}}/users/:id", examples: [{ name: "Found", status: 200, headers: [{ key: "Content-Type", value: "application/json", enabled: true }, { key: "X-Off", value: "1", enabled: false }], body: "{}" }] },
      { ...defaults.http(), name: "Query", path: "collections/A/q.json", url: "{{baseUrl}}/graphql", bodyMode: "graphql" },
      { ...defaults.http(), name: "Other", path: "collections/B/o.json", url: "{{baseUrl}}/o" },
      { ...defaults.ws(), name: "Socket", path: "collections/A/s.json" },
    ] as Item[];
    expect(mockRoutes(items, "collections/A")).toEqual([
      { method: "GET", path: "/users/:id", name: "Get user", examples: [{ name: "Found", status: 200, headers: [["Content-Type", "application/json"]], body: "{}" }] },
      { method: "POST", path: "/graphql", name: "Query", examples: [] },
    ]);
  });

  it("keeps only real origins in the allow list", () => {
    expect(parseOrigins("https://app.dev.test/, http://localhost:3000  bad, https://x.test/path, *")).toEqual(["https://app.dev.test", "http://localhost:3000"]);
  });
});
