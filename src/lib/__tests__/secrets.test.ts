import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
let gitignore: string[] = [];
vi.mock("../ipc", async (orig) => ({
  ...(await orig<typeof import("../ipc")>()),
  fs: {
    open: async () => ({ root: "/ws", dirs: ["collections", "environments"], files: [...files].map(([path, content]) => ({ path, content })) }),
    write: async (p: string, c: string) => void files.set(p, c),
    mkdir: async () => {},
    remove: async (p: string) => void files.delete(p),
    rename: async () => {},
    ensureGitignore: async (lines: string[]) => void (gitignore = lines),
    readSettings: async () => "{}",
    writeSettings: async () => {},
  },
}));

const { useStore, secretsPath } = await import("../store");

describe("environment secrets", () => {
  beforeEach(() => {
    files.clear();
    files.set("environments/dev.json", JSON.stringify({ name: "Dev", vars: [{ key: "baseUrl", value: "http://h", enabled: true }] }));
    files.set("environments/dev.local.json", JSON.stringify({ name: "Dev", vars: [{ key: "apiKey", value: "k1", enabled: true }] }));
  });

  it("loads secrets, gitignores them, and keeps captured tokens out of the shared file", async () => {
    const st = useStore.getState();
    await st.openWorkspace("/ws");
    expect(gitignore).toContain("*.local.json");
    useStore.getState().setActiveEnv("environments/dev.json");
    expect(useStore.getState().vars()).toMatchObject({ baseUrl: "http://h", apiKey: "k1" });

    useStore.getState().setVars({ token: "SECRET-TOKEN" });
    await new Promise((r) => setTimeout(r, 0));
    expect(files.get("environments/dev.json")).not.toContain("SECRET-TOKEN");
    expect(files.get(secretsPath("environments/dev.json"))).toContain("SECRET-TOKEN");
    expect(useStore.getState().vars().token).toBe("SECRET-TOKEN");
    // The .local.json file must not show up as its own environment.
    expect(useStore.getState().envs.map((e) => e.name)).toEqual(["Dev"]);
  });
});
