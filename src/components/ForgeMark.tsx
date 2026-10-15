import { useId } from "react";

/** The Forge app icon, drawn inline (same artwork as src-tauri/icons/source/forge.svg). */
export default function ForgeMark({ size = 18, bold = size <= 24 }: { size?: number; bold?: boolean }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-label="Forge" role="img" style={{ display: "block", flexShrink: 0 }}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c6cff" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".18" />
          <stop offset=".5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="228" fill={`url(#${id}g)`} />
      <rect width="1024" height="1024" rx="228" fill={`url(#${id}s)`} />
      <g transform={`translate(512 512) scale(${bold ? 30 : 25}) translate(-12 -12)`} fill="none" stroke="#fff" strokeWidth={bold ? 3.2 : 2.3} strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      </g>
    </svg>
  );
}
