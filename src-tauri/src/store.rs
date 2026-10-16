//! Workspace storage: plain JSON files in a user-chosen folder (git-friendly), plus
//! private app settings (LLM keys) kept outside the workspace.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Workspace(Mutex<Option<PathBuf>>);

#[derive(Serialize)]
pub struct FileEntry {
    path: String,
    content: String,
}

#[derive(Serialize)]
pub struct Tree {
    root: String,
    dirs: Vec<String>,
    files: Vec<FileEntry>,
}

const SKIP: &[&str] = &["node_modules", "target", "dist"];

fn resolve(ws: &Workspace, rel: &str) -> Result<PathBuf, String> {
    let root = ws.0.lock().unwrap().clone().ok_or("No workspace open")?;
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Path escapes workspace: {}", rel.display()));
    }
    Ok(root.join(rel))
}

fn walk(root: &Path, dir: &Path, tree: &mut Tree) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        let path = e.path();
        let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            tree.dirs.push(rel);
            walk(root, &path, tree)?;
        } else if name.ends_with(".json") && e.metadata().map(|m| m.len() < 5_000_000).unwrap_or(false) {
            tree.files.push(FileEntry { path: rel, content: std::fs::read_to_string(&path)? });
        }
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_open(path: String, ws: tauri::State<'_, Workspace>) -> Result<Tree, String> {
    let root = PathBuf::from(&path);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut tree = Tree { root: root.to_string_lossy().into_owned(), dirs: vec![], files: vec![] };
    walk(&root, &root, &mut tree).map_err(|e| e.to_string())?;
    *ws.0.lock().unwrap() = Some(root);
    Ok(tree)
}

#[tauri::command]
pub fn workspace_write(path: String, content: String, ws: tauri::State<'_, Workspace>) -> Result<(), String> {
    let p = resolve(&ws, &path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Write-then-rename so a crash never leaves a half-written collection file.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Binary files (exported reports) inside the workspace; returns the absolute path.
#[tauri::command]
pub fn workspace_write_bytes(path: String, data: String, ws: tauri::State<'_, Workspace>) -> Result<String, String> {
    use base64::Engine;
    let p = resolve(&ws, &path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into_owned())
}

/// Writes to a path the user picked in the save dialog.
#[tauri::command]
pub fn file_save(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_mkdir(path: String, ws: tauri::State<'_, Workspace>) -> Result<(), String> {
    std::fs::create_dir_all(resolve(&ws, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_delete(path: String, ws: tauri::State<'_, Workspace>) -> Result<(), String> {
    let p = resolve(&ws, &path)?;
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn workspace_rename(from: String, to: String, ws: tauri::State<'_, Workspace>) -> Result<(), String> {
    let (a, b) = (resolve(&ws, &from)?, resolve(&ws, &to)?);
    if b.exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = b.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(a, b).map_err(|e| e.to_string())
}

/// Appends any missing lines to the workspace .gitignore (creating it if needed).
#[tauri::command]
pub fn workspace_ensure_gitignore(lines: Vec<String>, ws: tauri::State<'_, Workspace>) -> Result<(), String> {
    ensure_gitignore(&resolve(&ws, ".gitignore")?, &lines)
}

pub fn ensure_gitignore(p: &Path, lines: &[String]) -> Result<(), String> {
    let mut text = std::fs::read_to_string(&p).unwrap_or_default();
    let have: std::collections::HashSet<String> = text.lines().map(|l| l.trim().to_string()).collect();
    let missing: Vec<&String> = lines.iter().filter(|l| !have.contains(l.trim())).collect();
    if missing.is_empty() {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if text.is_empty() {
        text.push_str("# Forge: secrets and captured tokens stay local\n");
    }
    for l in missing {
        text.push_str(l);
        text.push('\n');
    }
    std::fs::write(p, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn gitignore_appends_missing_lines_once() {
        let dir = std::env::temp_dir().join(format!("forge-gi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(".gitignore");
        std::fs::write(&p, "node_modules\n*.json.tmp").unwrap();
        let lines = vec!["*.json.tmp".to_string(), "*.local.json".to_string()];
        super::ensure_gitignore(&p, &lines).unwrap();
        super::ensure_gitignore(&p, &lines).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "node_modules\n*.json.tmp\n*.local.json\n");
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn settings_read(app: AppHandle) -> Result<String, String> {
    let p = settings_path(&app)?;
    Ok(std::fs::read_to_string(p).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
pub fn settings_write(app: AppHandle, content: String) -> Result<(), String> {
    let p = settings_path(&app)?;
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// A file in Forge's private app-data folder (history, cookies): never in a workspace, readable
/// only by this user. Names are plain (letters, digits, `-`, `_`, `.`) so they can't escape it.
fn appdata_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.starts_with('.') || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err(format!("Invalid app data name {name}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
pub fn appdata_read(app: AppHandle, name: String) -> Result<String, String> {
    Ok(std::fs::read_to_string(appdata_path(&app, &name)?).unwrap_or_default())
}

#[tauri::command]
pub fn appdata_write(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let p = appdata_path(&app, &name)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

const IMPORT_EXTS: &[&str] = &["json", "yaml", "yml", "bru", "har", "txt", "sh", "curl"];

/// Reads user-picked files or folders (outside the workspace) for import. Folders are walked
/// for collection files; paths come back relative to the picked folder's parent so the
/// collection keeps its folder name.
#[tauri::command]
pub fn import_read(paths: Vec<String>) -> Result<Vec<FileEntry>, String> {
    read_sources(&paths.iter().map(PathBuf::from).collect::<Vec<_>>())
}

pub fn read_sources(paths: &[PathBuf]) -> Result<Vec<FileEntry>, String> {
    fn visit(base: &Path, p: &Path, out: &mut Vec<FileEntry>) -> Result<(), String> {
        if out.len() >= 5000 {
            return Err("Too many files (over 5000) in the selected folder".into());
        }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if p.is_dir() {
            if name.starts_with('.') || SKIP.contains(&name.as_str()) {
                return Ok(());
            }
            let mut entries: Vec<_> = std::fs::read_dir(p).map_err(|e| e.to_string())?.filter_map(Result::ok).map(|e| e.path()).collect();
            entries.sort();
            for e in entries {
                visit(base, &e, out)?;
            }
        } else {
            let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let small = p.metadata().map(|m| m.len() < 20_000_000).unwrap_or(false);
            if IMPORT_EXTS.contains(&ext.as_str()) && small {
                if let Ok(content) = std::fs::read_to_string(p) {
                    let rel = p.strip_prefix(base).unwrap_or(p).to_string_lossy().replace('\\', "/");
                    out.push(FileEntry { path: rel, content });
                }
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    for p in paths {
        let base = p.parent().unwrap_or(Path::new("/"));
        visit(base, p, &mut out)?;
    }
    Ok(out)
}

#[cfg(test)]
mod import_tests {
    #[test]
    fn reads_picked_folder_relative_to_its_parent() {
        let d = std::env::temp_dir().join(format!("forge-import-{}", std::process::id()));
        std::fs::create_dir_all(d.join("My API/users")).unwrap();
        std::fs::create_dir_all(d.join("My API/node_modules")).unwrap();
        std::fs::write(d.join("My API/bruno.json"), "{}").unwrap();
        std::fs::write(d.join("My API/users/list.bru"), "meta {}").unwrap();
        std::fs::write(d.join("My API/users/logo.png"), "x").unwrap();
        std::fs::write(d.join("My API/node_modules/x.json"), "{}").unwrap();
        let files = super::read_sources(&[d.join("My API")]).unwrap();
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["My API/bruno.json", "My API/users/list.bru"]);
        std::fs::remove_dir_all(d).ok();
    }
}
