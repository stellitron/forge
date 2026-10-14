import { useEffect, useMemo, useState } from "react";
import { FileUp, FolderOpen, Loader2, Upload } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fs } from "../lib/ipc";
import { importAny, type ImportResult, type Source } from "../lib/importAny";
import { COLLECTIONS, useStore } from "../lib/store";
import { Modal } from "./ui";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const safe = (s: string) => s.replace(/[/\\:*?"<>|]/g, "-").trim() || "Imported";

export default function ImportModal({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const st = useStore.getState();

  const all = useMemo<Source[]>(() => (text.trim() ? [...sources, { path: "pasted", content: text }] : sources), [sources, text]);
  const preview = useMemo<{ result?: ImportResult; error?: string }>(() => {
    if (!all.length) return {};
    try {
      return { result: importAny(all) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [all]);

  const load = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    try {
      setSources(await fs.importRead(paths));
    } catch (e) {
      st.notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  // Files and folders dropped anywhere on the window.
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over" || e.payload.type === "enter") setDragging(true);
        else if (e.payload.type === "leave") setDragging(false);
        else if (e.payload.type === "drop") {
          setDragging(false);
          load(e.payload.paths);
        }
      })
      .then((u) => (off = u));
    return () => off?.();
  }, []);

  const pickFiles = async () => {
    if (!inTauri) return;
    const r = await open({ multiple: true, filters: [{ name: "Collections", extensions: ["json", "yaml", "yml", "bru", "har", "txt", "sh"] }] });
    if (r) load(Array.isArray(r) ? r : [r]);
  };
  const pickFolder = async () => {
    const r = await open({ directory: true });
    if (typeof r === "string") load([r]);
  };

  const run = async () => {
    const r = preview.result;
    if (!r) return;
    setBusy(true);
    try {
      let n = 0;
      const taken = new Set(st.dirs);
      for (const c of r.collections) {
        let base = `${COLLECTIONS}/${safe(c.name)}`;
        for (let i = 2; taken.has(base); i++) base = `${COLLECTIONS}/${safe(c.name)} ${i}`;
        taken.add(base);
        await st.createFolder(base);
        const made = new Set<string>();
        for (const it of c.items) {
          const folder = it.folder ? `${base}/${it.folder.split("/").map(safe).join("/")}` : base;
          if (it.folder && !made.has(folder)) {
            // Create each level so nested folders exist.
            const parts = folder.slice(base.length + 1).split("/");
            for (let i = 1; i <= parts.length; i++) {
              const p = `${base}/${parts.slice(0, i).join("/")}`;
              if (!made.has(p)) await st.createFolder(p), made.add(p);
            }
          }
          await st.createItem(folder, "http", it.name, it.data);
          n++;
        }
      }
      // Credentials go to the gitignored <env>.local.json; plain values stay shareable.
      for (const e of r.envs) await st.createEnv(safe(e.name), e.vars, e.secrets).catch(() => {});
      if (r.baseUrl) st.setVars({ baseUrl: r.baseUrl });
      st.notify(`Imported ${n} requests${r.envs.length ? ` and ${r.envs.length} environments` : ""}`);
      onClose();
    } catch (e) {
      st.notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy(false);
    }
  };

  const r = preview.result;
  return (
    <Modal title="Import" onClose={onClose} width={760}>
      <div className="col">
        <div className={`dropzone${dragging ? " over" : ""}`}>
          <Upload size={20} />
          <div>
            <b>Drop files or a folder here</b>
            <div className="muted">Postman · Insomnia · Bruno · OpenAPI / Swagger (JSON or YAML) · HAR · cURL. The format is detected automatically.</div>
          </div>
          <div className="row">
            {inTauri ? (
              <button className="btn" onClick={pickFiles}>
                <FileUp size={13} /> Choose files…
              </button>
            ) : (
              <label className="btn">
                <FileUp size={13} /> Choose files…
                <input type="file" multiple hidden onChange={async (e) => setSources(await Promise.all(Array.from(e.target.files ?? []).map(async (f) => ({ path: f.name, content: await f.text() }))))} />
              </label>
            )}
            {inTauri && (
              <button className="btn" onClick={pickFolder} title="Pick a Bruno collection folder (or any folder of exports)">
                <FolderOpen size={13} /> Choose folder…
              </button>
            )}
          </div>
        </div>
        <textarea
          className="textarea mono"
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"…or paste anything: collection JSON/YAML, an OpenAPI spec, a HAR, or one or more curl commands"}
        />
        {busy && <div className="muted"><Loader2 size={13} className="spin" /> Reading…</div>}
        {preview.error && <div className="err">{preview.error}</div>}
        {r && (
          <div className="card col" style={{ gap: 6 }}>
            {r.collections.map((c, i) => (
              <div key={i} className="row">
                <span className="tag">{c.format}</span> <b>{c.name}</b> <span className="muted">{c.items.length} requests{new Set(c.items.map((x) => x.folder).filter(Boolean)).size ? ` in ${new Set(c.items.map((x) => x.folder).filter(Boolean)).size} folders` : ""}</span>
              </div>
            ))}
            {r.envs.map((e, i) => (
              <div key={`e${i}`} className="row">
                <span className="tag">Environment</span> <b>{e.name}</b> <span className="muted">
                  {e.vars.length} shared{e.secrets.length ? ` · ${e.secrets.length} secret (${e.secrets.map((x) => x.key).slice(0, 4).join(", ")}${e.secrets.length > 4 ? "…" : ""}) kept local, not in git` : ""}
                </span>
              </div>
            ))}
            {r.baseUrl && <div className="muted">Sets <span className="mono">{"{{baseUrl}}"}</span> = {r.baseUrl}</div>}
            {!!r.skipped.length && <div className="muted" style={{ fontSize: 12 }}>Skipped: {r.skipped.slice(0, 6).join(" · ")}{r.skipped.length > 6 ? ` +${r.skipped.length - 6} more` : ""}</div>}
          </div>
        )}
        <div className="row">
          {!!sources.length && <span className="muted">{sources.length} file{sources.length > 1 ? "s" : ""} loaded</span>}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!r || busy} onClick={run}>
            Import
          </button>
        </div>
      </div>
    </Modal>
  );
}
