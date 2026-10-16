import { ShieldCheck } from "lucide-react";
import { useStore } from "../lib/store";
import { Modal } from "./ui";

/** Asked once per workspace Forge didn't create, like an editor's "trust this folder?" question. */
export default function TrustPrompt() {
  const root = useStore((s) => s.root);
  const asked = useStore((s) => s.trustAsked);
  const count = useStore((s) => Object.keys(s.items).length);
  const decide = useStore((s) => s.decideWorkspaceTrust);
  if (!root || asked) return null;
  return (
    <Modal title="Trust this workspace?" onClose={() => decide(false)} width={520}>
      <div className="col" style={{ gap: 12 }}>
        <div className="mono dim" style={{ wordBreak: "break-all" }}>{root}</div>
        <div>
          Do you trust the people who wrote the {count} request{count === 1 ? "" : "s"} in this folder? If it came from a repo you don't control, choose <b>Not now</b>.
        </div>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <b>Trust:</b> the hosts these requests use count as yours. Scripts and AI can send to them without asking.
          </li>
          <li>
            <b>Not now:</b> Forge asks before scripts or AI send anything to hosts only these requests use. Trust a folder or request any time, or edit it.
          </li>
        </ul>
        <div className="muted">Either way, requests that change outside Forge later, for example in a git pull, aren't trusted until you look at them.</div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => decide(false)}>
            Not now
          </button>
          <button className="btn primary" onClick={() => decide(true)}>
            <ShieldCheck size={14} /> Trust
          </button>
        </div>
      </div>
    </Modal>
  );
}
