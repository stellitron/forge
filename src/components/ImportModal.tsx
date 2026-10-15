import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, FileUp, FolderOpen, Info, Loader2, Upload } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { fs } from "../lib/ipc";
import { importAny, type ImportResult, type Source } from "../lib/importAny";
import { hasFiles, readDropped, takePendingDrop } from "../lib/dropFiles";
import { COLLECTIONS, useStore } from "../lib/store";
import { Modal } from "./ui";
import DocsModal from "./DocsModal";
import { summarizeImport, type ImportSummary } from "../lib/importSummary";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const safe = (s: string) => s.replace(/[/\\:*?"<>|]/g, "-").trim() || "Imported";

export default function ImportModal({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<Source[]>(() => takePendingDrop() ?? []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** After importing: the folders created, shown with the summary and next steps. */
  const [done, setDone] = useState<{ bases: { name: string; path: string }[]; summary: ImportSummary } | null>(null);
  const [docsFor, setDocsFor] = useState<string | null>(null);
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

  // Files and folders dropped anywhere on the window while this is open.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => !e.relatedTarget && setDragging(false);
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(false);
      setBusy(true);
      try {
        const files = await readDropped(e.dataTransfer!);
        if (!files.length) st.notify("No importable files there. Forge reads JSON, YAML, Bruno, HAR and cURL files.", "error");
        else setSources(files);
      } catch (err) {
        st.notify(String(err instanceof Error ? err.message : err), "error");
      } finally {
        setBusy(false);
      }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const bases: { name: string; path: string }[] = [];
      const taken = new Set(st.dirs);
      for (const c of r.collections) {
        let base = `${COLLECTIONS}/${safe(c.name)}`;
        for (let i = 2; taken.has(base); i++) base = `${COLLECTIONS}/${safe(c.name)} ${i}`;
        taken.add(base);
        bases.push({ name: base.slice(COLLECTIONS.length + 1), path: base });
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
      setDone({ bases, summary: summarizeImport(r, all, useStore.getState().envs.flatMap((e) => [...e.vars, ...e.secrets].map((v) => v.key))) });
    } catch (e) {
      st.notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy(false);
    }
  };

  const r = preview.result;
  const envs = useStore((x) => x.envs);
  const knownVars = useMemo(() => envs.flatMap((e) => [...e.vars, ...e.secrets].map((v) => v.key)), [envs]);
  const summary = useMemo(() => (r ? summarizeImport(r, all, knownVars) : null), [r, all, knownVars]);

  if (docsFor) return <DocsModal root={docsFor} onClose={onClose} />;
  if (done)
    return (
      <Modal title="Import complete" onClose={onClose} width={680}>
        <div className="col" style={{ gap: 12 }}>
          <SummaryView s={done.summary} />
          <div className="import-next">
            <div className="grow">
              <b>Next: document {done.bases.length === 1 ? "it" : "them"}</b>
              <div className="muted">
                {done.summary.withDescriptions < done.summary.requests
                  ? `${done.summary.requests - done.summary.withDescriptions} of ${done.summary.requests} requests have no description. Generate docs from the requests, and draft missing descriptions with AI if you've set it up.`
                  : "Every request has a description. Generate a docs page or Markdown file from them."}
              </div>
            </div>
            {done.bases.map((b) => (
              <button key={b.path} className="btn primary sm" onClick={() => setDocsFor(b.path)}>
                <BookOpen size={13} /> Write docs{done.bases.length > 1 ? ` for ${b.name}` : ""}
              </button>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
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
                <span className="tag">{c.format}</span> <b>{c.name}</b> <span className="muted">{c.items.length} requests{new Set(c.items.map((x) => x.folder).filter(Boolean)).size ? ` in ${new Set(c.items.map((x) => x.folder).filter(Boolean)).size} folder${new Set(c.items.map((x) => x.folder).filter(Boolean)).size === 1 ? "" : "s"}` : ""}</span>
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
            {summary && <SummaryView s={summary} compact />}
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

/** What an import contains and anything to check, before and after importing. */
function SummaryView({ s, compact }: { s: ImportSummary; compact?: boolean }) {
  const list = (pairs: [string, number][]) => pairs.map(([k, n]) => `${k} ${n}`).join(" · ");
  const warns = s.issues.filter((i) => i.level === "warn");
  return (
    <div className="col" style={{ gap: 10 }}>
      {!compact && (
        <div className="import-stats">
          <div><b>{s.requests}</b><span>requests</span></div>
          <div><b>{s.folders}</b><span>folders</span></div>
          <div><b>{s.envs.length}</b><span>environments</span></div>
          <div><b>{s.withTests}</b><span>with tests</span></div>
          <div><b>{s.withDescriptions}</b><span>described</span></div>
        </div>
      )}
      <dl className="import-facts">
        <dt>Methods</dt>
        <dd>{list(s.methods) || "none"}</dd>
        <dt>Auth</dt>
        <dd>{list(s.auth) || "none"}</dd>
        {!!s.bodies.length && (
          <>
            <dt>Bodies</dt>
            <dd>{list(s.bodies)}</dd>
          </>
        )}
        {!!s.envs.length && (
          <>
            <dt>Environments</dt>
            <dd>{s.envs.map((e) => `${e.name} (${e.shared} shared${e.secrets ? `, ${e.secrets} secret kept local` : ""})`).join(" · ")}</dd>
          </>
        )}
      </dl>
      {s.issues.length ? (
        <div className="import-issues">
          <div className="import-issues-h">
            {warns.length ? <AlertTriangle size={14} /> : <Info size={14} />}
            {warns.length ? `${warns.length} thing${warns.length === 1 ? "" : "s"} to check` : "Notes"}
          </div>
          <ul>
            {s.issues.map((i, k) => (
              <li key={k} className={`issue-${i.level}`}>
                {i.text}
                {i.examples?.length ? <span className="muted"> ({i.examples.join(", ")})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="import-ok">
          <CheckCircle2 size={14} /> No problems found.
        </div>
      )}
    </div>
  );
}
