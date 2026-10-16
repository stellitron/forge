import { interpolate } from "../lib/eval";
import { effectiveItem } from "../lib/inherit";
import { useStore } from "../lib/store";
import type { Item } from "../lib/types";

/**
 * Guards AI-built requests against leaking secrets. Forge fills {{token}} placeholders itself,
 * so the model never sees the values, but the server receiving the request does. A model that
 * has been manipulated (e.g. by text in a page or response it read) could aim a harmless-looking
 * GET at someone else's server with {{token}} in it. So a request needs the user's OK when it
 * goes to a host none of the saved requests use, or carries a secret to a host where the saved
 * requests don't send that secret.
 */

export interface Outgoing {
  url: string;
  headers: { key: string; value: string }[];
  body?: string;
}

export interface EgressVerdict {
  host: string;
  /** Names of the secret variables whose values the request carries. */
  secrets: string[];
  /** Why approval is needed; undefined when the request is in line with saved requests. */
  reason?: string;
}

/** Items the AI saved in this session; they don't vouch for their own hosts. */
export const aiCreated = new Set<string>();
/** host → secret names the user already allowed there in this session ("*" = the host itself). */
const allowed = new Map<string, Set<string>>();

const MIN_SECRET = 6;

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Active environment secrets plus values captured during the session (tokens from logins). */
export function secretValues(): [string, string][] {
  const { envs, activeEnv, sessionVars } = useStore.getState();
  const env = envs.find((e) => e.path === activeEnv);
  const out: [string, string][] = [];
  for (const v of env?.secrets ?? []) if (v.enabled && v.value.length >= MIN_SECRET) out.push([v.key, v.value]);
  for (const [k, v] of Object.entries(sessionVars ?? {})) if (typeof v === "string" && v.length >= MIN_SECRET) out.push([k, v]);
  return out;
}

function carried(text: string, secrets: [string, string][]): string[] {
  const names = new Set<string>();
  for (const [k, v] of secrets) if (text.includes(v) || text.includes(encodeURIComponent(v))) names.add(k);
  return [...names];
}

const flatten = (o: Outgoing) => [o.url, ...o.headers.map((h) => `${h.key}: ${h.value}`), o.body ?? ""].join("\n");

/**
 * Hosts the user's own saved requests and environments talk to, with the secrets each one receives.
 * Imported items and environments the user hasn't trusted yet don't count, or a collection could
 * vouch for its own server (`includeUntrusted` is only for explaining a prompt).
 */
export function knownHosts(vars: Record<string, string>, secrets: [string, string][], extraHosts: string[] = [], includeUntrusted = false): Map<string, Set<string>> {
  const known = new Map<string, Set<string>>();
  const add = (host: string, names: string[] = []) => {
    if (!host) return;
    const s = known.get(host) ?? new Set<string>();
    names.forEach((n) => s.add(n));
    known.set(host, s);
  };
  const { items, envs, folders, isTrusted, isEnvTrusted, isFolderTrusted, varsFor } = useStore.getState();
  for (const it of Object.values(items) as Item[]) {
    if (aiCreated.has(it.path) || (!includeUntrusted && !isTrusted(it)) || !("url" in it) || typeof it.url !== "string") continue;
    // Collection and folder variables, headers and inherited auth are part of what the request sends.
    const v = { ...varsFor(it.path), ...vars };
    const sent = it.kind === "http" ? effectiveItem(it) : it;
    let url = interpolate(it.url, v);
    if (it.kind === "ws") url = url.replace(/^ws/i, "http");
    const names = carried(interpolate(JSON.stringify(sent), v), secrets);
    add(hostOf(url), names);
    // The user's own OAuth endpoints receive their client secret and tokens.
    if (sent.kind === "http" && sent.auth.type === "oauth2") add(hostOf(interpolate(sent.auth.tokenUrl, v)), names);
  }
  // Base URLs in trusted collection and folder variables count as the user's own APIs, like environments'.
  for (const [p, f] of Object.entries(folders)) if (includeUntrusted || isFolderTrusted(p)) for (const x of f.vars) if (x.enabled && /^https?:\/\//i.test(x.value)) add(hostOf(interpolate(x.value, vars)));
  // Base URLs in any environment count as the user's own APIs.
  for (const e of envs.filter((x) => includeUntrusted || isEnvTrusted(x))) for (const v of e.vars) if (/^https?:\/\//i.test(v.value)) add(hostOf(interpolate(v.value, vars)));
  for (const h of extraHosts) add(h);
  for (const [h, names] of allowed) add(h, [...names]);
  return known;
}

export function checkEgress(raw: Outgoing, sent: Outgoing, opts: { vars: Record<string, string>; extraHosts?: string[]; ignore?: Set<string> }): EgressVerdict {
  const secrets = secretValues();
  const host = hostOf(sent.url);
  const used = carried(flatten(sent), secrets).filter((n) => !opts.ignore?.has(n));
  const known = knownHosts(opts.vars, secrets, opts.extraHosts);
  const v: EgressVerdict = { host, secrets: used };
  if (!host) return v; // invalid URL; the request will fail on its own
  const where = known.get(host);
  // Show placeholders, not values, in the prompt.
  const shown = `${raw.url.length > 140 ? raw.url.slice(0, 140) + "…" : raw.url}`;
  const carrying = used.length ? ` It would carry the secret value${used.length > 1 ? "s" : ""} of ${used.map((n) => `{{${n}}}`).join(", ")}.` : "";
  const imported = !where && knownHosts(opts.vars, secrets, opts.extraHosts, true).has(host) ? " Only requests you haven't trusted use it." : "";
  if (!where) v.reason = `Request to ${host}, which none of your saved requests use: ${shown}.${carrying}${imported}`;
  else {
    const fresh = used.filter((n) => !where.has(n));
    if (fresh.length) v.reason = `Request sends ${fresh.map((n) => `{{${n}}}`).join(", ")} to ${host}, where your saved requests don't send it: ${shown}.`;
  }
  return v;
}

/**
 * The OAuth 2.0 token request an item makes before its main request. It goes to a different host
 * (the token URL) and carries the client secret, a password or a refresh token, so it needs its
 * own check: the main request's check never sees it.
 */
export function oauthOutgoing(item: Item, vars: Record<string, string>): { raw: Outgoing; sent: Outgoing } | null {
  if (item.kind !== "http" || item.auth.type !== "oauth2") return null;
  const a = item.auth;
  const t = a.tokenVar.trim() || "token";
  const body = [`client_id=${a.clientId}`, `client_secret=${a.clientSecret}`, `username=${a.username}`, `password=${a.password}`, `refresh_token={{${t}_refresh}}`].join("&");
  const raw: Outgoing = { url: a.tokenUrl, headers: [], body };
  return { raw, sent: { url: interpolate(a.tokenUrl, vars), headers: [], body: interpolate(body, vars) } };
}

/** Remembers an approved host + secrets so the same kind of request isn't asked about again this session. */
export function allow(v: EgressVerdict) {
  const s = allowed.get(v.host) ?? new Set<string>();
  v.secrets.forEach((n) => s.add(n));
  allowed.set(v.host, s);
}

export function resetEgress() {
  allowed.clear();
  aiCreated.clear();
}
