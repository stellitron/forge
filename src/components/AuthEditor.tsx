import { useEffect, useState } from "react";
import { KeyRound, Loader2, RefreshCw, ShieldAlert, X } from "lucide-react";
import VarInput from "./VarInput";
import { useStore } from "../lib/store";
import { cancelSignIn, clearToken, getNewToken, refreshToken, tokenState, tokenVarOf } from "../lib/oauth";
import type { Auth, JwtAlgorithm, OAuth2Auth } from "../lib/types";

type Type = Auth["type"];

const TYPES: { group: string; items: { id: Type; label: string; hint: string }[] }[] = [
  {
    group: "Common",
    items: [
      { id: "none", label: "No auth", hint: "Nothing is added." },
      { id: "bearer", label: "Bearer token", hint: "Sends Authorization: Bearer with a token you already have." },
      { id: "basic", label: "Basic", hint: "Username and password, base64-encoded in the Authorization header." },
      { id: "apikey", label: "API key", hint: "A key sent as a header or a query parameter." },
      { id: "oauth2", label: "OAuth 2.0", hint: "Forge gets the token, stores it as a secret and refreshes it when it expires." },
    ],
  },
  {
    group: "Signed requests",
    items: [
      { id: "awsv4", label: "AWS Signature v4", hint: "Signs each request for AWS services with your access keys." },
      { id: "digest", label: "Digest", hint: "Answers the server's challenge with a hashed password (MD5 or SHA-256)." },
      { id: "hawk", label: "Hawk", hint: "Signs the method, URL and time with a shared key." },
      { id: "jwt", label: "JWT", hint: "Creates and signs a fresh JSON Web Token for every request." },
    ],
  },
];

export const AUTH_LABELS: Record<Type, string> = Object.fromEntries(TYPES.flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<Type, string>;
export const AUTH_SHORT: Record<Type, string> = { none: "", bearer: "Bearer", basic: "Basic", apikey: "API key", oauth2: "OAuth 2.0", awsv4: "AWS", digest: "Digest", hawk: "Hawk", jwt: "JWT" };

/** Starting values when switching type. Secrets are {{variables}} so nothing sensitive lands in git. */
function fresh(t: Type): Auth {
  switch (t) {
    case "bearer":
      return { type: t, token: "{{token}}" };
    case "basic":
      return { type: t, username: "", password: "{{password}}" };
    case "apikey":
      return { type: t, key: "X-API-Key", value: "{{apiKey}}", in: "header" };
    case "oauth2":
      return { type: t, grant: "authorization_code", authUrl: "", tokenUrl: "", clientId: "", clientSecret: "", scope: "", audience: "", username: "", password: "", pkce: true, redirectUri: "http://127.0.0.1:8765/callback", clientAuth: "body", tokenVar: "token" };
    case "digest":
      return { type: t, username: "", password: "{{password}}" };
    case "awsv4":
      return { type: t, accessKey: "{{awsAccessKeyId}}", secretKey: "{{awsSecretAccessKey}}", sessionToken: "", region: "us-east-1", service: "execute-api" };
    case "hawk":
      return { type: t, id: "", key: "{{hawkKey}}", algorithm: "sha256", ext: "" };
    case "jwt":
      return { type: t, algorithm: "HS256", secret: "{{jwtSecret}}", payload: '{\n  "sub": "user-123"\n}', expiresIn: 3600, prefix: "Bearer" };
    default:
      return { type: "none" };
  }
}

/** A typed-in credential (not a {{variable}}) would be saved into the request file and committed. */
const isLiteral = (v: string) => v.trim().length >= 6 && !v.includes("{{");

export function SecretField({ label, value, onChange, varName, type, placeholder, hint }: { label: string; value: string; onChange: (v: string) => void; varName: string; type?: string; placeholder?: string; hint?: string }) {
  const [busy, setBusy] = useState(false);
  const move = async () => {
    setBusy(true);
    try {
      const name = await useStore.getState().storeSecret(varName, value);
      onChange(`{{${name}}}`);
      useStore.getState().notify(`Moved to {{${name}}} in your environment's secrets (not committed)`);
    } catch (e) {
      useStore.getState().notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="field">
      {label}
      <VarInput className="input-like" type={type && !value.includes("{{") ? type : undefined} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? `{{${varName}}}`} />
      {hint && <span className="muted field-hint">{hint}</span>}
      {isLiteral(value) && (
        <span className="secret-warn">
          <ShieldAlert size={13} /> This value would be saved in the request file and shared through git.
          <button className="btn sm" disabled={busy} onClick={(e) => (e.preventDefault(), move())}>
            Move to {`{{${varName}}}`}
          </button>
        </span>
      )}
    </label>
  );
}

function Text({ label, value, onChange, placeholder, hint, mono = true }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; mono?: boolean }) {
  return (
    <label className="field grow">
      {label}
      {mono ? <VarInput className="input-like" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} /> : <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />}
      {hint && <span className="muted field-hint">{hint}</span>}
    </label>
  );
}

export default function AuthEditor({ auth, onChange }: { auth: Auth; onChange: (a: Auth) => void }) {
  const hint = TYPES.flatMap((g) => g.items).find((i) => i.id === auth.type)?.hint;
  // Patch helper typed per variant.
  const set = <T extends Auth>(a: T, p: Partial<T>) => onChange({ ...a, ...p });
  return (
    <div className="pad col auth" style={{ maxWidth: 620 }}>
      <label className="field">
        Type
        <select className="select" value={auth.type} onChange={(e) => e.target.value !== auth.type && onChange(fresh(e.target.value as Type))}>
          {TYPES.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {hint && <span className="muted field-hint">{hint}</span>}
      </label>

      {auth.type === "bearer" && <SecretField label="Token" value={auth.token} varName="token" onChange={(token) => set(auth, { token })} />}

      {(auth.type === "basic" || auth.type === "digest") && (
        <>
          <Text label="Username" value={auth.username} onChange={(username) => set(auth, { username })} placeholder="username or {{username}}" />
          <SecretField label="Password" type="password" value={auth.password} varName="password" onChange={(password) => set(auth, { password })} />
        </>
      )}

      {auth.type === "apikey" && (
        <>
          <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <Text label="Key" value={auth.key} onChange={(key) => set(auth, { key })} />
            <label className="field">
              Add to
              <select className="select" value={auth.in} onChange={(e) => set(auth, { in: e.target.value as "header" | "query" })}>
                <option value="header">Header</option>
                <option value="query">Query params</option>
              </select>
            </label>
          </div>
          <SecretField label="Value" value={auth.value} varName="apiKey" onChange={(value) => set(auth, { value })} />
        </>
      )}

      {auth.type === "oauth2" && <OAuthFields auth={auth} onChange={onChange} />}

      {auth.type === "awsv4" && (
        <>
          <div className="row" style={{ gap: 10 }}>
            <SecretField label="Access key ID" value={auth.accessKey} varName="awsAccessKeyId" onChange={(accessKey) => set(auth, { accessKey })} />
            <SecretField label="Secret access key" type="password" value={auth.secretKey} varName="awsSecretAccessKey" onChange={(secretKey) => set(auth, { secretKey })} />
          </div>
          <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <Text label="Region" value={auth.region} onChange={(region) => set(auth, { region })} placeholder="us-east-1" />
            <Text label="Service" value={auth.service} onChange={(service) => set(auth, { service })} placeholder="execute-api, s3, lambda…" />
          </div>
          <SecretField label="Session token (optional)" value={auth.sessionToken} varName="awsSessionToken" onChange={(sessionToken) => set(auth, { sessionToken })} placeholder="only for temporary credentials" />
          <p className="muted field-hint" style={{ margin: 0 }}>
            Signed just before sending. Multipart and file bodies are sent with an unsigned payload, which S3 accepts; other services may need a raw or form body.
          </p>
        </>
      )}

      {auth.type === "hawk" && (
        <>
          <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <Text label="Hawk ID" value={auth.id} onChange={(id) => set(auth, { id })} />
            <label className="field">
              Algorithm
              <select className="select" value={auth.algorithm} onChange={(e) => set(auth, { algorithm: e.target.value as "sha256" | "sha1" })}>
                <option value="sha256">SHA-256</option>
                <option value="sha1">SHA-1</option>
              </select>
            </label>
          </div>
          <SecretField label="Hawk key" type="password" value={auth.key} varName="hawkKey" onChange={(key) => set(auth, { key })} />
          <Text label="Ext (optional)" value={auth.ext} onChange={(ext) => set(auth, { ext })} placeholder="app-specific data" />
        </>
      )}

      {auth.type === "jwt" && (
        <>
          <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <label className="field">
              Algorithm
              <select className="select" value={auth.algorithm} onChange={(e) => set(auth, { algorithm: e.target.value as JwtAlgorithm })}>
                {(["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256", "ES384"] as const).map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <Text label="Header prefix" value={auth.prefix} onChange={(prefix) => set(auth, { prefix })} placeholder="Bearer" />
            <label className="field">
              Expires in (seconds)
              <input className="input mono" type="number" min={0} value={auth.expiresIn} onChange={(e) => set(auth, { expiresIn: Math.max(0, Number(e.target.value)) })} />
            </label>
          </div>
          <SecretField
            label={auth.algorithm.startsWith("HS") ? "Secret" : "Private key (PKCS#8 PEM)"}
            type="password"
            value={auth.secret}
            varName={auth.algorithm.startsWith("HS") ? "jwtSecret" : "jwtPrivateKey"}
            onChange={(secret) => set(auth, { secret })}
            hint={auth.algorithm.startsWith("HS") ? undefined : "Store the PEM in a secret variable. Begins with -----BEGIN PRIVATE KEY-----."}
          />
          <label className="field">
            Claims (JSON)
            <textarea className="textarea mono" rows={5} value={auth.payload} onChange={(e) => set(auth, { payload: e.target.value })} spellCheck={false} />
            <span className="muted field-hint">{"{{variables}} are filled in. iat and exp are added unless you set them."}</span>
          </label>
        </>
      )}

      <Sends auth={auth} />
    </div>
  );
}

function Sends({ auth }: { auth: Auth }) {
  const sends: Partial<Record<Type, string>> = {
    bearer: auth.type === "bearer" ? `Authorization: Bearer ${auth.token || "…"}` : "",
    basic: auth.type === "basic" ? `Authorization: Basic base64(${auth.username || "user"}:••••)` : "",
    apikey: auth.type === "apikey" ? (auth.in === "header" ? `${auth.key || "X-API-Key"}: ${auth.value || "…"}` : `?${auth.key || "api_key"}=${auth.value || "…"}`) : "",
    oauth2: auth.type === "oauth2" ? `Authorization: Bearer {{${tokenVarOf(auth)}}}` : "",
    digest: "Authorization: Digest username=…, response=… (after the server's 401 challenge)",
    awsv4: "Authorization: AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…  ·  X-Amz-Date",
    hawk: 'Authorization: Hawk id="…", ts="…", nonce="…", mac="…"',
    jwt: auth.type === "jwt" ? `Authorization: ${auth.prefix ? `${auth.prefix} ` : ""}eyJ… (signed ${auth.algorithm})` : "",
  };
  const line = sends[auth.type];
  if (!line) return null;
  return (
    <>
      <div className="auth-sends">
        <span className="muted">Sends</span> <span className="mono">{line}</span>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        <span className="mono">{"{{name}}"}</span> values come from the active environment. Secrets live in <span className="mono">*.local.json</span>, which Forge keeps out of git.
      </p>
    </>
  );
}

function OAuthFields({ auth, onChange }: { auth: OAuth2Auth; onChange: (a: Auth) => void }) {
  const set = (p: Partial<OAuth2Auth>) => onChange({ ...auth, ...p });
  // Re-render when stored values change; vars() itself builds a new object each call.
  useStore((s) => s.envs);
  useStore((s) => s.sessionVars);
  useStore((s) => s.activeEnv);
  const state = tokenState(auth, useStore.getState().vars());
  const [busy, setBusy] = useState<"" | "get" | "refresh">("");
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const run = async (kind: "get" | "refresh") => {
    setBusy(kind);
    try {
      await (kind === "get" ? getNewToken(auth) : refreshToken(auth));
      useStore.getState().notify(`Token saved to {{${tokenVarOf(auth)}}} in your environment's secrets`);
    } catch (e) {
      useStore.getState().notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy("");
    }
  };
  const mins = state.expiresAt ? Math.round((state.expiresAt - Date.now()) / 60000) : null;
  const code = auth.grant === "authorization_code";

  return (
    <>
      <label className="field">
        Grant type
        <select className="select" value={auth.grant} onChange={(e) => set({ grant: e.target.value as OAuth2Auth["grant"] })}>
          <option value="authorization_code">Authorization code (sign in with a browser)</option>
          <option value="client_credentials">Client credentials (app to app)</option>
          <option value="password">Password (legacy)</option>
        </select>
      </label>
      {code && <Text label="Authorization URL" value={auth.authUrl} onChange={(authUrl) => set({ authUrl })} placeholder="https://login.example.com/oauth/authorize" />}
      <Text label="Token URL" value={auth.tokenUrl} onChange={(tokenUrl) => set({ tokenUrl })} placeholder="https://login.example.com/oauth/token" />
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <Text label="Client ID" value={auth.clientId} onChange={(clientId) => set({ clientId })} />
        <SecretField label={code && auth.pkce ? "Client secret (often not needed)" : "Client secret"} type="password" value={auth.clientSecret} varName="clientSecret" onChange={(clientSecret) => set({ clientSecret })} placeholder="{{clientSecret}}" />
      </div>
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <Text label="Scope" value={auth.scope} onChange={(scope) => set({ scope })} placeholder="openid profile api.read" />
        <Text label="Audience (optional)" value={auth.audience} onChange={(audience) => set({ audience })} placeholder="https://api.example.com" />
      </div>
      {auth.grant === "password" && (
        <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
          <Text label="Username" value={auth.username} onChange={(username) => set({ username })} />
          <SecretField label="Password" type="password" value={auth.password} varName="password" onChange={(password) => set({ password })} />
        </div>
      )}
      {code && (
        <>
          <Text
            label="Redirect URL"
            value={auth.redirectUri}
            onChange={(redirectUri) => set({ redirectUri })}
            hint="Register this exact URL with your provider. Forge listens on it only while you sign in."
          />
          <label className="check">
            <input type="checkbox" checked={auth.pkce} onChange={(e) => set({ pkce: e.target.checked })} /> Use PKCE (recommended; required by most providers for desktop apps)
          </label>
        </>
      )}
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <label className="field">
          Send client credentials
          <select className="select" value={auth.clientAuth} onChange={(e) => set({ clientAuth: e.target.value as "body" | "basic" })}>
            <option value="body">In the request body</option>
            <option value="basic">As a Basic auth header</option>
          </select>
        </label>
        <Text label="Store token as" value={auth.tokenVar} onChange={(tokenVar) => set({ tokenVar: tokenVar.replace(/[^\w.-]/g, "") })} placeholder="token" hint="Requests using the same name share the token." />
      </div>

      <div className="oauth-token">
        <KeyRound size={15} />
        <div className="grow">
          {state.token ? (
            <>
              <b>Token stored</b>{" "}
              <span className="muted">
                in {`{{${tokenVarOf(auth)}}}`}
                {mins === null ? "" : state.expired ? " · expired" : ` · expires in ${mins < 60 ? `${Math.max(mins, 0)} min` : `${Math.round(mins / 60)} h`}`}
                {state.refresh ? " · can refresh" : ""}
              </span>
            </>
          ) : (
            <span className="muted">No token yet. {code ? "Sign in to get one." : "Forge gets one automatically when you send."}</span>
          )}
        </div>
        {busy === "get" && code ? (
          <button className="btn sm" onClick={() => (cancelSignIn(), setBusy(""))}>
            <X size={13} /> Cancel sign-in
          </button>
        ) : (
          <button className="btn primary sm" disabled={!!busy} onClick={() => run("get")}>
            {busy === "get" ? <Loader2 size={13} className="spin" /> : null} {code ? "Sign in" : "Get new token"}
          </button>
        )}
        {state.refresh && (
          <button className="btn sm" disabled={!!busy} onClick={() => run("refresh")} title="Use the refresh token">
            {busy === "refresh" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          </button>
        )}
        {state.token && (
          <button className="btn ghost sm" disabled={!!busy} onClick={() => clearToken(auth)} title="Forget the stored token">
            Clear
          </button>
        )}
      </div>
    </>
  );
}
