import { describe, expect, it, vi } from "vitest";
const disk: Record<string, string> = {};
let jar = "";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: any) => {
    if (cmd === "cookies_export") return jar;
    if (cmd === "cookies_import") return void (jar = args.text);
    return undefined;
  },
}));
vi.mock("../ipc", () => ({ afterSend: new Set(), fs: { write: async () => {}, writeSettings: async () => {}, readAppData: async (n: string) => disk[n] ?? "", writeAppData: async (n: string, c: string) => void (disk[n] = c) } }));
vi.stubGlobal("window", globalThis);
import { startCookieJars } from "../cookies";
import { useStore } from "../store";

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("cookie jars per environment", () => {
  it("swaps cookies when the environment changes and restores them when it comes back", async () => {
    useStore.setState({ root: "/ws", activeEnv: "environments/staging.json", settings: { ...useStore.getState().settings, cookies: undefined } });
    startCookieJars();
    await settle();
    jar = "staging-session";
    useStore.setState({ activeEnv: "environments/prod.json" });
    await settle();
    expect(jar).toBe(""); // production starts empty
    jar = "prod-session";
    useStore.setState({ activeEnv: "environments/staging.json" });
    await settle();
    expect(jar).toBe("staging-session");
    // Both were saved to app data, under names that don't reveal the workspace or environment.
    expect(Object.values(disk).sort()).toEqual(["prod-session", "staging-session"]);
    expect(Object.keys(disk).every((k) => /^cookies-[0-9a-f]{16}\.json$/.test(k))).toBe(true);
  });

  it("keeps cookies in memory only when persistence is off", async () => {
    for (const k of Object.keys(disk)) delete disk[k];
    useStore.setState({ settings: { ...useStore.getState().settings, cookies: { persist: false } } });
    jar = "in-memory";
    useStore.setState({ activeEnv: "environments/dev.json" });
    await settle();
    useStore.setState({ activeEnv: "environments/staging.json" });
    await settle();
    expect(disk).toEqual({});
    useStore.setState({ activeEnv: "environments/dev.json" });
    await settle();
    expect(jar).toBe("");
  });
});
