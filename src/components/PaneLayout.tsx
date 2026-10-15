import { Columns2, Rows2 } from "lucide-react";
import { useStore } from "../lib/store";

export type PaneLayout = "side" | "stacked";

/** Request/response arrangement: side by side ("h" split) or top and bottom ("v"). */
export function usePaneDir(): "h" | "v" {
  return useStore((s) => (s.settings.layout?.panes === "stacked" ? "v" : "h"));
}

export function setPaneLayout(panes: PaneLayout) {
  const s = useStore.getState();
  s.saveSettings({ layout: { ...s.settings.layout, panes } });
}

/** One-click switch shown next to responses. */
export function PaneLayoutToggle() {
  const dir = usePaneDir();
  return (
    <button
      className="btn ghost icon sm"
      title={dir === "h" ? "Show response below the request" : "Show response beside the request"}
      onClick={() => setPaneLayout(dir === "h" ? "stacked" : "side")}
    >
      {dir === "h" ? <Rows2 size={13} /> : <Columns2 size={13} />}
    </button>
  );
}
