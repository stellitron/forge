import { create } from "zustand";
import type { GraphQLSchema } from "graphql";
import { interpolate } from "./eval";
import { effectiveItem } from "./inherit";
import { uid } from "./ipc";
import { sendItem } from "./sendItem";
import { useStore } from "./store";
import type { HttpItem, Item } from "./types";

/**
 * GraphQL schemas loaded by introspection, one per endpoint for the session, so every request to
 * the same API shares it. Loading is an explicit action: it sends the introspection query with
 * the request's own auth, headers and folder settings.
 */

export interface SchemaState {
  loading?: boolean;
  error?: string;
  schema?: GraphQLSchema;
  types?: number;
  at?: number;
}

export const useSchemas = create<{ s: Record<string, SchemaState> }>(() => ({ s: {} }));

/** The endpoint a request's schema is filed under: its URL with variables filled in, query stripped. */
export function schemaKey(item: Item & HttpItem): string {
  return interpolate(item.url, useStore.getState().varsFor(item.path)).split(/[?#]/)[0];
}

const put = (key: string, p: SchemaState) => useSchemas.setState((st) => ({ s: { ...st.s, [key]: p } }));

/** Builds a schema from an introspection response body; explains the usual failures. */
export async function schemaFromResponse(status: number, body: string): Promise<GraphQLSchema> {
  const { buildClientSchema } = await import("graphql");
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`The server answered ${status} without JSON. Is this a GraphQL endpoint?`);
  }
  if (!json?.data?.__schema) {
    const msg = json?.errors?.[0]?.message;
    throw new Error(msg ? `Introspection failed: ${msg}. The server may have it turned off.` : `The server answered ${status} without a schema. Introspection may be turned off.`);
  }
  return buildClientSchema(json.data);
}

export async function loadSchema(item: Item & HttpItem): Promise<SchemaState> {
  const key = schemaKey(item);
  put(key, { ...useSchemas.getState().s[key], loading: true, error: undefined });
  try {
    const { getIntrospectionQuery } = await import("graphql");
    // The same auth and headers the request sends, but the introspection query as the body and
    // none of the request's scripts or checks.
    const probe: HttpItem = { ...effectiveItem(item), method: "POST", bodyMode: "json", body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: true }) }), assertions: [], extractions: [], preScript: undefined, postScript: undefined };
    const { res } = await sendItem(probe, uid(), "GraphQL schema", { interactive: true, vars: () => useStore.getState().varsFor(item.path) });
    const schema = await schemaFromResponse(res.status, res.bodyBase64 ? "" : res.body);
    const types = Object.keys(schema.getTypeMap()).filter((n) => !n.startsWith("__")).length;
    const state = { schema, types, at: Date.now() };
    put(key, state);
    return state;
  } catch (e) {
    const state = { error: e instanceof Error ? e.message : String(e) };
    put(key, state);
    return state;
  }
}
