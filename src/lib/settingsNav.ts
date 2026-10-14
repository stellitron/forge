import { create } from "zustand";
import { SETTINGS_TAB, useStore } from "./store";

export type SettingsSection = "general" | "appearance" | "ai" | "connect" | "updates" | "about";

export const useSettingsNav = create<{ section: SettingsSection }>(() => ({ section: "general" }));

/** Opens Settings at a section, e.g. openSettings("ai") from a "set up a model" hint. */
export function openSettings(section: SettingsSection = "general") {
  useSettingsNav.setState({ section });
  useStore.getState().openTab(SETTINGS_TAB);
}
