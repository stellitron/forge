import type { ImportResult } from "./importAny";
import { COLLECTIONS, useStore } from "./store";

export const safeName = (s: string) => s.replace(/[/\\:*?"<>|]/g, "-").trim() || "Imported";

/**
 * Writes imported collections under collections/, each in a fresh top-level folder. With
 * `untrusted`, the requests don't vouch for their hosts until you edit or trust them.
 */
export async function saveCollections(r: ImportResult, opts: { untrusted?: boolean } = {}): Promise<{ n: number; bases: { name: string; path: string }[] }> {
  const st = useStore.getState();
  let n = 0;
  const bases: { name: string; path: string }[] = [];
  const taken = new Set(st.dirs);
  for (const c of r.collections) {
    let base = `${COLLECTIONS}/${safeName(c.name)}`;
    for (let i = 2; taken.has(base); i++) base = `${COLLECTIONS}/${safeName(c.name)} ${i}`;
    taken.add(base);
    bases.push({ name: base.slice(COLLECTIONS.length + 1), path: base });
    await st.createFolder(base);
    const made = new Set<string>();
    for (const it of c.items) {
      const folder = it.folder ? `${base}/${it.folder.split("/").map(safeName).join("/")}` : base;
      if (it.folder && !made.has(folder)) {
        // Create each level so nested folders exist.
        const parts = folder.slice(base.length + 1).split("/");
        for (let i = 1; i <= parts.length; i++) {
          const p = `${base}/${parts.slice(0, i).join("/")}`;
          if (!made.has(p)) await st.createFolder(p), made.add(p);
        }
      }
      await st.createItem(folder, "http", it.name, it.data, { trusted: !opts.untrusted });
      n++;
    }
    // Collection and folder settings (auth, headers, variables, scripts) go in each folder's _folder.json.
    for (const [rel, settings] of Object.entries(c.folders ?? {})) {
      const path = rel ? `${base}/${rel.split("/").map(safeName).join("/")}` : base;
      if (path !== base && !made.has(path)) {
        const parts = path.slice(base.length + 1).split("/");
        for (let i = 1; i <= parts.length; i++) {
          const p = `${base}/${parts.slice(0, i).join("/")}`;
          if (!made.has(p)) await st.createFolder(p), made.add(p);
        }
      }
      await st.saveFolder(path, settings, { trusted: !opts.untrusted });
    }
  }
  return { n, bases };
}
