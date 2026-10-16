import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { Plus, Trash2 } from "lucide-react";
import { cookieJar, saveCookiesSoon, useCookieVersion, type Cookie } from "../lib/cookies";
import { useStore } from "../lib/store";
import { Modal } from "./ui";

export const useCookiesModal = create<{ open: boolean }>(() => ({ open: false }));
export const openCookies = () => useCookiesModal.setState({ open: true });

const blank = (): Cookie => ({ name: "", value: "", domain: "", path: "/", expires: null, secure: false, httpOnly: false, hostOnly: true });
const when = (s: number | null) => (s === null ? "session" : new Date(s * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));

/** The cookies the active environment's jar holds: see, edit, add and delete them. */
export default function CookiesModal() {
  const open = useCookiesModal((s) => s.open);
  if (!open) return null;
  return <Cookies onClose={() => useCookiesModal.setState({ open: false })} />;
}

function Cookies({ onClose }: { onClose: () => void }) {
  const version = useCookieVersion((s) => s.v);
  const env = useStore((s) => s.envs.find((e) => e.path === s.activeEnv)?.name);
  const persist = useStore((s) => s.settings.cookies?.persist !== false);
  const [list, setList] = useState<Cookie[]>([]);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Cookie | null>(null);
  const notify = useStore.getState().notify;

  useEffect(() => {
    cookieJar.list().then(setList, (e) => notify(String(e), "error"));
  }, [version, notify]);

  const run = (p: Promise<unknown>) => p.then(saveCookiesSoon, (e) => notify(String(e), "error"));
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => list.filter((c) => !q || `${c.domain} ${c.name} ${c.value}`.toLowerCase().includes(q)), [list, q]);
  const domains = [...new Set(shown.map((c) => c.domain))];

  return (
    <Modal title={`Cookies${env ? ` · ${env}` : ""}`} onClose={onClose} width={820}>
      <div className="col" style={{ gap: 10 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Cookies servers set are sent back automatically, like in a browser. Each environment has its own jar{persist ? ", kept on this computer between sessions (never in the workspace)" : ", kept until Forge closes"}.
        </div>
        <div className="row">
          <input className="input grow" placeholder={`Filter ${list.length} cookies`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn sm" onClick={() => setDraft(blank())}>
            <Plus size={13} /> Add
          </button>
          <button className="btn ghost sm" disabled={!list.length} onClick={() => run(cookieJar.clear())}>
            Clear all
          </button>
        </div>
        {draft && (
          <div className="card col" style={{ gap: 8 }}>
            <div className="grid2">
              <label className="field">
                Domain
                <input className="input mono" autoFocus value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} placeholder="api.example.com" />
              </label>
              <label className="field">
                Path
                <input className="input mono" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
              </label>
              <label className="field">
                Name
                <input className="input mono" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="field">
                Value
                <input className="input mono" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={!draft.hostOnly} onChange={(e) => setDraft({ ...draft, hostOnly: !e.target.checked })} /> Include subdomains
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.secure} onChange={(e) => setDraft({ ...draft, secure: e.target.checked })} /> HTTPS only
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.httpOnly} onChange={(e) => setDraft({ ...draft, httpOnly: e.target.checked })} /> HttpOnly
              </label>
              <div className="spacer" />
              <button className="btn ghost sm" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className="btn primary sm" disabled={!draft.domain.trim() || !draft.name.trim()} onClick={() => run(cookieJar.set(draft).then(() => setDraft(null)))}>
                Save
              </button>
            </div>
          </div>
        )}
        <div style={{ maxHeight: "50vh", overflow: "auto" }}>
          {!shown.length && <div className="muted" style={{ padding: 12 }}>{list.length ? "Nothing matches." : "No cookies yet. They appear when a server sets one."}</div>}
          {domains.map((d) => (
            <div key={d} style={{ marginBottom: 8 }}>
              <div className="mono" style={{ fontWeight: 600, padding: "6px 4px" }}>{d}</div>
              {shown
                .filter((c) => c.domain === d)
                .map((c) => (
                  <div key={`${c.path}|${c.name}`} className="row" style={{ padding: "4px 4px", borderBottom: "1px solid var(--line)" }}>
                    <span className="mono" style={{ width: 160, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={c.name}>
                      {c.name}
                    </span>
                    <input
                      className="input mono grow"
                      defaultValue={c.value}
                      onBlur={(e) => e.target.value !== c.value && run(cookieJar.set({ ...c, value: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                    <span className="muted" style={{ fontSize: 11, width: 150, flexShrink: 0 }} title={`Path ${c.path}`}>
                      {c.path !== "/" ? `${c.path} · ` : ""}
                      {when(c.expires)}
                    </span>
                    <span className="muted" style={{ fontSize: 10.5, width: 90, flexShrink: 0 }}>
                      {[c.hostOnly ? "" : "subdomains", c.secure ? "https" : "", c.httpOnly ? "httponly" : ""].filter(Boolean).join(" · ")}
                    </span>
                    <button className="btn ghost icon sm" title="Delete" onClick={() => run(cookieJar.remove(c))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
