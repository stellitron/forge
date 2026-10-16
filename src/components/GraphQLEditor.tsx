import { useEffect, useMemo, useState } from "react";
import type { Extension } from "@codemirror/state";
import { Loader2, RefreshCw } from "lucide-react";
import { loadSchema, schemaKey, useSchemas } from "../lib/graphqlSchema";
import type { HttpItem, Item } from "../lib/types";
import { Editor } from "./ui";

type GraphqlModule = typeof import("cm6-graphql");

/**
 * The GraphQL query editor: real GraphQL highlighting always, and with a loaded schema,
 * completion (Ctrl-Space or as you type), errors underlined as you write, and field details.
 */
export default function GraphQLEditor({ item, value, onChange }: { item: Item & HttpItem; value: string; onChange: (v: string) => void }) {
  const [mod, setMod] = useState<GraphqlModule | null>(null);
  const key = schemaKey(item);
  const state = useSchemas((s) => s.s[key]);

  // Loaded on first use, so GraphQL support doesn't slow down starting Forge.
  useEffect(() => {
    let live = true;
    import("cm6-graphql").then((m) => live && setMod(m));
    return () => {
      live = false;
    };
  }, []);

  const extensions = useMemo<Extension[] | undefined>(() => (mod ? [mod.graphql(state?.schema)] : undefined), [mod, state?.schema]);

  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <div className="row" style={{ padding: "4px 12px", fontSize: 12, borderBottom: "1px solid var(--line)" }}>
        {state?.schema ? (
          <span className="muted grow">
            Schema loaded: {state.types} types. Press Ctrl-Space for suggestions.
          </span>
        ) : state?.error ? (
          <span className="err grow" title={state.error}>
            {state.error}
          </span>
        ) : (
          <span className="muted grow">Load the schema to get completion and checking as you type.</span>
        )}
        <button className="btn ghost sm" disabled={state?.loading || !item.url.trim()} onClick={() => loadSchema(item)} title={`Sends an introspection query to ${key || "the URL"} with this request's auth and headers`}>
          {state?.loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} {state?.schema ? "Reload schema" : "Load schema"}
        </button>
      </div>
      <Editor value={value} onChange={onChange} lang="graphql" extensions={extensions} placeholder="query { viewer { id name } }" />
    </div>
  );
}
