import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { BookOpen, Loader2, Sparkles } from "lucide-react";
import { fs } from "../lib/ipc";
import { buildDocModel, docsHtml, docsMarkdown, missingDescriptions, type DocOptions, type ExampleMode } from "../lib/apiDocs";
import { draftDescriptions, type Draft } from "../lib/docsAi";
import type { ExportInput } from "../lib/exportCollection";
import type { LangId } from "../lib/codegen";
import { aiStatus, useStore } from "../lib/store";
import { openSettings } from "../lib/settingsNav";
import { reveal } from "../lib/reveal";
import { Modal } from "./ui";

const SAMPLE_LANGS: { id: LangId; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "fetch", label: "JavaScript" },
  { id: "python", label: "Python" },
  { id: "go", label: "Go" },
  { id: "java", label: "Java" },
  { id: "csharp", label: "C#" },
];

const safe = (s: string) => s.replace(/[/\\:*?"<>|]/g, "-").trim() || "api";

/**
 * Generates API docs for a collection. Everything factual comes from the requests and their last
 * responses; the optional AI step only drafts descriptions, which the user reviews and saves into
 * each request's Docs tab before they appear in the output.
 */
export default function DocsModal({ root, onClose }: { root: string; onClose: () => void }) {
  const items = useStore((s) => s.items);
  const settings = useStore((s) => s.settings);
  const name = root.split("/").pop()!;
  const [format, setFormat] = useState<"html" | "md">("html");
  const [title, setTitle] = useState(/\bapi$/i.test(name) ? name : `${name} API`);
  const [intro, setIntro] = useState("");
  const [examples, setExamples] = useState<ExampleMode>("sample");
  const [samples, setSamples] = useState<LangId[]>(["curl", "fetch", "python"]);
  const [busy, setBusy] = useState<"" | "draft" | "save">("");
  const [progress, setProgress] = useState(0);
  const [drafts, setDrafts] = useState<(Draft & { on: boolean })[] | null>(null);
  const st = useStore.getState();
  const ai = aiStatus(settings);

  const input = useMemo<ExportInput>(() => {
    const env = st.envs.find((e) => e.path === st.activeEnv);
    return {
      name,
      root,
      items: Object.values(items),
      // Shared values only, to show base URLs. Secrets are never used.
      vars: Object.fromEntries((env?.vars ?? []).filter((v) => v.enabled).map((v) => [v.key, v.value])),
      responses: Object.fromEntries(Object.entries(st.responses).map(([k, r]) => [k, r.res])),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, root]);
  const opts: DocOptions = { title, intro, examples, samples };
  const model = useMemo(() => buildDocModel(input, opts), [input, title, intro, examples, samples.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const endpoints = model.folders.flatMap((f) => f.endpoints);
  const missing = missingDescriptions(input);
  const withResponses = endpoints.filter((e) => e.response).length;

  const draft = async () => {
    setBusy("draft");
    setProgress(0);
    try {
      const ids = new Set(missing.map((m) => m.path));
      const need = endpoints.filter((e) => ids.has(e.source));
      const out = await draftDescriptions(settings, title, need, !intro.trim(), setProgress);
      if (out.intro && !intro.trim()) setIntro(out.intro);
      setDrafts(out.drafts.map((d) => ({ ...d, on: true })));
      if (!out.drafts.length) st.notify("The model didn't return any usable descriptions. Try again or write them in each request's Docs tab.", "error");
    } catch (e) {
      st.notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy("");
    }
  };

  const pathOf = (id: string) => endpoints.find((e) => e.id === id)?.source ?? "";

  const accept = () => {
    const chosen = (drafts ?? []).filter((d) => d.on && d.description.trim());
    for (const d of chosen) st.updateItem(pathOf(d.id), { description: d.description.trim() });
    st.notify(`Saved ${chosen.length} description${chosen.length === 1 ? "" : "s"} to the requests' Docs tabs`);
    setDrafts(null);
  };

  const generateFile = async () => {
    setBusy("save");
    try {
      const text = format === "html" ? docsHtml(model) : docsMarkdown(model);
      const ext = format === "html" ? "html" : "md";
      const to = await save({ defaultPath: `${safe(title)}.${ext}`, filters: [{ name: format === "html" ? "Web page" : "Markdown", extensions: [ext] }] });
      if (!to) return;
      await fs.saveFile(to, new TextEncoder().encode(text));
      st.notify(`Saved docs for ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`);
      // Saved inside the workspace: show it; elsewhere the save dialog already told the user where.
      if (st.root && to.startsWith(st.root)) reveal(to.slice(st.root.length + 1));
      onClose();
    } catch (e) {
      st.notify(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy("");
    }
  };

  if (drafts)
    return (
      <Modal title="Review AI drafts" onClose={() => setDrafts(null)} width={680}>
        <div className="col" style={{ gap: 10 }}>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            Drafted by {settings.agent.model} from names and types only. Check each one; the model can't see how your API really behaves. Accepted text is saved to the request's Docs tab, where you can edit it later.
          </p>
          <div className="drafts">
            {drafts.map((d, k) => {
              const ep = endpoints.find((e) => e.id === d.id);
              return (
                <div key={d.id} className={`draft ${d.on ? "" : "off"}`}>
                  <label className="row" style={{ gap: 8 }}>
                    <input type="checkbox" checked={d.on} onChange={() => setDrafts(drafts.map((x, j) => (j === k ? { ...x, on: !x.on } : x)))} />
                    <b>{ep?.name}</b>
                    <span className="mono muted" style={{ fontSize: 11.5 }}>
                      {ep?.method} {ep?.path.split("?")[0]}
                    </span>
                  </label>
                  <textarea className="textarea" rows={3} value={d.description} onChange={(e) => setDrafts(drafts.map((x, j) => (j === k ? { ...x, description: e.target.value } : x)))} />
                </div>
              );
            })}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn" onClick={() => setDrafts(null)}>
              Discard
            </button>
            <button className="btn primary" disabled={!drafts.some((d) => d.on)} onClick={accept}>
              Save {drafts.filter((d) => d.on).length} description{drafts.filter((d) => d.on).length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal title={`Generate docs for ${name}`} onClose={onClose} width={620}>
      <div className="col" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 8 }}>
          {(
            [
              ["html", "Web page", "One HTML file with navigation and search. Share it or host it anywhere."],
              ["md", "Markdown", "One .md file for a repository or wiki. Renders on GitHub."],
            ] as const
          ).map(([id, label, detail]) => (
            <label key={id} className={`export-option grow ${format === id ? "on" : ""}`}>
              <input type="radio" name="docfmt" checked={format === id} onChange={() => setFormat(id)} />
              <span>
                <b>{label}</b>
                <span className="muted">{detail}</span>
              </span>
            </label>
          ))}
        </div>

        <label className="field">
          Title
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          Introduction (optional, Markdown)
          <textarea className="textarea" rows={3} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="What this API is for and where to start." />
        </label>

        <div className="col" style={{ gap: 6 }}>
          <label className="field">
            Response examples from your last run ({withResponses} of {endpoints.length} have one)
            <select className="select" value={examples} onChange={(e) => setExamples(e.target.value as ExampleMode)}>
              <option value="sample">Sample values: personal data replaced with fake values</option>
              <option value="real">Real values: only secrets hidden</option>
              <option value="off">Leave out response examples</option>
            </select>
            <span className={`field-hint ${examples === "real" ? "warn-text" : "muted"}`}>
              {examples === "sample"
                ? "Names, emails, phone numbers, addresses, locations and ID numbers become values like user@example.com. Tokens, keys and passwords are hidden. Field names and types stay real."
                : examples === "real"
                  ? "Only tokens, keys and passwords are hidden. If you last ran these requests against production, the docs will contain real customer data. Use this only for internal docs or test data."
                  : "Responses are left out. Field tables for request bodies still appear."}
            </span>
          </label>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            <span className="muted" style={{ fontSize: 12.5, marginRight: 4 }}>
              Code samples
            </span>
            {SAMPLE_LANGS.map((l) => (
              <button key={l.id} className={`swatch ${samples.includes(l.id) ? "on" : ""}`} onClick={() => setSamples(samples.includes(l.id) ? samples.filter((x) => x !== l.id) : [...samples, l.id])}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <div className="docs-ai">
          <Sparkles size={15} />
          <div className="grow">
            {missing.length ? (
              <>
                <b>
                  {missing.length} of {endpoints.length} endpoints have no description.
                </b>
                <div className="muted">Write them in each request's Docs tab, or draft them with AI and review before saving. The model sees names and types, never your data.</div>
              </>
            ) : (
              <b>Every endpoint has a description.</b>
            )}
          </div>
          {missing.length > 0 &&
            (ai.ready ? (
              <button className="btn sm" disabled={!!busy} onClick={draft}>
                {busy === "draft" ? (
                  <>
                    <Loader2 size={13} className="spin" /> {progress}/{missing.length}
                  </>
                ) : (
                  "Draft with AI"
                )}
              </button>
            ) : (
              <button className="btn ghost sm" onClick={() => (onClose(), openSettings("ai"))}>
                Set up AI
              </button>
            ))}
        </div>

        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!busy || !endpoints.length} onClick={generateFile}>
            {busy === "save" ? <Loader2 size={14} className="spin" /> : <BookOpen size={14} />} Generate {format === "html" ? "web page" : "Markdown"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
