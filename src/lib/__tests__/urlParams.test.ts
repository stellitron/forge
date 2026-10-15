import { describe, expect, it } from "vitest";
import { buildRequest } from "../request";
import { defaults, type HttpItem } from "../types";
import { composeUrl, displayUrl, hasLiteralPlus, paramsFromUrl, pathVarNames, syncPathVars } from "../urlParams";

const item = (p: Partial<HttpItem>) => ({ ...defaults.http(), ...p }) as HttpItem;
const vars = { baseUrl: "https://api.x.io", id: "42", q: "a b" };

describe("URL ⇄ params", () => {
  it("parses the URL into rows and keeps disabled rows", () => {
    const off = { key: "debug", value: "1", enabled: false };
    expect(paramsFromUrl("{{baseUrl}}/products?limit=30&skip={{n}}&flag", [off])).toEqual([
      { key: "limit", value: "30", enabled: true },
      { key: "skip", value: "{{n}}", enabled: true },
      { key: "flag", value: "", enabled: true },
      off,
    ]);
  });

  it("rebuilds the URL from rows, keeping the fragment", () => {
    expect(composeUrl("https://x.io/a?old=1#top", [{ key: "q", value: "{{q}}", enabled: true }, { key: "x", value: "1", enabled: false }])).toBe("https://x.io/a?q={{q}}#top");
    expect(composeUrl("https://x.io/a?old=1", [])).toBe("https://x.io/a");
  });

  it("shows legacy table-only params in the URL bar without changing the file", () => {
    expect(displayUrl("{{baseUrl}}/users", [{ key: "_limit", value: "3", enabled: true }])).toBe("{{baseUrl}}/users?_limit=3");
  });

  it("sends each param once whether it lives in the URL, the table, or both", () => {
    const synced = buildRequest(item({ url: "{{baseUrl}}/p?limit=30&q={{q}}", params: [{ key: "limit", value: "30", enabled: true }, { key: "q", value: "{{q}}", enabled: true }] }), vars);
    expect(synced.url).toBe("https://api.x.io/p?limit=30&q=a%20b");
    const legacy = buildRequest(item({ url: "{{baseUrl}}/p", params: [{ key: "limit", value: "30", enabled: true }] }), vars);
    expect(legacy.url).toBe("https://api.x.io/p?limit=30");
  });
});

describe("special characters in params", () => {
  const rows = (...kv: [string, string][]) => kv.map(([key, value]) => ({ key, value, enabled: true }));

  it("keeps & # = and spaces from breaking the query, and round-trips them", () => {
    const params = rows(["q", "rock & roll #1"], ["a=b", "x=y"], ["pct", "100%"], ["tz", "+05:30"], ["enc", "a%2Bb"]);
    const url = composeUrl("https://x.io/s", params);
    expect(url).toBe("https://x.io/s?q=rock%20%26%20roll%20%231&a%3Db=x=y&pct=100%25&tz=+05:30&enc=a%2Bb");
    expect(paramsFromUrl(url, [])).toEqual(params.map((p) => (p.key === "pct" ? { ...p, value: "100%25" } : p)));
  });

  it("leaves text typed in the URL as written", () => {
    expect(paramsFromUrl("https://x.io?q=a+b&w=%E2%9C%93&e=", [])).toEqual(rows(["q", "a+b"], ["w", "%E2%9C%93"], ["e", ""]));
  });

  it("fully encodes variable values, so tokens with + / = & arrive intact", () => {
    const r = buildRequest(item({ url: "https://x.io/s?sig={{sig}}&lit=a+b&{{qs}}" }), { sig: "ab+c/d==&x", qs: "p=1&r=2" });
    expect(r.url).toBe("https://x.io/s?sig=ab%2Bc%2Fd%3D%3D%26x&lit=a+b&p=1&r=2");
    const k = buildRequest(item({ url: "https://x.io/s", auth: { type: "apikey", key: "key", value: "a+b/c", in: "query" } }), {});
    expect(k.url).toBe("https://x.io/s?key=a%2Bb%2Fc");
  });

  it("flags a literal + outside variables", () => {
    expect(hasLiteralPlus("+05:30")).toBe(true);
    expect(hasLiteralPlus("{{a+b}}")).toBe(false);
  });
});

describe("path variables", () => {
  it("finds :name segments but not ports", () => {
    expect(pathVarNames("http://localhost:8080/users/:id/orders/:orderId?x=:no")).toEqual(["id", "orderId"]);
    expect(pathVarNames("{{baseUrl}}/a/:id")).toEqual(["id"]);
  });

  it("keeps entered values as the URL changes", () => {
    expect(syncPathVars("/users/:userId/posts/:postId", [{ key: "userId", value: "7", enabled: true }])).toEqual([
      { key: "userId", value: "7", enabled: true },
      { key: "postId", value: "", enabled: true },
    ]);
  });

  it("substitutes and encodes them when sending", () => {
    const r = buildRequest(item({ url: "{{baseUrl}}/users/:id/files/:name", pathVars: [{ key: "id", value: "{{id}}", enabled: true }, { key: "name", value: "a/b c", enabled: true }] }), vars);
    expect(r.url).toBe("https://api.x.io/users/42/files/a%2Fb%20c");
  });
});
