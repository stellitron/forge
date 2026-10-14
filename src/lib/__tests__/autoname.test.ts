import { describe, expect, it, vi } from "vitest";
vi.mock("../ipc", () => ({ fs: {}, http: {}, uid: () => "x" }));
import { suggestName } from "../autoname";
import { defaults, type Item } from "../types";

const http = (method: string, url: string, extra: object = {}) => ({ ...defaults.http(), method, url, name: "New request", path: "x", ...extra }) as Item;

describe("auto names", () => {
  it.each([
    ["GET", "{{baseUrl}}/products", "List products"],
    ["GET", "https://dummyjson.com/products/{{id}}", "Get product"],
    ["GET", "https://api.x.io/v2/users/42", "Get user"],
    ["POST", "{{baseUrl}}/api/v1/orders", "Create order"],
    ["PATCH", "/categories/:id", "Update category"],
    ["DELETE", "/users/{{userId}}/addresses/7", "Delete address"],
    ["POST", "https://dummyjson.com/auth/login", "Login auth"],
    ["GET", "https://dummyjson.com/products/search?q=phone", "Search products"],
    ["GET", "/users/me", "Get current user"],
    ["GET", "https://status.x.io/health", "Health check"],
    ["GET", "https://example.com/", "Get example.com"],
    ["PUT", "/companies", "Replace companies"],
  ])("%s %s → %s", (m, u, want) => expect(suggestName(http(m, u))).toBe(want));

  it("uses GraphQL operation names", () => {
    expect(suggestName(http("POST", "/graphql", { bodyMode: "graphql", graphql: { query: "query GetUserOrders { user { id } }", variables: "{}" } }))).toBe("Get user orders");
  });

  it("names MCP servers from their package", () => {
    const mcp = (args: string) => ({ ...defaults.mcp(), transport: "stdio", command: "npx", args, name: "New MCP server", path: "m" }) as Item;
    expect(suggestName(mcp("-y @modelcontextprotocol/server-everything"))).toBe("Everything MCP");
    expect(suggestName(mcp("-y github-mcp-server@1.2.0"))).toBe("Github MCP");
    expect(suggestName(mcp("/opt/tools/weather_server.py"))).toBe("Weather MCP");
  });

  it("waits for a URL", () => expect(suggestName(http("GET", ""))).toBeNull());
});
