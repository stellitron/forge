import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Loader2 } from "lucide-react";
import { fs } from "../lib/ipc";
import { exportSummary, toOpenApi, toPostman, type ExportInput } from "../lib/exportCollection";
import { useStore } from "../lib/store";
import { Modal } from "./ui";

type Format = "postman" | "openapi-yaml" | "openapi-json";

const FORMATS: { id: Format; label: string; detail: string; ext: string }[] = [
  { id: "postman", label: "Postman collection (v2.1)", detail: "Requests, folders, auth, bodies and tests as Postman scripts. Opens in Postman, Insomnia, Bruno and Hoppscotch.", ext: "postman_collection.json" },
  { id: "openapi-yaml", label: "OpenAPI 3.0 (YAML)", detail: "An API description with paths, parameters, auth schemes and example responses from your last run.", ext: "openapi.yaml" },
  { id: "openapi-json", label: "OpenAPI 3.0 (JSON)", detail: "The same description as JSON.", ext: "openapi.json" },
];

const safe = (s: string) => s.replace(/[/\\:*?"<>|]/g, "-").trim() || "collection";

/** Exports a collection or folder. Secrets stay as {{variables}}; values are never written out. */
export default function ExportModal({ root, onClose }: { root: string; onClose: () => void }) {
  const [format, setFormat] = useState<Format>("postman");
  const [busy, setBusy] = useState(false);
  const st = useStore.getState();
  const name = root.split("/").pop()!;
  const env = st.envs.find((e) => e.path === st.activeEnv);
  const input: ExportInput = {
    name,
    root,
    items: Object.values(st.items),
    // Only shared values resolve a {{baseUrl}} server; secrets are never exported.
    vars: Object.fromEntries((env?.vars ?? []).filter((v) => v.enabled).map((v) => [v.key, v.value])),
    responses: Object.fromEntries(Object.entries(st.responses).map(([k, r]) => [k, r.res])),
    folders: st.folders,
  };
  const { http, skipped } = exportSummary(input);
  const f = FORMATS.find((x) => x.id === format)!;

  const run = async () => {
    setBusy(true);
    try {
      const text = format === "postman" ? toPostman(input) : toOpenApi(input, format === "openapi-json" ? "json" : "yaml");
      const to = await save({ defaultPath: `${safe(name)}.${f.ext}`, filters: [{ name: f.label, extensions: [f.ext.split(".").pop()!] }] });
      if (!to) return;
      await fs.saveFile(to, new TextEncoder().encode(text));
      st.notify(`Exported ${http} request${http === 1 ? "" : "s"} to ${to.split(/[/\\]/).pop()}`);
      onClose();
    } catch (e) {
      st.notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Export ${name}`} onClose={onClose} width={560}>
      <div className="col" style={{ gap: 8 }}>
        {FORMATS.map((x) => (
          <label key={x.id} className={`export-option ${format === x.id ? "on" : ""}`}>
            <input type="radio" name="format" checked={format === x.id} onChange={() => setFormat(x.id)} />
            <span>
              <b>{x.label}</b>
              <span className="muted">{x.detail}</span>
            </span>
          </label>
        ))}
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
          {http} HTTP request{http === 1 ? "" : "s"}
          {skipped ? `. ${skipped} MCP, A2A, WebSocket, web check or agent item${skipped === 1 ? " has" : "s have"} no equivalent in this format and will be left out` : ""}. Secrets stay as {"{{variables}}"}; their values are not exported.
        </p>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !http} onClick={run}>
            {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Export
          </button>
        </div>
      </div>
    </Modal>
  );
}
