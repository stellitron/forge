import { describe, expect, it, vi } from "vitest";
vi.mock("../ipc", () => ({ fs: {}, http: {}, uid: () => "x" }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch }));
import { fromBulk, toBulk } from "../../components/ui";
import { parseSuggestions, suggestPrompt } from "../../components/SuggestButton";
import { autoHeaders } from "../httpKnowledge";
import { defaults, type HttpItem } from "../types";

const item = (p: Partial<HttpItem>) => ({ ...defaults.http(), ...p }) as HttpItem;

describe("bulk edit", () => {
  it("round-trips rows, including disabled ones", () => {
    const rows = [
      { key: "Accept", value: "application/json", enabled: true },
      { key: "X-Debug", value: "1", enabled: false },
    ];
    expect(fromBulk(toBulk(rows))).toEqual(rows);
  });

  it("accepts pasted headers and query strings", () => {
    expect(fromBulk("Host: localhost:8080\nredirect=https://x.io/cb\npage=2&limit=20\n\n// Cookie: a=b")).toEqual([
      { key: "Host", value: "localhost:8080", enabled: true },
      { key: "redirect", value: "https://x.io/cb", enabled: true },
      { key: "page", value: "2", enabled: true },
      { key: "limit", value: "20", enabled: true },
      { key: "Cookie", value: "a=b", enabled: false },
    ]);
  });
});

describe("AI suggestions", () => {
  it("send structure only: no query values, header values or secrets", () => {
    const p = suggestPrompt(
      item({ method: "GET", url: "https://api.x.io/v1/orders?api_key=fake_key_123&status=open", headers: [{ key: "X-Token", value: "abc-secret", enabled: true }], auth: { type: "bearer", token: "real-token-xyz" } }),
      "headers",
      "Last response: HTTP 200, top-level fields: data, page, total",
    );
    expect(p).toContain("GET https://api.x.io/v1/orders");
    expect(p).toContain("api_key, status");
    expect(p).toContain("X-Token");
    for (const leak of ["fake_key_123", "open", "abc-secret", "real-token-xyz"]) expect(p).not.toContain(leak);
  });

  it("keeps only new, well-formed suggestions", () => {
    const text = 'Sure! [{"key":"page","value":"1","why":"pagination"},{"key":"limit","value":"20"},{"key":"Limit","value":"x"},{"key":"bad key!","value":"x"},{"key":"sort","value":"-createdAt","why":"newest first"}]';
    expect(parseSuggestions(text, ["sort"]).map((s) => s.key)).toEqual(["page", "limit"]);
    expect(parseSuggestions("no json here", [])).toEqual([]);
  });
});

describe("auto headers", () => {
  it("show what Forge adds, with placeholders, and step aside for user headers", () => {
    const rows = autoHeaders(item({ bodyMode: "json", auth: { type: "bearer", token: "{{token}}" } }));
    expect(rows.map((r) => `${r.key}: ${r.value}`)).toEqual(["Authorization: Bearer {{token}}", "Content-Type: application/json", "User-Agent: Forge", "Accept-Encoding: gzip, br, deflate, zstd"]);
    const overridden = autoHeaders(item({ bodyMode: "json", headers: [{ key: "content-type", value: "application/vnd.api+json", enabled: true }] }));
    expect(overridden.some((r) => r.key === "Content-Type")).toBe(false);
    expect(autoHeaders(item({ auth: { type: "basic", username: "u", password: "hunter2" } }))[0].value).not.toContain("hunter2");
  });
});
