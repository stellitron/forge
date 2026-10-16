import { sha256Sync } from "./crypto";
import type { Environment, FolderSettings, Item } from "./types";

/**
 * Which requests and environments count as yours. Trust lives in Forge's own settings, outside the
 * workspace, as fingerprints of content you created, edited or trusted, so a collection can't
 * vouch for itself: not by a line in its files, not by arriving through git, not by changing
 * after you trusted it. Only what decides where a request goes and what it carries is
 * fingerprinted, so renaming, moving or documenting a request keeps its trust.
 */

const FIELDS: Record<string, string[]> = {
  http: ["method", "url", "params", "pathVars", "headers", "auth", "bodyMode", "body", "form", "multipart", "graphql", "preScript", "postScript", "settings"],
  mcp: ["transport", "command", "args", "env", "cwd", "url", "headers"],
  a2a: ["url", "headers"],
  ws: ["url", "headers", "message"],
  web: ["url"],
  radar: ["url", "browser"],
  agent: ["goal", "baseUrl", "specUrl", "mcpRef", "a2aRef", "approveMutations"],
};

/** JSON with sorted keys and no undefined values, so equal content always hashes the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export function fingerprint(item: Item): string {
  const o = item as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = { kind: item.kind };
  for (const k of FIELDS[item.kind] ?? []) picked[k] = o[k];
  return sha256Sync(canonical(picked));
}

/** Everything a folder passes down decides where its requests go and what they carry. */
export const folderFingerprint = (path: string, f: FolderSettings) =>
  sha256Sync(canonical({ folder: path, auth: f.auth, headers: f.headers, vars: f.vars, preScript: f.preScript, postScript: f.postScript }));

/** Only the shared variables matter: their URLs count as your hosts. Secrets stay local. */
export const envFingerprint = (env: Environment) => sha256Sync(canonical({ env: env.path, vars: env.vars }));
