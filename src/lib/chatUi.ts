import { create } from "zustand";

/** Ask drawer visibility and a pre-filled question. Kept apart from ChatPanel so any panel can open Ask without importing the assistant (which would create an import cycle). */
export const useChatUi = create<{ open: boolean; draft: string }>(() => ({ open: false, draft: "" }));
export const toggleChat = (open?: boolean) => useChatUi.setState((s) => ({ open: open ?? !s.open }));
export const useChatOpen = () => useChatUi((s) => s.open);
/** Opens Ask with a question already typed in, ready to send. */
export const askAbout = (text: string) => useChatUi.setState({ open: true, draft: text });
