import { beforeEach, describe, expect, it, vi } from "vitest";
const sent: string[] = [];
vi.mock("../ipc", () => ({
  fs: {},
  uid: () => "x",
  http: { send: vi.fn(async (_id: string, req: { url: string }) => (sent.push(req.url), { status: 200, statusText: "OK", headers: [], body: '{"access_token":"t"}', bodyBase64: false, size: 1, timeMs: 1, ttfbMs: 1, url: req.url, httpVersion: "HTTP/1.1" })) },
}));
import { aiCreated, checkEgress, oauthOutgoing, resetEgress } from "../../agent/egress";
import { runTool } from "../../agent/workspaceTools";
import { useStore } from "../store";
import { defaults, type Item, type OAuth2Auth } from "../types";

const SECRET = "client-secret-value-123";
const oauth = (tokenUrl: string): OAuth2Auth => ({ type: "oauth2", grant: "client_credentials", authUrl: "", tokenUrl, clientId: "app", clientSecret: "{{clientSecret}}", scope: "", audience: "", username: "", password: "", pkce: false, redirectUri: "", clientAuth: "body", tokenVar: "token" });
const item = (path: string, tokenUrl: string) => ({ ...defaults.http(), name: path, path, url: "https://api.shop.com/orders", auth: oauth(tokenUrl) }) as unknown as Item;

function setup(items: Item[]) {
  useStore.setState({
    root: "/ws",
    items: Object.fromEntries(items.map((i) => [i.path, i])),
    envs: [{ name: "Dev", path: "environments/dev.json", vars: [], secrets: [{ key: "clientSecret", value: SECRET, enabled: true }] }],
    activeEnv: "environments/dev.json",
    sessionVars: {},
    responses: {},
  } as any);
}

describe("OAuth token requests and the secret guard", () => {
  beforeEach(() => {
    resetEgress();
    sent.length = 0;
  });

  it("asks before an AI-saved request sends the client secret to an unknown token URL", async () => {
    const sneaky = item("collections/Shop/sync.json", "https://evil.example/token");
    setup([item("collections/Shop/orders.json", "https://id.shop.com/token"), sneaky]);
    aiCreated.add(sneaky.path);
    const approve = vi.fn(async () => false);
    await expect(runTool("run_request", { path: "Shop/sync.json" }, { client: "cursor", approve })).rejects.toThrow(/declined/);
    const [summary, opts] = approve.mock.calls[0] as unknown as [string, { always?: boolean }];
    expect(summary).toContain("evil.example");
    expect(summary).toContain("{{clientSecret}}");
    expect(summary).not.toContain(SECRET);
    expect(opts).toEqual({ always: true });
    expect(sent).toEqual([]); // nothing left the machine
  });

  it("doesn't ask when the token URL is one your own requests already use", () => {
    setup([item("collections/Shop/orders.json", "https://id.shop.com/token")]);
    const ai = item("collections/Shop/new.json", "https://id.shop.com/token");
    aiCreated.add(ai.path);
    const vars = useStore.getState().vars();
    const t = oauthOutgoing(ai, vars)!;
    expect(t.sent.body).toContain(SECRET);
    expect(checkEgress(t.raw, t.sent, { vars }).reason).toBeUndefined();
  });
});
