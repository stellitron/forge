import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => import("../../cli/tauriShim"));
vi.mock("@tauri-apps/api/event", () => import("../../cli/tauriShim"));
import { createServer, type Server } from "node:http";
import { buildSchema, graphqlSync } from "graphql";
import { getAutocompleteSuggestions, getDiagnostics } from "graphql-language-service";
import { loadSchema, schemaFromResponse } from "../graphqlSchema";
import { useStore } from "../store";
import { defaults, type Item } from "../types";

const sdl = buildSchema(`
  type User { id: ID!, name: String, email: String, orders(first: Int): [Order] }
  type Order { id: ID!, total: Float }
  type Query { viewer: User, user(id: ID!): User }
`);

let server: Server;
let url = "";
const auths: (string | undefined)[] = [];
beforeAll(async () => {
  server = createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      auths.push(rq.headers.authorization);
      if (rq.url === "/off") return rs.end(JSON.stringify({ errors: [{ message: "GraphQL introspection is not allowed" }] }));
      if (rq.url === "/html") return rs.end("<html>not graphql</html>");
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify(graphqlSync({ schema: sdl, source: JSON.parse(body).query })));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("GraphQL schemas", () => {
  it("load by introspection with the request's inherited auth, and drive completion and checking", async () => {
    const item = { ...defaults.http(), name: "Q", path: "collections/G/q.json", url: "{{gql}}/graphql", bodyMode: "graphql" } as Item & ReturnType<typeof defaults.http>;
    useStore.setState({
      items: { [item.path]: item },
      folders: { "collections/G": { auth: { type: "bearer", token: "{{token}}" }, headers: [], vars: [{ key: "gql", value: url, enabled: true }] } },
      envs: [{ name: "E", path: "environments/e.json", vars: [], secrets: [{ key: "token", value: "tok-123456", enabled: true }] }],
      activeEnv: "environments/e.json",
    });
    const state = await loadSchema(item);
    expect(state.error).toBeUndefined();
    expect(state.types).toBeGreaterThanOrEqual(3);
    expect(auths.at(-1)).toBe("Bearer tok-123456");

    // The same language service the editor uses.
    const query = "query { viewer { na";
    const names = getAutocompleteSuggestions(state.schema!, query, { line: 0, character: query.length } as any).map((s) => s.label);
    expect(names).toContain("name");
    const problems = getDiagnostics("query { viewer { nope } }", state.schema!);
    expect(problems[0].message).toMatch(/Cannot query field "nope" on type "User"/);
  });

  it("explain when introspection is off or the URL isn't GraphQL", async () => {
    await expect(schemaFromResponse(200, JSON.stringify({ errors: [{ message: "introspection is not allowed" }] }))).rejects.toThrow(/Introspection failed: introspection is not allowed/);
    await expect(schemaFromResponse(404, "<html>")).rejects.toThrow(/answered 404 without JSON/);
    await expect(schemaFromResponse(200, "{}")).rejects.toThrow(/without a schema/);
  });
});
