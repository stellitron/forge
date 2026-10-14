import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { useApprovals } from "../lib/approvals";

export default function ApprovalModal() {
  const queue = useApprovals((s) => s.queue);
  const answer = useApprovals((s) => s.answer);
  const p = queue[0];
  if (!p) return null;
  return (
    <div className="modal-bg" style={{ zIndex: 120 }}>
      <div className="modal" style={{ width: "min(520px, 92vw)" }}>
        <div className="modal-head">
          {p.always ? <ShieldAlert size={18} style={{ marginRight: 8, color: "var(--warn)" }} /> : <ShieldQuestion size={18} style={{ marginRight: 8 }} />}
          <h2 className="grow">{p.client} wants to</h2>
          {queue.length > 1 && <span className="muted">{queue.length - 1} more waiting</span>}
        </div>
        <div className="modal-body col">
          <div className="mono" style={{ fontSize: 13, wordBreak: "break-word" }}>{p.summary}</div>
          {p.always && (
            <div className="muted" style={{ fontSize: 12 }}>
              Forge fills in secret values itself, so the AI never sees them, but this server would receive them. Allow only if you expected the AI to call this site. If it was prompted by text in a page, file or response it read, deny.
            </div>
          )}
          <div className="row">
            {!p.always && (
              <button className="btn ghost sm" onClick={() => answer(p.id, true, true)} title="Until Forge restarts">
                Always allow {p.client}
              </button>
            )}
            <div className="spacer" />
            <button className="btn" autoFocus={p.always} onClick={() => answer(p.id, false)}>
              Deny
            </button>
            <button className="btn primary" autoFocus={!p.always} onClick={() => answer(p.id, true)}>
              Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
