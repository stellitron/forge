import { effectiveItem } from "../lib/inherit";
import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { writeText } from "../lib/clipboard";
import { LANGUAGES, generate, type LangId } from "../lib/codegen";
import { buildRequest } from "../lib/request";
import { useStore } from "../lib/store";
import type { HttpItem } from "../lib/types";
import { Editor, Modal, safeGet, safeSet, type Lang } from "./ui";

export default function CodeModal({ item, onClose }: { item: HttpItem & { path?: string }; onClose: () => void }) {
  const [lang, setLang] = useState<LangId>(() => (safeGet("codegen:lang") as LangId) ?? "curl");
  // Off by default so shared snippets don't leak tokens from the environment.
  const [resolve, setResolve] = useState(false);
  const code = useMemo(() => {
    try {
      // Snippets show what's actually sent, folder headers and inherited auth included.
      const st = useStore.getState();
      const sent = item.path ? effectiveItem({ ...item, path: item.path }) : item;
      return generate(lang, buildRequest(sent, resolve ? (item.path ? st.varsFor(item.path) : st.vars()) : {}));
    } catch (e) {
      return `// ${e}`;
    }
  }, [item, lang, resolve]);
  const meta = LANGUAGES.find((l) => l.id === lang) ?? LANGUAGES[0];

  return (
    <Modal title="Generate code" onClose={onClose} width={880}>
      <div className="col">
        <div className="row">
          <select
            className="select"
            value={lang}
            onChange={(e) => {
              setLang(e.target.value as LangId);
              safeSet("codegen:lang", e.target.value);
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <label className="check" title="Substitute {{variables}} with values from the active environment, including secrets">
            <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} /> Fill in environment values
          </label>
          <div className="spacer" />
          <button className="btn primary sm" onClick={() => writeText(code).then(() => useStore.getState().notify(`Copied ${meta.label}`))}>
            <Copy size={13} /> Copy
          </button>
        </div>
        {resolve && <div className="warn" style={{ fontSize: 12 }}>This snippet contains real values from your environment (possibly tokens). Be careful where you paste it.</div>}
        <div style={{ height: 440, display: "flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
          <Editor value={code} readOnly lang={meta.lang as Lang} wrap={false} />
        </div>
      </div>
    </Modal>
  );
}
