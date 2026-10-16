import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { send } from "./nodeHttp";

/**
 * Stands in for the Tauri bridge when Forge's code runs from the command line. HTTP goes through
 * Node; the workspace is read from disk. Writes are ignored on purpose: a test run in CI must
 * never change files, and captured tokens stay in memory.
 */

const SKIP = new Set(["node_modules", "target", "dist"]);

export function readTree(root: string) {
  const abs = resolve(root);
  const dirs: string[] = [];
  const files: { path: string; content: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const p = join(dir, name);
      const rel = relative(abs, p).split(sep).join("/");
      const st = statSync(p);
      if (st.isDirectory()) {
        dirs.push(rel);
        walk(p);
      } else if (name.endsWith(".json") && st.size < 5_000_000) files.push({ path: rel, content: readFileSync(p, "utf8") });
    }
  };
  walk(abs);
  return { root: abs, dirs, files };
}

export async function invoke<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  switch (cmd) {
    case "http_send":
      return (await send(args.request)) as T;
    case "workspace_open":
      return readTree(args.path) as T;
    case "settings_read":
      return "{}" as T;
    case "appdata_read":
      return "" as T;
    case "http_cancel":
    case "http_reset_cookies":
    case "settings_write":
    case "appdata_write":
    case "workspace_write":
    case "workspace_mkdir":
    case "workspace_ensure_gitignore":
      return undefined as T;
    default:
      throw new Error(`${cmd} isn't available from the command line.`);
  }
}

export const listen = async () => () => {};
export const openUrl = async () => {
  throw new Error("Opening a browser isn't available from the command line.");
};
export const revealItemInDir = openUrl;
export const open = openUrl;
export const save = openUrl;
export const ask = async () => false;
export const fetch = globalThis.fetch;
