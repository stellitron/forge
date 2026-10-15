import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { interpolate } from "./eval";
import { http, uid } from "./ipc";
import { pkceChallenge } from "./auth";
import { randomString } from "./crypto";
import { useStore } from "./store";
import type { KV, OAuth2Auth } from "./types";

/**
 * OAuth 2.0 tokens for a request: client credentials, password, and authorization code with
 * PKCE through a loopback redirect (RFC 8252). Tokens are stored as secrets of the active
 * environment (gitignored), under tokenVar plus tokenVar_refresh and tokenVar_expires, so they
 * are shared by every request that uses the same variable and survive restarts.
 */

const SKEW_MS = 60_000;

export const tokenVarOf = (a: OAuth2Auth) => a.tokenVar.trim() || "token";

export function tokenState(a: OAuth2Auth, vars = useStore.getState().vars()) {
  const t = tokenVarOf(a);
  const expires = Number(vars[`${t}_expires`] || 0);
  return {
    token: vars[t] || "",
    refresh: vars[`${t}_refresh`] || "",
    expiresAt: expires || null,
    expired: !!expires && Date.now() > expires - SKEW_MS,
  };
}

/** Makes sure a usable token is stored. Only the authorization code grant needs a browser. */
export async function ensureOAuthToken(a: OAuth2Auth, opts: { interactive: boolean }): Promise<void> {
  const s = tokenState(a);
  if (s.token && !s.expired) return;
  if (s.refresh) {
    try {
      return await refreshToken(a);
    } catch {
      // Fall through to a new token.
    }
  }
  if (a.grant !== "authorization_code") return getNewToken(a);
  if (!opts.interactive) throw new Error("This request needs an OAuth sign-in. Open it and choose Get new token in the Auth tab.");
  return getNewToken(a);
}

let pending: string | null = null;

/** Gets a fresh token with the configured grant. */
export async function getNewToken(a: OAuth2Auth): Promise<void> {
  const v = (s: string) => interpolate(s, useStore.getState().vars());
  if (!v(a.tokenUrl)) throw new Error("Enter the token URL.");
  if (a.grant === "client_credentials") return exchange(a, [["grant_type", "client_credentials"]]);
  if (a.grant === "password")
    return exchange(a, [
      ["grant_type", "password"],
      ["username", v(a.username)],
      ["password", v(a.password)],
    ]);

  // Authorization code: the browser signs in and comes back to a loopback address Forge listens on.
  if (!v(a.authUrl)) throw new Error("Enter the authorization URL.");
  const redirect = new URL(v(a.redirectUri) || "http://127.0.0.1/callback");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname))
    throw new Error("The redirect URL must be a loopback address such as http://127.0.0.1:8765/callback, so Forge can receive the sign-in.");
  const id = uid();
  if (pending) await cancelSignIn();
  pending = id;
  const port = await invoke<number>("oauth_listen", { id, port: Number(redirect.port) || 0 });
  redirect.port = String(port);
  const state = randomString(24);
  const verifier = randomString(64);
  const url = new URL(v(a.authUrl));
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", v(a.clientId));
  q.set("redirect_uri", redirect.toString());
  q.set("state", state);
  if (v(a.scope)) q.set("scope", v(a.scope));
  if (v(a.audience)) q.set("audience", v(a.audience));
  if (a.pkce) {
    q.set("code_challenge", await pkceChallenge(verifier));
    q.set("code_challenge_method", "S256");
  }
  await openUrl(url.toString());
  let query: string;
  try {
    query = await invoke<string>("oauth_wait", { id, timeoutMs: 5 * 60_000 });
  } finally {
    if (pending === id) pending = null;
  }
  const back = new URLSearchParams(query);
  if (back.get("error")) throw new Error(`Sign-in failed: ${back.get("error_description") || back.get("error")}`);
  if (back.get("state") !== state) throw new Error("Sign-in failed: the response didn't match this request (state mismatch). Try again.");
  return exchange(a, [
    ["grant_type", "authorization_code"],
    ["code", back.get("code") ?? ""],
    ["redirect_uri", redirect.toString()],
    ...(a.pkce ? ([["code_verifier", verifier]] as [string, string][]) : []),
  ]);
}

export async function cancelSignIn() {
  if (pending) await invoke("oauth_cancel", { id: pending }).catch(() => {});
  pending = null;
}

export async function refreshToken(a: OAuth2Auth): Promise<void> {
  const { refresh } = tokenState(a);
  if (!refresh) throw new Error("No refresh token stored.");
  return exchange(a, [
    ["grant_type", "refresh_token"],
    ["refresh_token", refresh],
  ]);
}

export function clearToken(a: OAuth2Auth) {
  const t = tokenVarOf(a);
  useStore.getState().setVars({ [t]: "", [`${t}_refresh`]: "", [`${t}_expires`]: "" });
}

async function exchange(a: OAuth2Auth, fields: [string, string][]): Promise<void> {
  const v = (s: string) => interpolate(s, useStore.getState().vars());
  const id = v(a.clientId);
  const secret = v(a.clientSecret);
  const headers: KV[] = [{ key: "Accept", value: "application/json", enabled: true }];
  const body: [string, string][] = [...fields];
  if (a.clientAuth === "basic" && id) {
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
    headers.push({ key: "Authorization", value: `Basic ${btoa(`${enc(id)}:${enc(secret)}`)}`, enabled: true });
  } else {
    if (id) body.push(["client_id", id]);
    if (secret) body.push(["client_secret", secret]);
  }
  if (v(a.scope) && !fields.some(([k]) => k === "code" || k === "refresh_token")) body.push(["scope", v(a.scope)]);
  if (v(a.audience) && fields[0][1] !== "refresh_token") body.push(["audience", v(a.audience)]);

  const res = await http.send(uid(), { method: "POST", url: v(a.tokenUrl), headers, body: { type: "form", fields: body.map(([key, value]) => ({ key, value, enabled: true })) }, timeoutMs: 30000 }, "OAuth token");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(res.body);
  } catch {
    data = Object.fromEntries(new URLSearchParams(res.body));
  }
  if (res.status >= 400 || data.error || !data.access_token)
    throw new Error(`Token request failed (HTTP ${res.status}): ${String(data.error_description || data.error || res.body.slice(0, 200) || "no access_token in the response")}`);
  const t = tokenVarOf(a);
  const expiresIn = Number(data.expires_in || 0);
  useStore.getState().setVars({
    [t]: String(data.access_token),
    ...(data.refresh_token ? { [`${t}_refresh`]: String(data.refresh_token) } : {}),
    [`${t}_expires`]: expiresIn ? String(Date.now() + expiresIn * 1000) : "",
  });
}
