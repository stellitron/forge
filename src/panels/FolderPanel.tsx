import { useState } from "react";
import { FolderCog } from "lucide-react";
import AuthEditor from "../components/AuthEditor";
import { KvTable, Seg } from "../components/ui";
import { resolveAuth } from "../lib/inherit";
import { COLLECTIONS, basename, useStore } from "../lib/store";
import { emptyFolder, type FolderSettings } from "../lib/types";
import { COMMON_HEADERS, headerValues } from "../lib/httpKnowledge";
import { ScriptsEditor } from "./HttpPanel";

export const folderTab = (path: string) => `::folder:${path}`;

type Tab = "auth" | "headers" | "vars" | "scripts";

/**
 * Settings a folder (or collection: a top-level folder) passes to everything inside it. Saved in
 * the folder's _folder.json, so they're shared through git like the requests.
 */
export default function FolderPanel({ path }: { path: string }) {
  const settings = useStore((s) => s.folders[path]) ?? emptyFolder();
  const folders = useStore((s) => s.folders);
  const count = useStore((s) => Object.keys(s.items).filter((p) => p.startsWith(`${path}/`)).length);
  const [tab, setTab] = useState<Tab>("auth");
  const isCollection = path.split("/").length === 2;
  const set = (p: Partial<FolderSettings>) => useStore.getState().saveFolder(path, { ...settings, ...p });
  const parent = resolveAuth(path, { type: "inherit" }, folders);
  return (
    <div className="panel">
      <div className="pad row" style={{ paddingBottom: 6 }}>
        <FolderCog size={18} className="dim" />
        <h2 className="grow">
          {isCollection ? "Collection" : "Folder"} settings · {basename(path) === COLLECTIONS ? "All" : basename(path)}
        </h2>
        <span className="muted" style={{ fontSize: 12 }}>
          Applies to the {count} item{count === 1 ? "" : "s"} inside{isCollection ? "" : ", after the settings of the folders above"}.
        </span>
      </div>
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { id: "auth", label: settings.auth.type === "inherit" ? "Auth" : <>Auth <span className="tab-note">✓</span></> },
          { id: "headers", label: "Headers", count: settings.headers.filter((h) => h.enabled).length },
          { id: "vars", label: "Variables", count: settings.vars.filter((v) => v.enabled).length },
          { id: "scripts", label: "Scripts", count: [settings.preScript, settings.postScript].filter((x) => x?.trim()).length },
        ]}
      />
      <div className="scroll grow" style={{ display: "flex", flexDirection: "column" }}>
        {tab === "auth" && (
          <>
            <div className="muted" style={{ padding: "10px 14px 0" }}>
              Requests set to <b>Inherit from folder</b> use this. {isCollection ? "Set it here to sign in once for the whole collection." : "Leave it on Inherit to use the collection's."}
            </div>
            <AuthEditor auth={settings.auth} onChange={(auth) => set({ auth })} inherited={parent} onOpenFolder={(p) => useStore.getState().openTab(folderTab(p))} />
          </>
        )}
        {tab === "headers" && (
          <>
            <div className="muted" style={{ padding: "10px 14px 0" }}>Sent with every request inside. A request's own header of the same name replaces it.</div>
            <KvTable rows={settings.headers} onChange={(headers) => set({ headers })} keyPh="Header" keyOptions={COMMON_HEADERS} valueOptions={headerValues} />
          </>
        )}
        {tab === "vars" && (
          <>
            <div className="muted" style={{ padding: "10px 14px 0" }}>
              Like Postman's collection variables: shared with the collection and committed with it. The active environment's variables override these, so keep secrets there.
            </div>
            <KvTable rows={settings.vars} onChange={(vars) => set({ vars })} keyPh="Variable" />
          </>
        )}
        {tab === "scripts" && <ScriptsEditor item={settings} set={set} path={path} />}
      </div>
    </div>
  );
}
