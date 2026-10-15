import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toggleChat, useChatUi } from "../lib/chatUi";
import { ChevronRight, Loader2, Plus, Send, Square, X } from "lucide-react";
import { Assistant } from "../agent/assistant";
import { COLLECTIONS, useStore, aiStatus } from "../lib/store";
import { kindLabel, type Item } from "../lib/types";
import { openSettings } from "../lib/settingsNav";

interface ToolStep {
  id: string;
  name: string;
  input: any;
  output?: string;
  isError?: boolean;
}

interface Msg {
  role: "user" | "assistant" | "error";
  text: string;
  steps?: ToolStep[];
  /** Saved items the user referenced with @ or by dragging them in. */
  refs?: string[];
}

/** Chat state outlives the drawer being closed. */
// The assistant is created on first use so importing this module never touches it at load time.
const useChat = create<{ msgs: Msg[]; busy: boolean; assistant: Assistant | null }>(() => ({ msgs: [], busy: false, assistant: null }));
export { toggleChat, useChatOpen, askAbout } from "../lib/chatUi";

const SUGGESTIONS = [
  "Explain the open request and its last response",
  "What endpoints are in this workspace?",
  "Why did my last request fail?",
  "Write a Python script that calls the open request",
  "Run the requests in this collection and summarise",
];

export default function ChatPanel() {
  const { msgs, busy, assistant } = useChat();
  const settings = useStore((s) => s.settings);
  const draft = useChatUi((s) => s.draft);
  const [text, setText] = useState(draft);
  useEffect(() => {
    if (draft) {
      setText(draft);
      useChatUi.setState({ draft: "" });
    }
  }, [draft]);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const items = useStore((s) => s.items);
  const [refs, setRefs] = useState<string[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [pick, setPick] = useState(0);
  const [dropping, setDropping] = useState(false);

  const matches = (() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const all = Object.values(items).filter((i) => !refs.includes(i.path)).sort((a, b) => a.path.localeCompare(b.path));
    const rel = (i: Item) => i.path.slice(COLLECTIONS.length + 1).replace(/\.json$/, "");
    return [...all.filter((i) => i.name.toLowerCase().startsWith(q)), ...all.filter((i) => !i.name.toLowerCase().startsWith(q) && rel(i).toLowerCase().includes(q))].slice(0, 8);
  })();

  /** Finds an @word being typed right before the caret. */
  const onType = (value: string, caret: number) => {
    setText(value);
    const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setMention(m ? { query: m[2], start: caret - m[2].length - 1 } : null);
    setPick(0);
  };
  const addRef = (path: string) => setRefs((r) => (r.includes(path) || !useStore.getState().items[path] ? r : [...r, path]));
  const choose = (it: Item) => {
    if (!mention) return;
    const caret = mention.start + 1 + mention.query.length;
    setText(text.slice(0, mention.start) + text.slice(caret).replace(/^\s/, ""));
    addRef(it.path);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const ai = aiStatus(settings);
  const provider = { label: ai.label };
  const needsKey = !ai.ready;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  const send = async (q = text) => {
    q = q.trim();
    const sentRefs = refs;
    if (!q && sentRefs.length) q = sentRefs.length === 1 ? "Explain this request and its last response." : "Explain these requests and how they relate.";
    if (!q || busy) return;
    setText("");
    setRefs([]);
    setMention(null);
    const patchLast = (fn: (m: Msg) => Msg) => useChat.setState((s) => ({ msgs: [...s.msgs.slice(0, -1), fn(s.msgs[s.msgs.length - 1])] }));
    useChat.setState((s) => ({ busy: true, msgs: [...s.msgs, { role: "user", text: q, refs: sentRefs }, { role: "assistant", text: "", steps: [] }] }));
    try {
      let a = useChat.getState().assistant;
      if (!a) useChat.setState({ assistant: (a = new Assistant()) });
      const answer = await a.ask(
        q,
        (e) => {
        if (e.type === "text") patchLast((m) => ({ ...m, text: e.text }));
        else if (e.type === "call") patchLast((m) => ({ ...m, steps: [...(m.steps ?? []), { id: e.id, name: e.name, input: e.input }] }));
        else if (e.type === "result") patchLast((m) => ({ ...m, steps: m.steps?.map((s) => (s.id === e.id ? { ...s, output: e.output, isError: e.isError } : s)) }));
        },
        true,
        sentRefs,
      );
      patchLast((m) => ({ ...m, text: answer || m.text }));
    } catch (e) {
      useChat.setState((s) => ({ msgs: [...s.msgs, { role: "error", text: e instanceof Error ? e.message : String(e) }] }));
    } finally {
      useChat.setState({ busy: false });
    }
  };

  const reset = () => {
    assistant?.stop();
    useChat.setState({ msgs: [], busy: false, assistant: null });
  };

  return (
    <aside
      className={`chat ${dropping ? "dropping" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("forge/item") || needsKey) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={(e) => {
        const p = e.dataTransfer.getData("forge/item");
        setDropping(false);
        if (!p || needsKey) return;
        e.preventDefault();
        addRef(p);
        inputRef.current?.focus();
      }}
    >
      <div className="chat-head">
        <b>Ask</b>
        <span className="muted" style={{ fontSize: 11 }}>{settings.agent.provider ? settings.agent.model || provider.label : "Not set up"}</span>
        <div className="spacer" />
        <button className="btn ghost icon sm" title="New chat" onClick={reset}>
          <Plus size={14} />
        </button>
        <button className="btn ghost icon sm" title="Close (⌘L)" onClick={() => toggleChat(false)}>
          <X size={14} />
        </button>
      </div>
      <div className="chat-body">
        {!msgs.length && (
          <div className="col" style={{ gap: 8, padding: 4 }}>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Forge's assistant for this workspace. Ask what an endpoint does, what a response means or why something failed. It can see the request you have open and its last response, read your other saved requests, and run requests (anything that changes data asks you first).
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              {!settings.agent.provider
                ? "It uses an AI model you choose, with your own key or a local model. Environment variable values are never sent."
                : settings.agent.provider === "ollama"
                  ? "Requests and responses it reads go to your local Ollama model and stay on this machine. Environment variable values are never sent."
                  : `Requests and responses it reads are sent to ${provider.label}. Environment variable values are never sent.`}{" "}
              Tables and reports in the Data tab are built locally without AI.
            </div>
            {needsKey ? (
              <button className="btn primary sm" onClick={() => openSettings("ai")}>
                {ai.missing ?? "Set up AI in Settings"}
              </button>
            ) : (
              SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)}>
                  {s}
                </button>
              ))
            )}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.steps?.map((s) => <Step key={s.id} s={s} />)}
            {!!m.refs?.length && (
              <div className="chat-refs">
                {m.refs.map((p) => (
                  <RefChip key={p} path={p} />
                ))}
              </div>
            )}
            {m.role === "assistant" ? m.text ? <Markdown text={m.text} /> : busy && i === msgs.length - 1 ? <Loader2 size={14} className="spin" /> : null : m.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {dropping && <div className="chat-drop">Drop to ask about it</div>}
      <div className="chat-input">
        <div className="chat-compose">
          {!!refs.length && (
            <div className="chat-refs">
              {refs.map((p) => (
                <RefChip key={p} path={p} onRemove={() => setRefs(refs.filter((r) => r !== p))} />
              ))}
            </div>
          )}
          {mention && matches.length > 0 && (
            <div className="mention-list" role="listbox" onMouseDown={(e) => e.preventDefault()}>
              {matches.map((it, k) => (
                <div key={it.path} role="option" aria-selected={k === pick} className={`suggest-item ${k === pick ? "on" : ""}`} onMouseEnter={() => setPick(k)} onClick={() => choose(it)}>
                  <span>
                    <span className={`method m-${it.kind === "http" ? it.method.toLowerCase() : it.kind}`}>{it.kind === "http" ? it.method : kindLabel[it.kind]}</span> {it.name}
                  </span>
                  <span className="suggest-hint">{it.path.slice(COLLECTIONS.length + 1).split("/").slice(0, -1).join(" / ")}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="textarea"
            rows={3}
            value={text}
            disabled={needsKey}
            placeholder={refs.length ? "Ask about it, or press ↵ for an explanation" : "Ask about this API. Type @ to pick a request, or drag one here."}
            onChange={(e) => onType(e.target.value, e.target.selectionStart)}
            onBlur={() => setMention(null)}
            onKeyDown={(e) => {
              if (mention && matches.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPick((k) => (k + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  choose(matches[pick]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (e.key === "Backspace" && !text && refs.length) setRefs(refs.slice(0, -1));
              if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), send());
            }}
          />
        </div>
        {busy ? (
          <button className="btn icon" title="Stop" onClick={() => assistant?.stop()}>
            <Square size={13} />
          </button>
        ) : (
          <button className="btn primary icon" disabled={(!text.trim() && !refs.length) || needsKey} onClick={() => send()}>
            <Send size={14} />
          </button>
        )}
      </div>
    </aside>
  );
}

/** A referenced request; clicking opens it. */
function RefChip({ path, onRemove }: { path: string; onRemove?: () => void }) {
  const it = useStore((s) => s.items[path]);
  const label = it?.name ?? path.split("/").pop()!.replace(/\.json$/, "");
  return (
    <span className="ref-chip" title={path.slice(COLLECTIONS.length + 1)}>
      <button className="ref-name" onClick={() => it && useStore.getState().openTab(path)} disabled={!it}>
        @{label}
      </button>
      {onRemove && (
        <button className="ref-x" title="Remove" onClick={onRemove}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

const STEP_LABELS: Record<string, string> = {
  list_requests: "Looked at your requests",
  get_request: "Read request",
  run_request: "Ran",
  run_folder: "Ran folder",
  http_request: "Sent",
  last_response: "Read the last response of",
  list_environments: "Checked environment names",
  recent_traffic: "Read recent traffic",
  save_request: "Saved request",
  response_data: "Read the data structure of",
  query_data: "Queried data in",
  create_report: "Created a report from",
  create_folder: "Created folder",
  organize: "Reorganized requests",
};

function Step({ s }: { s: ToolStep }) {
  const [open, setOpen] = useState(false);
  const path = s.input?.path ?? s.input?.folder;
  const arg = path ? String(path).replace(/\.json$/, "").split("/").pop() : s.input?.url ? `${s.input.method ?? "GET"} ${s.input.url}` : s.input?.format ? s.input.format : "";
  const extra = s.name === "create_report" && s.input?.format ? ` (${String(s.input.format).toUpperCase()})` : "";
  return (
    <div className={`chat-step ${s.isError ? "err" : ""}`}>
      <div className="row" style={{ gap: 4, cursor: "pointer" }} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .1s" }} />
        {s.output === undefined ? <Loader2 size={11} className="spin" /> : null}
        <span title={s.name}>{STEP_LABELS[s.name] ?? s.name}</span>
        <span className="mono step-arg">
          {String(arg)}
          {extra}
        </span>
      </div>
      {open && (
        <div className="chat-pre">
          <div className="chat-pre-h">Input</div>
          <pre>{JSON.stringify(s.input, null, 1)}</pre>
          <div className="chat-pre-h">Result{s.isError ? " (error)" : ""}</div>
          <pre>{s.output ?? "…"}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * GitHub-flavoured Markdown (tables, lists, links, quotes). Raw HTML is never rendered and images
 * are shown as links instead of being loaded: an answer influenced by API data could otherwise
 * smuggle that data out in an image URL.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const src = String(children ?? "");
            const block = /language-/.test(className ?? "") || src.includes("\n");
            return block ? <CodeBlock code={src.replace(/\n$/, "")} /> : <code>{children}</code>;
          },
          a: ({ href, children }) => (
            <a
              href={href}
              title={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) openUrl(href).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => <span className="muted">[image: {alt || src}]</span>,
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <button
        className="btn ghost sm"
        onClick={() => navigator.clipboard.writeText(code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)), () => {})}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{code}</pre>
    </div>
  );
}
