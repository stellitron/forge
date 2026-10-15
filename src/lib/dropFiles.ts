import type { Source } from "./importAny";

/**
 * Reads files and folders dropped from Finder or Explorer through the page's own drag and drop.
 * Mirrors the desktop importer (src-tauri/src/store.rs read_sources): the same file types, size
 * limit and skipped folders, with paths relative to the dropped item's parent.
 */

const EXTS = new Set(["json", "yaml", "yml", "bru", "har", "txt", "sh", "curl"]);
const SKIP = new Set(["node_modules", "target", "dist"]);
const MAX_FILES = 5000;
const MAX_BYTES = 20_000_000;

export const hasFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes("Files");

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const fileOf = (e: FileSystemFileEntry) => new Promise<File>((ok, bad) => e.file(ok, bad));
const readAll = (r: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((ok, bad) => {
    const out: FileSystemEntry[] = [];
    // readEntries returns results in batches until it returns an empty one.
    const next = () => r.readEntries((batch) => (batch.length ? (out.push(...batch), next()) : ok(out)), bad);
    next();
  });

export async function readDropped(dt: DataTransfer): Promise<Source[]> {
  const out: Source[] = [];
  const visit = async (entry: FileSystemEntry) => {
    if (out.length >= MAX_FILES) throw new Error("Too many files (over 5000) in the dropped folder");
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) return;
      const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const c of children) await visit(c);
    } else if (EXTS.has(ext(entry.name))) {
      const f = await fileOf(entry as FileSystemFileEntry);
      if (f.size < MAX_BYTES) out.push({ path: entry.fullPath.replace(/^\/+/, ""), content: await f.text() });
    }
  };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (entries.length) for (const e of entries) await visit(e);
  else for (const f of [...dt.files]) if (EXTS.has(ext(f.name)) && f.size < MAX_BYTES) out.push({ path: f.name, content: await f.text() });
  return out;
}

/** Files dropped while the import window was closed; it picks them up when it opens. */
let pending: Source[] | null = null;
export const setPendingDrop = (s: Source[]) => (pending = s);
export function takePendingDrop(): Source[] | null {
  const s = pending;
  pending = null;
  return s;
}
