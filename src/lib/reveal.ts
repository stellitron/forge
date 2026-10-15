import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "./store";

const platform = typeof navigator === "undefined" ? "" : navigator.userAgent;

/** "Reveal in Finder" on macOS, "Show in Explorer" on Windows, "Show in folder" elsewhere. */
export const revealLabel = /Mac/.test(platform) ? "Reveal in Finder" : /Windows/.test(platform) ? "Show in Explorer" : "Show in folder";

/** Opens the system file manager with a workspace file or folder selected ("" for the workspace itself). */
export async function reveal(relPath = "") {
  const { root, notify } = useStore.getState();
  if (!root) return;
  const sep = root.includes("\\") ? "\\" : "/";
  const full = relPath ? `${root.replace(/[\\/]+$/, "")}${sep}${relPath.split("/").join(sep)}` : root;
  try {
    await revealItemInDir(full);
  } catch (e) {
    notify(`Couldn't open ${full}: ${e instanceof Error ? e.message : e}`, "error");
  }
}
