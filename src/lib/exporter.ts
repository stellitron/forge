import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { tryJson } from "./eval";
import { fs } from "./ipc";
import { buildReport, FORMATS, render, type Format } from "./report";
import type { Query } from "./shape";
import { useStore } from "./store";
import type { HttpResponse } from "./types";

export interface ExportOptions {
  dataset?: string;
  query?: Query;
  summary?: string;
  title?: string;
  /** Ask where to save instead of writing to the workspace's reports/ folder. */
  saveAs?: boolean;
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";

/** Builds a report from a response and writes it. Returns the saved file's absolute path. */
export async function exportResponse(name: string, req: { method: string; url: string }, res: HttpResponse, format: Format, opts: ExportOptions = {}): Promise<string | null> {
  const data = tryJson(res.body);
  if (data === undefined) throw new Error("The response isn't JSON, so there's no data to build a report from.");
  const report = buildReport({ title: opts.title || name, source: { method: req.method, url: req.url, status: res.status, timeMs: res.timeMs }, data, dataset: opts.dataset, query: opts.query, summary: opts.summary });
  const bytes = await render(report, format, opts.dataset);
  const ext = FORMATS.find((f) => f.id === format)!.ext;
  const file = `${slug(opts.title || name)}-${stamp()}.${ext}`;
  if (opts.saveAs) {
    const to = await save({ defaultPath: file, filters: [{ name: FORMATS.find((f) => f.id === format)!.label, extensions: [ext] }] });
    if (!to) return null;
    await fs.saveFile(to, bytes);
    return to;
  }
  return fs.writeBytes(`reports/${file}`, bytes);
}

export async function exportAndNotify(...args: Parameters<typeof exportResponse>) {
  const st = useStore.getState();
  try {
    const path = await exportResponse(...args);
    if (!path) return;
    st.notify(`Saved ${path.split("/").slice(-2).join("/")}`);
    revealItemInDir(path).catch(() => {});
    return path;
  } catch (e) {
    st.notify(String(e instanceof Error ? e.message : e), "error");
  }
}
