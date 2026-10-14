import { create } from "zustand";
import { useStore } from "./store";

/**
 * Over-the-air updates through the Tauri updater. Releases are signed in CI; the app only installs
 * an update whose signature matches the public key built into it (tauri.conf.json), so a
 * compromised download server can't push code. Nothing is downloaded without the user's click.
 */

type Status = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error" | "unsupported";

interface UpdateState {
  status: Status;
  current: string;
  version?: string;
  notes?: string;
  date?: string;
  progress?: number;
  error?: string;
  checkedAt?: number;
}

export const useUpdates = create<UpdateState>(() => ({ status: "idle", current: "" }));

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let pending: { downloadAndInstall: (cb: (e: any) => void) => Promise<void> } | null = null;

export async function loadVersion() {
  if (!inTauri()) return useUpdates.setState({ status: "unsupported", current: "dev" });
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    useUpdates.setState({ current: await getVersion() });
  } catch {
    // The browser preview mocks Tauri without the app plugin.
    useUpdates.setState({ status: "unsupported", current: "dev" });
  }
}

/** silent: background check; errors (offline, no release yet) are kept out of the user's way. */
export async function checkForUpdates(silent = false) {
  if (!inTauri() || useUpdates.getState().status === "unsupported") return useUpdates.setState({ status: "unsupported" });
  if (["checking", "downloading"].includes(useUpdates.getState().status)) return;
  useUpdates.setState({ status: "checking", error: undefined });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    pending = u;
    if (u) {
      useUpdates.setState({ status: "available", version: u.version, notes: u.body ?? "", date: u.date ?? undefined, checkedAt: Date.now() });
      if (silent) useStore.getState().notify(`Forge ${u.version} is available. Install it from Settings › Updates.`);
    } else useUpdates.setState({ status: "latest", checkedAt: Date.now() });
  } catch (e) {
    useUpdates.setState({ status: silent ? "idle" : "error", error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() });
  }
}

export async function installUpdate() {
  if (!pending) return;
  let total = 0;
  let got = 0;
  useUpdates.setState({ status: "downloading", progress: 0 });
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        useUpdates.setState({ progress: total ? got / total : undefined });
      }
    });
    useUpdates.setState({ status: "ready" });
  } catch (e) {
    useUpdates.setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export async function relaunchApp() {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Checks shortly after launch and then every 6 hours, unless turned off in Settings. */
export async function startUpdateChecks() {
  await loadVersion();
  const tick = () => useStore.getState().settings.updates?.auto !== false && checkForUpdates(true);
  setTimeout(tick, 8000);
  setInterval(tick, 6 * 60 * 60 * 1000);
}
