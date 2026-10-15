import { describe, expect, it } from "vitest";
import { importAny } from "../importAny";

const one = (content: string) => importAny([{ path: "x.json", content }]).collections[0].items[0].data.auth;
const postman = (auth: unknown) =>
  JSON.stringify({ info: { name: "c", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [{ name: "r", request: { method: "GET", url: "https://a.io", auth } }] });

describe("importing auth", () => {
  it("keeps Postman OAuth 2.0 settings", () => {
    const a = one(postman({ type: "oauth2", oauth2: [
      { key: "grant_type", value: "authorization_code_with_pkce" },
      { key: "authUrl", value: "https://id.io/authorize" },
      { key: "accessTokenUrl", value: "https://id.io/token" },
      { key: "clientId", value: "{{cid}}" },
      { key: "scope", value: "openid api" },
      { key: "client_authentication", value: "header" },
    ] }));
    expect(a).toMatchObject({ type: "oauth2", grant: "authorization_code", authUrl: "https://id.io/authorize", tokenUrl: "https://id.io/token", clientId: "{{cid}}", scope: "openid api", pkce: true, clientAuth: "basic" });
    expect(one(postman({ type: "oauth2", oauth2: [{ key: "grant_type", value: "authorization_code" }, { key: "accessTokenUrl", value: "https://id.io/t" }] }))).toMatchObject({ pkce: false });
    expect(one(postman({ type: "oauth2", oauth2: [{ key: "grant_type", value: "client_credentials" }, { key: "accessTokenUrl", value: "https://id.io/t" }] }))).toMatchObject({ grant: "client_credentials" });
  });

  it("keeps Postman Digest, AWS, Hawk and JWT", () => {
    expect(one(postman({ type: "digest", digest: [{ key: "username", value: "u" }, { key: "password", value: "{{p}}" }] }))).toEqual({ type: "digest", username: "u", password: "{{p}}" });
    expect(one(postman({ type: "awsv4", awsv4: [{ key: "accessKey", value: "{{ak}}" }, { key: "secretKey", value: "{{sk}}" }, { key: "region", value: "eu-west-1" }, { key: "service", value: "s3" }] }))).toMatchObject({ type: "awsv4", region: "eu-west-1", service: "s3" });
    expect(one(postman({ type: "hawk", hawk: [{ key: "authId", value: "id1" }, { key: "authKey", value: "{{k}}" }, { key: "algorithm", value: "sha1" }] }))).toMatchObject({ type: "hawk", id: "id1", algorithm: "sha1" });
    expect(one(postman({ type: "jwt", jwt: [{ key: "algorithm", value: "HS512" }, { key: "secret", value: "{{s}}" }, { key: "payload", value: '{"a":1}' }] }))).toMatchObject({ type: "jwt", algorithm: "HS512", secret: "{{s}}", payload: '{"a":1}' });
  });

  it("turns OpenAPI OAuth 2.0 flows into OAuth settings", () => {
    const spec = { openapi: "3.0.0", info: { title: "t" }, servers: [{ url: "https://api.io" }], security: [{ o: ["read"] }],
      components: { securitySchemes: { o: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://id.io/token", scopes: { read: "", write: "" } } } } } },
      paths: { "/a": { get: { responses: { 200: {} } } } } };
    expect(one(JSON.stringify(spec))).toMatchObject({ type: "oauth2", grant: "client_credentials", tokenUrl: "https://id.io/token", scope: "read write", clientId: "{{clientId}}" });
  });
});
