import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type Palette = "sage" | "forge" | "clay" | "ocean" | "forest" | "rose";
export interface Appearance {
  mode: ThemeMode;
  palette: Palette;
}

export const PALETTES: { id: Palette; label: string; dark: string; light: string }[] = [
  // Sage matches forge.stellitron.com and stellitron.com, and is the default.
  { id: "sage", label: "Sage", dark: "#3f7a52", light: "#305d40" },
  { id: "forge", label: "Violet", dark: "#7c6cff", light: "#5b4cf0" },
  { id: "clay", label: "Clay", dark: "#d97757", light: "#c15f3c" },
  { id: "ocean", label: "Ocean", dark: "#3b82f6", light: "#2563eb" },
  { id: "forest", label: "Forest", dark: "#22c55e", light: "#15803d" },
  { id: "rose", label: "Rose", dark: "#f43f5e", light: "#e11d48" },
];

export const DEFAULT_APPEARANCE: Appearance = { mode: "system", palette: "sage" };
const CACHE = "forge:appearance";
const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");

let current: Appearance = DEFAULT_APPEARANCE;
let unlisten: (() => void) | null = null;

function paint() {
  const dark = current.mode === "dark" || (current.mode === "system" && (media()?.matches ?? true));
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.palette = current.palette;
}

/** Applies a theme now and keeps following the OS while in "system" mode. */
export function applyAppearance(a: Partial<Appearance> | undefined) {
  current = { ...DEFAULT_APPEARANCE, ...a };
  try {
    localStorage.setItem(CACHE, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
  unlisten?.();
  unlisten = null;
  if (current.mode === "system") {
    const mq = media();
    mq?.addEventListener("change", paint);
    unlisten = () => mq?.removeEventListener("change", paint);
  }
  paint();
}

/** Called before the first render so the window never flashes the wrong theme. */
export function restoreAppearance() {
  let cached: Partial<Appearance> | undefined;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE) ?? "null") ?? undefined;
  } catch {
    cached = undefined;
  }
  applyAppearance(cached);
}

/** True when the dark theme is showing (for components with their own themes, like the editor). */
export function useDarkTheme() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== "light");
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.dataset.theme !== "light"));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  return dark;
}
