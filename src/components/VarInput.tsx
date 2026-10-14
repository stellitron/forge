import { useLayoutEffect, useMemo, useRef, type InputHTMLAttributes } from "react";
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

/**
 * A text input that colours {{variables}}: known ones in the accent colour, unknown ones with a
 * red underline. A mirror layer behind a transparent-text input does the colouring, so typing,
 * selection, undo and autocomplete stay native.
 */
export default function VarInput({ value, className = "", style, ...rest }: InputHTMLAttributes<HTMLInputElement> & { value: string }) {
  const info = useVarInfo();
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const hasVars = value.includes("{{");
  const sync = () => {
    if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft;
  };
  useLayoutEffect(sync);
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
          {"​"}
        </div>
      )}
      <input ref={input} value={value} spellCheck={false} autoComplete="off" onScroll={sync} onKeyUp={sync} onSelect={sync} {...rest} />
    </div>
  );
}
