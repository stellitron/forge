import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { restoreAppearance } from "./lib/theme";

restoreAppearance();

/** Dev builds: show uncaught errors on screen, since the desktop webview's console isn't visible. */
function showErrors() {
  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;max-height:40vh;overflow:auto;z-index:9999;margin:0;padding:8px;font:11px monospace;color:#fff;background:#a00d;border-radius:6px;white-space:pre-wrap;display:none";
  document.body.appendChild(box);
  const add = (msg: string) => {
    box.style.display = "block";
    box.textContent += `${msg}\n`;
  };
  window.addEventListener("error", (e) => add(`${e.message}\n${e.error?.stack ?? ""}`));
  window.addEventListener("unhandledrejection", (e) => add(`Unhandled: ${e.reason?.stack ?? e.reason}`));
  const orig = console.error;
  console.error = (...a) => (add(a.map(String).join(" ").slice(0, 2000)), orig(...a));
}

async function boot() {
  if (import.meta.env.DEV) showErrors();
  // Outside the desktop shell (plain `npm run dev` in a browser), use the in-memory preview backend.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) (await import("./preview")).installPreview();
  (await import("./lib/consoleFeeds")).installConsoleFeeds();
  (await import("./lib/forgeServer")).installServerBridge();
  (await import("./lib/autoname")).installAutoName();
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
boot();
