/**
 * The runtime for pre-request and post-response scripts. `sandboxMain` is shipped as source text
 * into an isolated context (a Web Worker in the app, a Node vm context in the CLI), so it must be
 * fully self-contained: no imports, no references to anything outside its own body.
 *
 * It offers Postman's `pm` API (also as `insomnia`, which mirrors it) and Bruno's `bru`, `req`,
 * `res`, `test` and `expect`, so scripts from those tools run unchanged in the common cases.
 */

export interface ScriptKV {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ScriptRequest {
  method: string;
  url: string;
  headers: ScriptKV[];
  body: string;
}

export interface ScriptInput {
  code: string;
  phase: "pre" | "post";
  name: string;
  vars: Record<string, string>;
  request: ScriptRequest;
  response?: { status: number; statusText: string; headers: ScriptKV[]; body: string; timeMs: number; size: number };
}

/** A request a script asks Forge to send (pm.sendRequest, bru.sendRequest). */
export interface ScriptSendRequest {
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body?: string;
}

export interface ScriptSendResponse {
  status: number;
  statusText: string;
  headers: ScriptKV[];
  body: string;
  timeMs: number;
  size: number;
}

/** What the host offers the sandbox. Each call goes through Forge's checks, outside the sandbox. */
export interface ScriptApi {
  send?: (req: ScriptSendRequest) => Promise<ScriptSendResponse>;
}

export interface ScriptOutput {
  /** Variables set (string) or unset (null) by the script. */
  vars: Record<string, string | null>;
  /** The request after the script ran (pre-request scripts may change it). */
  request: ScriptRequest;
  tests: { name: string; pass: boolean; error?: string }[];
  logs: { level: "info" | "warn" | "error"; text: string }[];
  error?: string;
}

export async function sandboxMain(input: ScriptInput, api: ScriptApi = {}): Promise<ScriptOutput> {
  const vars: Record<string, string> = { ...input.vars };
  const changes: Record<string, string | null> = {};
  const tests: ScriptOutput["tests"] = [];
  const logs: ScriptOutput["logs"] = [];
  const pendingTests: Promise<unknown>[] = [];
  const request: ScriptRequest = { method: input.request.method, url: input.request.url, headers: input.request.headers.map((h) => ({ ...h })), body: input.request.body };
  const response = input.response;

  // Errors can come from another realm (the host's), where instanceof Error is false.
  const isErr = (v: unknown): v is Error => !!v && typeof v === "object" && typeof (v as Error).message === "string" && typeof (v as Error).name === "string";
  const fmt = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (isErr(v)) return `${v.name}: ${v.message}`;
    try {
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch {
      return String(v);
    }
  };
  const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : fmt(v));

  const deepEqual = (a: any, b: any): boolean => {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  };
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

  // ───── expect: the subset of Chai that API tests use ─────
  const expect = (subject: unknown): any => {
    const state = { val: subject as any, neg: false, deep: false };
    const check = (cond: boolean, msg: string, negMsg: string) => {
      if (cond === state.neg) throw new Error(state.neg ? negMsg : msg);
    };
    const a: any = {};
    for (const w of ["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "same", "but", "does", "still", "also"]) Object.defineProperty(a, w, { get: () => a });
    Object.defineProperty(a, "not", { get: () => ((state.neg = !state.neg), a) });
    Object.defineProperty(a, "deep", { get: () => ((state.deep = true), a) });
    const flag = (name: string, test: (v: any) => boolean, what: string) =>
      Object.defineProperty(a, name, { get: () => (check(test(state.val), `expected ${show(state.val)} to be ${what}`, `expected ${show(state.val)} not to be ${what}`), a) });
    flag("ok", (v) => !!v, "truthy");
    flag("true", (v) => v === true, "true");
    flag("false", (v) => v === false, "false");
    flag("null", (v) => v === null, "null");
    flag("undefined", (v) => v === undefined, "undefined");
    flag("NaN", (v) => Number.isNaN(v), "NaN");
    flag("exist", (v) => v !== null && v !== undefined, "defined");
    flag("empty", (v) => (typeof v === "string" || Array.isArray(v) ? v.length === 0 : v && typeof v === "object" ? Object.keys(v).length === 0 : false), "empty");
    const equal = (x: unknown) => (check(state.deep ? deepEqual(state.val, x) : state.val === x, `expected ${show(state.val)} to equal ${show(x)}`, `expected ${show(state.val)} not to equal ${show(x)}`), a);
    const eql = (x: unknown) => (check(deepEqual(state.val, x), `expected ${show(state.val)} to deeply equal ${show(x)}`, `expected ${show(state.val)} not to deeply equal ${show(x)}`), a);
    const cmp = (name: string, test: (v: number, x: number) => boolean) => (x: number) => (check(test(state.val, x), `expected ${show(state.val)} to be ${name} ${x}`, `expected ${show(state.val)} not to be ${name} ${x}`), a);
    const type = (t: string) => (check(typeOf(state.val) === t.toLowerCase(), `expected ${show(state.val)} to be a ${t}`, `expected ${show(state.val)} not to be a ${t}`), a);
    const include = (x: any) => {
      const v = state.val;
      const has =
        typeof v === "string" ? v.includes(x) : Array.isArray(v) ? v.some((e) => (state.deep || typeof x === "object" ? deepEqual(e, x) : e === x)) : v && typeof v === "object" && x && typeof x === "object" ? Object.keys(x).every((k) => deepEqual(v[k], x[k])) : false;
      check(has, `expected ${show(v)} to include ${show(x)}`, `expected ${show(v)} not to include ${show(x)}`);
      return a;
    };
    const property = (name: string, ...value: unknown[]) => {
      const v = state.val;
      const has = v !== null && v !== undefined && name in Object(v);
      if (value.length) check(has && deepEqual(v[name], value[0]), `expected ${show(v)} to have property ${show(name)} of ${show(value[0])}`, `expected ${show(v)} not to have property ${show(name)} of ${show(value[0])}`);
      else check(has, `expected ${show(v)} to have property ${show(name)}`, `expected ${show(v)} not to have property ${show(name)}`);
      if (has && !state.neg) state.val = v[name];
      return a;
    };
    const lengthOf = (n: number) => {
      const len = state.val?.length ?? (state.val && typeof state.val === "object" ? Object.keys(state.val).length : undefined);
      check(len === n, `expected ${show(state.val)} to have length ${n} but got ${len}`, `expected ${show(state.val)} not to have length ${n}`);
      return a;
    };
    const keys = (...ks: any[]) => {
      const want: string[] = Array.isArray(ks[0]) ? ks[0] : ks;
      const v = state.val && typeof state.val === "object" ? Object.keys(state.val) : [];
      check(want.every((k) => v.includes(k)), `expected ${show(state.val)} to have keys ${show(want)}`, `expected ${show(state.val)} not to have keys ${show(want)}`);
      return a;
    };
    Object.assign(a, {
      equal,
      equals: equal,
      eq: equal,
      eql,
      eqls: eql,
      above: cmp("above", (v, x) => v > x),
      gt: cmp("above", (v, x) => v > x),
      greaterThan: cmp("above", (v, x) => v > x),
      below: cmp("below", (v, x) => v < x),
      lt: cmp("below", (v, x) => v < x),
      lessThan: cmp("below", (v, x) => v < x),
      least: cmp("at least", (v, x) => v >= x),
      gte: cmp("at least", (v, x) => v >= x),
      most: cmp("at most", (v, x) => v <= x),
      lte: cmp("at most", (v, x) => v <= x),
      within: (lo: number, hi: number) => (check(state.val >= lo && state.val <= hi, `expected ${show(state.val)} to be within ${lo}..${hi}`, `expected ${show(state.val)} not to be within ${lo}..${hi}`), a),
      a: type,
      an: type,
      include,
      includes: include,
      contain: include,
      contains: include,
      property,
      lengthOf,
      length: lengthOf,
      keys,
      key: keys,
      match: (re: RegExp) => (check(re.test(String(state.val)), `expected ${show(state.val)} to match ${re}`, `expected ${show(state.val)} not to match ${re}`), a),
      matches: (re: RegExp) => a.match(re),
      string: (x: string) => include(x),
      members: (list: unknown[]) => (check(Array.isArray(state.val) && list.every((x) => state.val.some((e: unknown) => deepEqual(e, x))), `expected ${show(state.val)} to have members ${show(list)}`, `expected ${show(state.val)} not to have members ${show(list)}`), a),
      oneOf: (list: unknown[]) => (check(list.some((x) => deepEqual(x, state.val)), `expected ${show(state.val)} to be one of ${show(list)}`, `expected ${show(state.val)} not to be one of ${show(list)}`), a),
    });
    return a;
  };

  // ───── variables: Forge has one scope (the active environment), shared by every pm.* store ─────
  const store = {
    get: (k: string) => vars[k],
    set: (k: string, v: unknown) => {
      const s = typeof v === "string" ? v : fmt(v);
      vars[k] = s;
      changes[k] = s;
    },
    unset: (k: string) => {
      delete vars[k];
      changes[k] = null;
    },
    has: (k: string) => k in vars,
    toObject: () => ({ ...vars }),
    replaceIn: (s: string) => String(s).replace(/\{\{([^}]+)\}\}/g, (m, k: string) => (k.trim() in vars ? vars[k.trim()] : m)),
    clear: () => {},
  };

  const headerList = (list: ScriptKV[], readOnly: boolean) => {
    const find = (k: string) => list.findIndex((h) => h.key.toLowerCase() === String(k).toLowerCase());
    const norm = (h: any, v?: unknown) => (typeof h === "string" ? (h.includes(":") && v === undefined ? { key: h.slice(0, h.indexOf(":")).trim(), value: h.slice(h.indexOf(":") + 1).trim() } : { key: h, value: String(v ?? "") }) : { key: String(h.key), value: String(h.value ?? "") });
    const guard = () => {
      if (readOnly) throw new Error("Response headers can't be changed");
    };
    return {
      get: (k: string) => list.filter((h) => h.enabled).find((h) => h.key.toLowerCase() === String(k).toLowerCase())?.value,
      has: (k: string) => find(k) >= 0,
      add: (h: any, v?: unknown) => (guard(), list.push({ ...norm(h, v), enabled: true })),
      upsert: (h: any, v?: unknown) => {
        guard();
        const n = norm(h, v);
        const i = find(n.key);
        if (i >= 0) list[i] = { ...list[i], value: n.value, enabled: true };
        else list.push({ ...n, enabled: true });
      },
      remove: (k: string) => {
        guard();
        for (let i = list.length - 1; i >= 0; i--) if (list[i].key.toLowerCase() === String(k).toLowerCase()) list.splice(i, 1);
      },
      toObject: () => Object.fromEntries(list.filter((h) => h.enabled).map((h) => [h.key, h.value])),
      all: () => list.filter((h) => h.enabled).map((h) => ({ key: h.key, value: h.value })),
      each: (fn: (h: { key: string; value: string }) => void) => list.filter((h) => h.enabled).forEach((h) => fn({ key: h.key, value: h.value })),
      count: () => list.filter((h) => h.enabled).length,
    };
  };

  const jsonOf = (body: string) => () => {
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("The response body isn't valid JSON");
    }
  };
  const json = jsonOf(response?.body ?? "");

  const test = (name: string, fn: () => unknown) => {
    const fail = (e: unknown) => tests.push({ name: String(name), pass: false, error: isErr(e) ? e.message : fmt(e) });
    try {
      const r: any = fn?.();
      if (r && typeof r.then === "function") pendingTests.push(r.then(() => tests.push({ name: String(name), pass: true }), fail));
      else tests.push({ name: String(name), pass: true });
    } catch (e) {
      fail(e);
    }
  };

  const urlObj = {
    toString: () => request.url,
    update: (u: string) => void (request.url = String(u)),
    getHost: () => /^[a-z]+:\/\/([^/:?#]+)/i.exec(request.url)?.[1] ?? "",
    getPath: () => request.url.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0] || "/",
  };
  const bodyObj = {
    get raw() {
      return request.body;
    },
    set raw(v: string) {
      request.body = String(v);
    },
    toString: () => request.body,
    update: (v: any) => void (request.body = typeof v === "string" ? v : typeof v?.raw === "string" ? v.raw : fmt(v)),
  };
  const pmRequest = {
    get method() {
      return request.method;
    },
    set method(m: string) {
      request.method = String(m).toUpperCase();
    },
    get url(): any {
      return urlObj;
    },
    set url(u: any) {
      request.url = String(u);
    },
    headers: headerList(request.headers, input.phase === "post"),
    get body(): any {
      return bodyObj;
    },
    set body(v: any) {
      bodyObj.update(v);
    },
    addHeader: (h: any) => pmRequest.headers.add(h),
    removeHeader: (k: string) => pmRequest.headers.remove(k),
  };

  const resHeaders = headerList(response?.headers.map((h) => ({ ...h })) ?? [], true);
  const status = response?.status ?? 0;
  const statusCheck = (cond: boolean, what: string) => {
    if (!cond) throw new Error(`expected response to be ${what} but got ${status}`);
  };
  const pmResponse = response && {
    code: status,
    status: response.statusText,
    responseTime: response.timeMs,
    responseSize: response.size,
    headers: resHeaders,
    text: () => response.body,
    json,
    to: {
      have: {
        status: (want: number | string) => {
          if (typeof want === "number" ? status !== want : response.statusText !== want) throw new Error(`expected response to have status ${want} but got ${status}`);
        },
        header: (k: string, v?: string) => {
          const got = resHeaders.get(k);
          if (got === undefined) throw new Error(`expected response to have header ${k}`);
          if (v !== undefined && got !== v) throw new Error(`expected header ${k} to be ${show(v)} but got ${show(got)}`);
        },
        body: (s?: string) => {
          if (s === undefined ? !response.body : response.body !== s) throw new Error(s === undefined ? "expected response to have a body" : "expected response body to match");
        },
        jsonBody: (path?: string, value?: unknown) => {
          let v: any = json();
          if (path) for (const k of path.split(".")) v = v?.[k];
          if (v === undefined) throw new Error(`expected JSON body to have ${path}`);
          if (value !== undefined && !deepEqual(v, value)) throw new Error(`expected ${path} to equal ${show(value)} but got ${show(v)}`);
        },
      },
      be: {
        get ok() {
          return statusCheck(status >= 200 && status < 300, "ok");
        },
        get success() {
          return statusCheck(status >= 200 && status < 300, "successful");
        },
        get error() {
          return statusCheck(status >= 400, "an error");
        },
        get clientError() {
          return statusCheck(status >= 400 && status < 500, "a client error");
        },
        get serverError() {
          return statusCheck(status >= 500, "a server error");
        },
        get json() {
          json();
          return undefined;
        },
      },
    },
  };

  const pm = {
    environment: store,
    variables: store,
    collectionVariables: store,
    globals: store,
    iterationData: store,
    info: { requestName: input.name, eventName: input.phase === "pre" ? "prerequest" : "test", iteration: 0 },
    request: pmRequest,
    response: pmResponse,
    test,
    expect,
    sendRequest: (spec: any, callback?: (err: unknown, res: unknown) => void) => {
      const p = send(toRequest(spec)).then((r) => pmResponseOf(r));
      if (typeof callback === "function") {
        // Tracked like an async test, so the script waits for the callback before finishing.
        pendingTests.push(
          p.then(
            (r) => callback(null, r),
            (e) => callback(e, null),
          ),
        );
        return undefined;
      }
      return p;
    },
  };

  const parsedBody = () => {
    try {
      return JSON.parse(response?.body ?? "");
    } catch {
      return response?.body;
    }
  };
  const bru = {
    sendRequest: async (spec: any, callback?: (err: unknown, res: unknown) => void) => {
      // Bruno's form is axios-like: { url, method, headers: {…}, data }, answered with { status, data, headers }.
      const headers = Object.entries<any>(spec?.headers ?? {}).map(([key, value]) => ({ key, value: String(value) }));
      const data = spec?.data;
      if (data !== undefined && typeof data !== "string" && !headers.some((h) => h.key.toLowerCase() === "content-type")) headers.push({ key: "Content-Type", value: "application/json" });
      try {
        const r = await send({ method: String(spec?.method ?? "GET").toUpperCase(), url: String(spec?.url ?? ""), headers, body: data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data) });
        let body: unknown = r.body;
        try {
          body = JSON.parse(r.body);
        } catch {
          /* not JSON */
        }
        const res = { status: r.status, statusText: r.statusText, data: body, headers: Object.fromEntries(r.headers.map((h) => [h.key.toLowerCase(), h.value])) };
        if (typeof callback === "function") callback(null, res);
        return res;
      } catch (e) {
        if (typeof callback === "function") return callback(e, null);
        throw e;
      }
    },
    getEnvVar: store.get,
    setEnvVar: store.set,
    getVar: store.get,
    setVar: store.set,
    deleteVar: store.unset,
    hasVar: store.has,
    getCollectionVar: store.get,
    getRequestVar: store.get,
    getProcessEnv: () => undefined,
    interpolate: store.replaceIn,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    setNextRequest: () => {},
  };
  const req = {
    getUrl: () => request.url,
    setUrl: (u: string) => void (request.url = String(u)),
    getMethod: () => request.method,
    setMethod: (m: string) => void (request.method = String(m).toUpperCase()),
    getHeader: (k: string) => pmRequest.headers.get(k),
    getHeaders: () => pmRequest.headers.toObject(),
    setHeader: (k: string, v: string) => pmRequest.headers.upsert({ key: k, value: v }),
    deleteHeader: (k: string) => pmRequest.headers.remove(k),
    getBody: () => {
      try {
        return JSON.parse(request.body);
      } catch {
        return request.body;
      }
    },
    setBody: (b: unknown) => void (request.body = typeof b === "string" ? b : JSON.stringify(b, null, 2)),
    getName: () => input.name,
  };
  const res = response && {
    status,
    statusText: response.statusText,
    headers: resHeaders.toObject(),
    body: parsedBody(),
    responseTime: response.timeMs,
    getStatus: () => status,
    getStatusText: () => response.statusText,
    getHeader: (k: string) => resHeaders.get(k),
    getHeaders: () => resHeaders.toObject(),
    getBody: parsedBody,
    getResponseTime: () => response.timeMs,
  };

  /** Postman's request forms: a URL string, or { url, method, header, body: { mode, raw | urlencoded | graphql } }. */
  function toRequest(spec: any): ScriptSendRequest {
    if (typeof spec === "string") return { method: "GET", url: spec, headers: [] };
    const url = typeof spec?.url === "string" ? spec.url : spec?.url?.raw ?? String(spec?.url ?? "");
    const h = spec?.header ?? spec?.headers ?? [];
    const headers: { key: string; value: string }[] = Array.isArray(h) ? h.filter((x: any) => x && !x.disabled).map((x: any) => (typeof x === "string" ? { key: x.slice(0, x.indexOf(":")).trim(), value: x.slice(x.indexOf(":") + 1).trim() } : { key: String(x.key), value: String(x.value ?? "") })) : Object.entries<any>(h).map(([key, value]) => ({ key, value: String(value) }));
    const setType = (t: string) => headers.some((x) => x.key.toLowerCase() === "content-type") || headers.push({ key: "Content-Type", value: t });
    const b = spec?.body;
    let body: string | undefined;
    if (b?.mode === "raw") body = String(b.raw ?? "");
    else if (b?.mode === "urlencoded" || b?.mode === "formdata") {
      const fields = (b[b.mode] ?? []).filter((x: any) => x && !x.disabled);
      body = fields.map((x: any) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value ?? "")}`).join("&");
      setType("application/x-www-form-urlencoded");
    } else if (b?.mode === "graphql") {
      body = JSON.stringify({ query: b.graphql?.query ?? "", variables: typeof b.graphql?.variables === "string" ? JSON.parse(b.graphql.variables || "{}") : (b.graphql?.variables ?? {}) });
      setType("application/json");
    }
    return { method: String(spec?.method ?? (body ? "POST" : "GET")).toUpperCase(), url, headers, body };
  }

  function send(req: ScriptSendRequest): Promise<ScriptSendResponse> {
    if (!api.send) return Promise.reject(new Error("Sending requests from scripts isn't available here."));
    if (!/^https?:\/\//i.test(req.url)) return Promise.reject(new Error(`sendRequest needs a full http(s) URL, got "${req.url}"`));
    return api.send(req);
  }

  function pmResponseOf(r: ScriptSendResponse) {
    const headers = headerList(r.headers.map((h) => ({ ...h })), true);
    return { code: r.status, status: r.statusText, responseTime: r.timeMs, responseSize: r.size, headers, text: () => r.body, json: jsonOf(r.body) };
  }

  const out = (level: "info" | "warn" | "error") => (...args: unknown[]) => void logs.push({ level, text: args.map(fmt).join(" ") });
  const console = { log: out("info"), info: out("info"), debug: out("info"), warn: out("warn"), error: out("error") };
  const require = (m: string) => {
    throw new Error(`require("${m}") isn't available in Forge scripts`);
  };

  let error: string | undefined;
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    // Network and module loading are shadowed: scripts read and set variables and run tests,
    // and an imported collection's script must not be able to send your secrets anywhere.
    const fn = new AsyncFunction("pm", "insomnia", "bru", "req", "res", "test", "expect", "console", "require", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", input.code);
    await fn(pm, pm, bru, req, res, test, expect, console, require, undefined, undefined, undefined, undefined, undefined);
    await Promise.all(pendingTests);
  } catch (e) {
    error = fmt(e);
  }
  return { vars: changes, request, tests, logs, error };
}
