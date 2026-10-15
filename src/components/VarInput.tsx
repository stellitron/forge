import { useEffect, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../lib/store";

export const BUILTIN_VARS = ["$uuid", "$timestamp", "$isoTimestamp", "$randomInt", "$randomEmail"];

export interface VarInfo {
  source: string;
  secret: boolean;
}

/** Where each {{name}} would come from right now (active environment, captured values, built-ins). */
export function useVarInfo(): Map<string, VarInfo> {
  const envs = useStore((s) => s.envs);
  const activeEnv = useStore((s) => s.activeEnv);
  const sessionVars = useStore((s) => s.sessionVars);
  return useMemo(() => {
    const m = new Map<string, VarInfo>();
    for (const b of BUILTIN_VARS) m.set(b, { source: "built-in, generated per request", secret: false });
    for (const k of Object.keys(sessionVars)) m.set(k, { source: "captured this session", secret: true });
    const env = envs.find((e) => e.path === activeEnv);
    for (const v of env?.vars ?? []) if (v.enabled && v.key) m.set(v.key, { source: `${env!.name} environment`, secret: false });
    for (const v of env?.secrets ?? []) if (v.enabled && v.key) m.set(v.key, { source: `${env!.name} secrets`, secret: true });
    return m;
  }, [envs, activeEnv, sessionVars]);
}

const VAR = /(\{\{\s*[^{}]+?\s*\}\})/g;
const nameOf = (token: string) => token.slice(2, -2).trim();

/** Tooltip text describing the variables in a value. Secret values are never shown. */
export function describeVars(value: string, info: Map<string, VarInfo>): string | undefined {
  const names = [...new Set((value.match(VAR) ?? []).map(nameOf))];
  if (!names.length) return undefined;
  return names.map((n) => (info.has(n) ? `{{${n}}} from ${info.get(n)!.source}${info.get(n)!.secret ? " (hidden)" : ""}` : `{{${n}}} is not defined in the active environment`)).join("\n");
}

export interface Suggestion {
  value: string;
  /** Shown in muted text next to the value, e.g. what a header is for. */
  hint?: string;
}

const MAX = 8;

/** Matches that start with what was typed come first, then ones that contain it. */
export function rankSuggestions(all: (string | Suggestion)[], typed: string): Suggestion[] {
  const items = all.map((x) => (typeof x === "string" ? { value: x } : x));
  const q = typed.trim().toLowerCase();
  if (!q) return items.slice(0, MAX);
  const starts = items.filter((x) => x.value.toLowerCase().startsWith(q));
  const contains = items.filter((x) => !x.value.toLowerCase().startsWith(q) && (x.value.toLowerCase().includes(q) || x.hint?.toLowerCase().includes(q)));
  const out = [...starts, ...contains];
  // Nothing to suggest when the only match is exactly what's typed.
  return out.length === 1 && out[0].value.toLowerCase() === q ? [] : out.slice(0, MAX);
}

type Props = InputHTMLAttributes<HTMLInputElement> & {
  value: string;
  suggestions?: (string | Suggestion)[];
  /** Called with the chosen suggestion. */
  onPick?: (value: string) => void;
};

/**
 * A text input that colours {{variables}}: known ones in the accent colour, unknown ones with a
 * red underline. A mirror layer behind a transparent-text input does the colouring, so typing,
 * selection and undo stay native. Optional suggestions open in Forge's own list, drawn above
 * everything so scroll areas and table cells can't clip it.
 */
export default function VarInput({ value, className = "", style, suggestions, onPick, onKeyDown, onFocus, onBlur, ...rest }: Props) {
  const info = useVarInfo();
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const hasVars = value.includes("{{");
  const sync = () => {
    if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft;
  };
  useLayoutEffect(sync);

  const list = useMemo(() => (suggestions?.length ? rankSuggestions(suggestions, value) : []), [suggestions, value]);
  const showing = open && list.length > 0;

  useEffect(() => {
    if (!showing) return;
    const place = () => input.current && setRect(input.current.getBoundingClientRect());
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [showing]);
  useEffect(() => setActive(-1), [value]);

  const pick = (v: string) => {
    onPick?.(v);
    setOpen(false);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (showing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = list.length;
        setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a <= 0 ? n : a) - 1));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && active >= 0) {
        e.preventDefault();
        pick(list[active].value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const below = rect ? window.innerHeight - rect.bottom > 280 || rect.top < 280 : true;
  return (
    <div className={`varinput ${hasVars ? "has-vars" : ""} ${className}`} style={style} title={describeVars(value, info)}>
      {hasVars && (
        <div ref={mirror} className="vi-mirror" aria-hidden>
          {value.split(VAR).map((part, i) =>
            i % 2 ? (
              <span key={i} className={info.has(nameOf(part)) ? "vi-ok" : "vi-bad"}>
                {part}
              </span>
            ) : (
              part
            ),
          )}
          {"\u200b"}
        </div>
      )}
      <input
        ref={input}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onScroll={sync}
        onKeyUp={sync}
        onSelect={sync}
        role={suggestions ? "combobox" : undefined}
        aria-expanded={suggestions ? showing : undefined}
        aria-autocomplete={suggestions ? "list" : undefined}
        onFocus={(e) => (suggestions && setOpen(true), onFocus?.(e))}
        onBlur={(e) => (setOpen(false), onBlur?.(e))}
        onKeyDown={keys}
        {...rest}
        onInput={(e) => (suggestions && setOpen(true), rest.onInput?.(e))}
      />
      {showing &&
        rect &&
        createPortal(
          <div
            className="suggest-list"
            role="listbox"
            style={{ left: rect.left, width: Math.max(rect.width, 340), ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }) }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {list.map((s, k) => (
              <div key={s.value} role="option" aria-selected={k === active} className={`suggest-item ${k === active ? "on" : ""}`} onMouseEnter={() => setActive(k)} onClick={() => pick(s.value)}>
                <span className="mono">{s.value}</span>
                {s.hint && <span className="suggest-hint">{s.hint}</span>}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
