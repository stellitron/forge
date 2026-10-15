import { digestHeader, hawkHeader, jwtClaims, parseDigestChallenge, signAwsV4, signJwt } from "./auth";
import { interpolate } from "./eval";
import { http, type RawRequest } from "./ipc";
import { ensureOAuthToken, refreshToken, tokenState } from "./oauth";
import { buildRequest } from "./request";
import { useStore } from "./store";
import type { Auth, HttpItem, HttpResponse, KV } from "./types";

/**
 * Sends a saved request with its auth applied: OAuth tokens are fetched or refreshed first, AWS,
 * Hawk and JWT are signed against the final request, and Digest answers the server's challenge.
 */
export async function sendItem(item: HttpItem, requestId: string, source: string, opts: { interactive: boolean }): Promise<{ req: RawRequest; res: HttpResponse }> {
  const auth = item.auth;
  if (auth.type === "oauth2") await ensureOAuthToken(auth, opts);
  const vars = useStore.getState().vars();
  const req = await signRequest(buildRequest(item, vars), auth, vars);
  if (!req.url) throw new Error("Enter a URL");
  let res = await http.send(requestId, req, source);

  if (res.status === 401 && auth.type === "digest") {
    const challenge = res.headers.filter((h) => h.key.toLowerCase() === "www-authenticate").map((h) => parseDigestChallenge(h.value)).find(Boolean);
    if (challenge) {
      const u = new URL(req.url);
      const header = await digestHeader({ method: req.method, uri: u.pathname + u.search, username: interpolate(auth.username, vars), password: interpolate(auth.password, vars), challenge });
      res = await http.send(requestId, withAuth(req, header), source);
    }
  }
  // A token can be revoked or expire early; refresh once and retry.
  if (res.status === 401 && auth.type === "oauth2" && tokenState(auth).refresh) {
    try {
      await refreshToken(auth);
      const again = buildRequest(item, useStore.getState().vars());
      res = await http.send(requestId, again, source);
      return { req: again, res };
    } catch {
      // Keep the original 401.
    }
  }
  return { req, res };
}

const withAuth = (req: RawRequest, value: string, extra: KV[] = []): RawRequest => ({
  ...req,
  headers: [...req.headers.filter((h) => h.key.toLowerCase() !== "authorization" && !extra.some((e) => e.key.toLowerCase() === h.key.toLowerCase())), ...extra, ...(value ? [{ key: "Authorization", value, enabled: true }] : [])],
});

/** Applies auth that depends on the final URL, headers or body. Others pass through unchanged. */
export async function signRequest(req: RawRequest, auth: Auth, vars: Record<string, string>): Promise<RawRequest> {
  const v = (s: string) => interpolate(s, vars);
  if (auth.type === "awsv4") {
    let r = req;
    // Form bodies are encoded here so the signed hash matches the bytes sent.
    if (r.body?.type === "form") {
      const content = new URLSearchParams(r.body.fields.filter((f) => f.enabled).map((f) => [f.key, f.value])).toString();
      r = { ...r, body: { type: "raw", content } };
      if (!r.headers.some((h) => h.key.toLowerCase() === "content-type")) r.headers = [...r.headers, { key: "Content-Type", value: "application/x-www-form-urlencoded", enabled: true }];
    }
    const body = !r.body || r.body.type === "none" ? "" : r.body.type === "raw" ? r.body.content : null;
    const signed = await signAwsV4({ method: r.method, url: r.url, headers: r.headers, body, accessKey: v(auth.accessKey), secretKey: v(auth.secretKey), sessionToken: v(auth.sessionToken), region: v(auth.region), service: v(auth.service) });
    const authz = signed.find((h) => h.key === "Authorization")!.value;
    return withAuth(r, authz, signed.filter((h) => h.key !== "Authorization"));
  }
  if (auth.type === "hawk") return withAuth(req, await hawkHeader({ method: req.method, url: req.url, id: v(auth.id), key: v(auth.key), algorithm: auth.algorithm, ext: v(auth.ext) }));
  if (auth.type === "jwt") {
    const token = await signJwt(auth.algorithm, v(auth.secret), jwtClaims(v(auth.payload), auth.expiresIn));
    return withAuth(req, `${v(auth.prefix)} ${token}`.trim());
  }
  return req;
}
