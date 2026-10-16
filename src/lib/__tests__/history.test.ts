import { beforeEach, describe, expect, it, vi } from "vitest";
const written: Record<string, string> = {};
vi.mock("../ipc", () => ({ fs: { write: async () => {}, writeSettings: async () => {}, readAppData: async (n: string) => written[n] ?? "", writeAppData: async (n: string, c: string) => void (written[n] = c) }, http: {}, uid: () => "x" }));
vi.stubGlobal("window", globalThis);
import { HIDDEN, MAX_BODY, MAX_ENTRIES, entryToItem, maskEntry, maskText, resolveEntry, useHistory, type HistoryEntry } from "../history";
import { useStore } from "../store";
import type { HttpResponse } from "../types";

const TOKEN = "tok_9f8e7d6c5b4a";
const secrets: [string, string][] = [["token", TOKEN], ["apiKey", "key/with+chars=="]];
const res = (body: string, extra: Partial<HttpResponse> = {}): HttpResponse => ({ status: 200, statusText: "OK", httpVersion: "HTTP/1.1", url: "", headers: [], body, bodyBase64: false, size: body.length, timeMs: 12, ttfbMs: 5, ...extra });
const entry = (p: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "1",
  ts: 0,
  name: "Get user",
  source: "request",
  req: { method: "GET", url: "https://api.test/users?key=key%2Fwith%2Bchars%3D%3D", headers: [{ key: "Authorization", value: `Bearer ${TOKEN}`, enabled: true }] },
  ...p,
});

describe("masking", () => {
  it("turns secret values, plain or URL-encoded, back into placeholders", () => {
    expect(maskText(`a ${TOKEN} b`, secrets)).toBe("a {{token}} b");
    expect(maskText("q=key%2Fwith%2Bchars%3D%3D", secrets)).toBe("q={{apiKey}}");
    expect(maskText("short", [["x", "abc"]])).toBe("short");
  });

  it("masks the request and response, and hides credentials no variable holds", () => {
    const m = maskEntry(
      entry({
        req: { method: "POST", url: "https://api.test/login", headers: [{ key: "Authorization", value: `Bearer ${TOKEN}`, enabled: true }, { key: "Cookie", value: "sid=pasted-in-by-hand", enabled: true }], body: { type: "raw", content: `{"token":"${TOKEN}"}` }, clientCert: { cert: "/c.pem", key: "/k.pem" } },
        res: res(`{"access_token":"${TOKEN}"}`, { headers: [{ key: "Set-Cookie", value: "sid=abc123456; HttpOnly", enabled: true }] }),
      }),
      secrets,
    );
    expect(m.req.headers.map((h) => h.value)).toEqual(["Bearer {{token}}", HIDDEN]);
    expect(m.req.body).toEqual({ type: "raw", content: '{"token":"{{token}}"}' });
    expect(m.req.clientCert).toBeUndefined();
    expect(m.res!.body).toBe('{"access_token":"{{token}}"}');
    expect(m.res!.headers[0].value).toBe(HIDDEN);
    expect(JSON.stringify(m)).not.toContain(TOKEN);
  });

  it("keeps large bodies short and drops binary ones", () => {
    expect(maskEntry(entry({ res: res("x".repeat(MAX_BODY + 10)) }), []).res!.body.length).toBe(MAX_BODY);
    expect(maskEntry(entry({ res: res("x".repeat(MAX_BODY + 10)) }), []).truncated).toBe(true);
    expect(maskEntry(entry({ res: res("AAEC", { bodyBase64: true }) }), []).res!.body).toBe("");
  });
});

describe("using an entry again", () => {
  it("fills in today's values, and refuses when a credential was hidden", () => {
    const m = maskEntry(entry(), secrets);
    expect(resolveEntry(m, { token: "new-token", apiKey: "k2" }).headers[0].value).toBe("Bearer new-token");
    expect(() => resolveEntry({ ...m, req: { ...m.req, headers: [{ key: "Cookie", value: HIDDEN, enabled: true }] } }, {})).toThrow(/typed in directly/);
  });

  it("rebuilds a saved request with auth, params and body", () => {
    const d = entryToItem(
      maskEntry(entry({ req: { method: "POST", url: "https://api.test/users?page=2", headers: [{ key: "Authorization", value: `Bearer ${TOKEN}`, enabled: true }, { key: "Content-Type", value: "application/json", enabled: true }, { key: "X-Tenant", value: "acme", enabled: true }], body: { type: "raw", content: '{"a":1}' } } }), secrets),
    );
    expect(d).toMatchObject({ method: "POST", url: "https://api.test/users?page=2", auth: { type: "bearer", token: "{{token}}" }, bodyMode: "json", body: '{"a":1}' });
    expect(d.params).toEqual([{ key: "page", value: "2", enabled: true }]);
    expect(d.headers.map((h) => h.key)).toEqual(["X-Tenant"]);
  });
});

describe("the history store", () => {
  beforeEach(async () => {
    useStore.setState({ settings: { ...useStore.getState().settings, history: undefined }, envs: [], activeEnv: null, sessionVars: {} });
    useHistory.setState({ root: null, entries: [] });
    await useHistory.getState().load("/ws");
  });

  it("keeps the newest entries, up to the limit", () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) useHistory.getState().add({ name: `r${i}`, source: "request", req: { method: "GET", url: `https://x.test/${i}`, headers: [] } });
    const { entries } = useHistory.getState();
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].name).toBe(`r${MAX_ENTRIES + 4}`);
  });

  it("records nothing when history is off", () => {
    useStore.setState({ settings: { ...useStore.getState().settings, history: { enabled: false } } });
    expect(useHistory.getState().add({ name: "r", source: "request", req: { method: "GET", url: "https://x.test", headers: [] } })).toBeNull();
    expect(useHistory.getState().entries).toEqual([]);
  });

  it("masks with the active environment's secrets", () => {
    useStore.setState({ envs: [{ name: "E", path: "environments/e.json", vars: [], secrets: [{ key: "token", value: TOKEN, enabled: true }] }], activeEnv: "environments/e.json" });
    const e = useHistory.getState().add({ name: "r", source: "request", req: { method: "GET", url: `https://x.test/?t=${TOKEN}`, headers: [] } });
    expect(e!.req.url).toBe("https://x.test/?t={{token}}");
  });
});
