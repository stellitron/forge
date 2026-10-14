import type { RawRequest } from "./ipc";
import { toCurl } from "./request";

/** Turns a resolved request into a ready-to-run snippet in many languages. */

export const LANGUAGES = [
  { id: "curl", label: "cURL", lang: "text" },
  { id: "fetch", label: "JavaScript · fetch", lang: "js" },
  { id: "axios", label: "Node · axios", lang: "js" },
  { id: "python", label: "Python · requests", lang: "text" },
  { id: "go", label: "Go · net/http", lang: "text" },
  { id: "java", label: "Java · HttpClient", lang: "text" },
  { id: "csharp", label: "C# · HttpClient", lang: "text" },
  { id: "php", label: "PHP · cURL", lang: "text" },
  { id: "ruby", label: "Ruby · Net::HTTP", lang: "text" },
  { id: "rust", label: "Rust · reqwest", lang: "text" },
  { id: "httpie", label: "HTTPie", lang: "text" },
  { id: "powershell", label: "PowerShell", lang: "text" },
] as const;

export type LangId = (typeof LANGUAGES)[number]["id"];

const dq = (s: string) => JSON.stringify(s); // double-quoted, escaped string literal
const sq = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const indent = (s: string, n: number) => s.replace(/\n/g, `\n${" ".repeat(n)}`);

interface Parts {
  method: string;
  url: string;
  headers: [string, string][];
  raw?: string; // raw text/JSON body
  json?: unknown; // parsed raw body when it is JSON
  form?: [string, string][]; // urlencoded
  multipart?: { key: string; value: string; file: boolean }[];
  file?: string; // binary body from a file path
}

function parts(r: RawRequest): Parts {
  const p: Parts = { method: r.method.toUpperCase(), url: r.url, headers: r.headers.map((h) => [h.key, h.value]) };
  const b = r.body;
  if (b?.type === "raw") {
    p.raw = b.content;
    try {
      p.json = JSON.parse(b.content);
    } catch {
      /* not JSON */
    }
  } else if (b?.type === "form") p.form = b.fields.map((f) => [f.key, f.value]);
  else if (b?.type === "multipart") {
    p.multipart = b.fields.map((f) => ({ key: f.key, value: f.value, file: !!f.file }));
    // The client library sets multipart Content-Type with its boundary.
    p.headers = p.headers.filter(([k]) => k.toLowerCase() !== "content-type");
  } else if (b?.type === "binary") p.file = b.path;
  return p;
}

const pyLit = (v: unknown, lvl = 0): string => {
  const pad = "    ".repeat(lvl + 1);
  const end = "    ".repeat(lvl);
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return dq(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => pad + pyLit(x, lvl + 1)).join(",\n")}\n${end}]` : "[]";
  const e = Object.entries(v as object);
  return e.length ? `{\n${e.map(([k, x]) => `${pad}${dq(k)}: ${pyLit(x, lvl + 1)}`).join(",\n")}\n${end}}` : "{}";
};

function fetchJs(p: Parts): string {
  const pre: string[] = [];
  const opts: string[] = [`method: ${dq(p.method)}`];
  const usesFiles = !!p.file || !!p.multipart?.some((f) => f.file);
  if (usesFiles) pre.push('import { readFile } from "node:fs/promises";', "");
  if (p.headers.length) opts.push(`headers: {\n${p.headers.map(([k, v]) => `    ${dq(k)}: ${dq(v)}`).join(",\n")}\n  }`);
  if (p.json !== undefined) opts.push(`body: JSON.stringify(${indent(JSON.stringify(p.json, null, 2), 2)})`);
  else if (p.raw !== undefined) opts.push(`body: ${dq(p.raw)}`);
  else if (p.form) opts.push(`body: new URLSearchParams(${JSON.stringify(Object.fromEntries(p.form))})`);
  else if (p.multipart) {
    pre.push("const form = new FormData();");
    for (const f of p.multipart)
      pre.push(
        f.file
          ? `form.append(${dq(f.key)}, new Blob([await readFile(${dq(f.value)})]), ${dq(f.value.split("/").pop()!)});`
          : `form.append(${dq(f.key)}, ${dq(f.value)});`,
      );
    opts.push("body: form");
  } else if (p.file) opts.push(`body: await readFile(${dq(p.file)})`);
  return [
    ...pre,
    `const res = await fetch(${dq(p.url)}, {\n  ${opts.join(",\n  ")},\n});`,
    'const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();',
    "console.log(res.status, data);",
  ].join("\n");
}

function axios(p: Parts): string {
  const pre = ['import axios from "axios";'];
  const cfg: string[] = [`method: ${dq(p.method.toLowerCase())}`, `url: ${dq(p.url)}`];
  if (p.headers.length) cfg.push(`headers: {\n${p.headers.map(([k, v]) => `    ${dq(k)}: ${dq(v)}`).join(",\n")}\n  }`);
  if (p.json !== undefined) cfg.push(`data: ${indent(JSON.stringify(p.json, null, 2), 2)}`);
  else if (p.raw !== undefined) cfg.push(`data: ${dq(p.raw)}`);
  else if (p.form) cfg.push(`data: new URLSearchParams(${JSON.stringify(Object.fromEntries(p.form))})`);
  else if (p.multipart) {
    pre.push('import fs from "node:fs";', "", "const form = new FormData();");
    for (const f of p.multipart)
      pre.push(f.file ? `form.append(${dq(f.key)}, new Blob([fs.readFileSync(${dq(f.value)})]), ${dq(f.value.split("/").pop()!)});` : `form.append(${dq(f.key)}, ${dq(f.value)});`);
    cfg.push("data: form");
  } else if (p.file) {
    pre.push('import fs from "node:fs";');
    cfg.push(`data: fs.readFileSync(${dq(p.file)})`);
  }
  return [...pre, "", `const res = await axios({\n  ${cfg.join(",\n  ")},\n  validateStatus: () => true,\n});`, "console.log(res.status, res.data);"].join("\n");
}

function python(p: Parts): string {
  const args = [dq(p.method), "url"];
  const lines = ["import requests", "", `url = ${dq(p.url)}`];
  if (p.headers.length) {
    lines.push(`headers = ${pyLit(Object.fromEntries(p.headers))}`);
    args.push("headers=headers");
  }
  if (p.json !== undefined) {
    lines.push(`payload = ${pyLit(p.json)}`);
    args.push("json=payload");
  } else if (p.raw !== undefined) {
    lines.push(`payload = ${dq(p.raw)}`);
    args.push("data=payload");
  } else if (p.form) {
    lines.push(`payload = ${pyLit(Object.fromEntries(p.form))}`);
    args.push("data=payload");
  } else if (p.multipart) {
    const text = p.multipart.filter((f) => !f.file);
    const files = p.multipart.filter((f) => f.file);
    if (text.length) {
      lines.push(`payload = ${pyLit(Object.fromEntries(text.map((f) => [f.key, f.value])))}`);
      args.push("data=payload");
    }
    if (files.length) {
      lines.push(`files = {\n${files.map((f) => `    ${dq(f.key)}: open(${dq(f.value)}, "rb")`).join(",\n")}\n}`);
      args.push("files=files");
    }
  } else if (p.file) {
    lines.push(`payload = open(${dq(p.file)}, "rb")`);
    args.push("data=payload");
  }
  lines.push("", `response = requests.request(${args.join(", ")})`, "print(response.status_code)", "print(response.text)");
  return lines.join("\n");
}

function go(p: Parts): string {
  const imports = ['"fmt"', '"io"', '"net/http"'];
  let body = "nil";
  const pre: string[] = [];
  if (p.raw !== undefined) {
    imports.push('"strings"');
    body = `strings.NewReader(${"`"}${p.raw.replace(/`/g, '` + "`" + `')}${"`"})`;
  } else if (p.form) {
    imports.push('"net/url"', '"strings"');
    pre.push("form := url.Values{}", ...p.form.map(([k, v]) => `form.Set(${dq(k)}, ${dq(v)})`));
    body = "strings.NewReader(form.Encode())";
  } else if (p.multipart) {
    imports.push('"bytes"', '"mime/multipart"', '"os"');
    pre.push("var buf bytes.Buffer", "mw := multipart.NewWriter(&buf)");
    for (const f of p.multipart)
      if (f.file) pre.push(`fw, _ := mw.CreateFormFile(${dq(f.key)}, ${dq(f.value.split("/").pop()!)})`, `fdata, _ := os.ReadFile(${dq(f.value)})`, "fw.Write(fdata)");
      else pre.push(`mw.WriteField(${dq(f.key)}, ${dq(f.value)})`);
    pre.push("mw.Close()");
    body = "&buf";
  } else if (p.file) {
    imports.push('"os"');
    pre.push(`payload, _ := os.Open(${dq(p.file)})`, "defer payload.Close()");
    body = "payload";
  }
  const hdr = p.headers.map(([k, v]) => `\treq.Header.Set(${dq(k)}, ${dq(v)})`);
  if (p.multipart) hdr.push("\treq.Header.Set(\"Content-Type\", mw.FormDataContentType())");
  return `package main

import (
${imports.sort().map((i) => `\t${i}`).join("\n")}
)

func main() {
${pre.map((l) => `\t${l}`).join("\n")}${pre.length ? "\n" : ""}\treq, err := http.NewRequest(${dq(p.method)}, ${dq(p.url)}, ${body})
\tif err != nil {
\t\tpanic(err)
\t}
${hdr.join("\n")}${hdr.length ? "\n" : ""}
\tres, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tpanic(err)
\t}
\tdefer res.Body.Close()
\tdata, _ := io.ReadAll(res.Body)
\tfmt.Println(res.StatusCode, string(data))
}`;
}

function java(p: Parts): string {
  const pub =
    p.raw !== undefined
      ? `HttpRequest.BodyPublishers.ofString(${dq(p.raw)})`
      : p.form
        ? `HttpRequest.BodyPublishers.ofString(${dq(new URLSearchParams(p.form).toString())})`
        : p.file
          ? `HttpRequest.BodyPublishers.ofFile(Path.of(${dq(p.file)}))`
          : "HttpRequest.BodyPublishers.noBody()";
  const headers = [...p.headers];
  if (p.form && !headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
  return `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;${p.file ? "\nimport java.nio.file.Path;" : ""}

public class Main {
    public static void main(String[] args) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(${dq(p.url)}))
${headers.map(([k, v]) => `            .header(${dq(k)}, ${dq(v)})`).join("\n")}${headers.length ? "\n" : ""}            .method(${dq(p.method)}, ${pub})
            .build();
${p.multipart ? "        // Multipart bodies need a library (e.g. Apache HttpClient MultipartEntityBuilder).\n" : ""}        HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println(response.statusCode());
        System.out.println(response.body());
    }
}`;
}

function csharp(p: Parts): string {
  const ctype = p.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1];
  const headers = p.headers.filter(([k]) => k.toLowerCase() !== "content-type");
  const lines = ["using var client = new HttpClient();", `var request = new HttpRequestMessage(new HttpMethod(${dq(p.method)}), ${dq(p.url)});`];
  for (const [k, v] of headers) lines.push(`request.Headers.TryAddWithoutValidation(${dq(k)}, ${dq(v)});`);
  if (p.raw !== undefined) lines.push(`request.Content = new StringContent(${dq(p.raw)}, System.Text.Encoding.UTF8, ${dq((ctype ?? "text/plain").split(";")[0])});`);
  else if (p.form) lines.push(`request.Content = new FormUrlEncodedContent(new Dictionary<string, string> {\n${p.form.map(([k, v]) => `    [${dq(k)}] = ${dq(v)}`).join(",\n")}\n});`);
  else if (p.multipart) {
    lines.push("var form = new MultipartFormDataContent();");
    for (const f of p.multipart)
      lines.push(f.file ? `form.Add(new ByteArrayContent(File.ReadAllBytes(${dq(f.value)})), ${dq(f.key)}, ${dq(f.value.split("/").pop()!)});` : `form.Add(new StringContent(${dq(f.value)}), ${dq(f.key)});`);
    lines.push("request.Content = form;");
  } else if (p.file) lines.push(`request.Content = new ByteArrayContent(File.ReadAllBytes(${dq(p.file)}));`);
  lines.push("var response = await client.SendAsync(request);", "Console.WriteLine((int)response.StatusCode);", "Console.WriteLine(await response.Content.ReadAsStringAsync());");
  return lines.join("\n");
}

function php(p: Parts): string {
  const opts = [`CURLOPT_URL => ${sq(p.url)}`, "CURLOPT_RETURNTRANSFER => true", `CURLOPT_CUSTOMREQUEST => ${sq(p.method)}`];
  if (p.headers.length) opts.push(`CURLOPT_HTTPHEADER => [\n${p.headers.map(([k, v]) => `        ${sq(`${k}: ${v}`)}`).join(",\n")}\n    ]`);
  if (p.raw !== undefined) opts.push(`CURLOPT_POSTFIELDS => ${sq(p.raw)}`);
  else if (p.form) opts.push(`CURLOPT_POSTFIELDS => http_build_query([${p.form.map(([k, v]) => `${sq(k)} => ${sq(v)}`).join(", ")}])`);
  else if (p.multipart) opts.push(`CURLOPT_POSTFIELDS => [${p.multipart.map((f) => `${sq(f.key)} => ${f.file ? `new CURLFile(${sq(f.value)})` : sq(f.value)}`).join(", ")}]`);
  else if (p.file) opts.push(`CURLOPT_POSTFIELDS => file_get_contents(${sq(p.file)})`);
  return `<?php
$ch = curl_init();
curl_setopt_array($ch, [
    ${opts.join(",\n    ")},
]);
$response = curl_exec($ch);
echo curl_getinfo($ch, CURLINFO_HTTP_CODE) . "\\n" . $response;
curl_close($ch);`;
}

function ruby(p: Parts): string {
  const cls = p.method.charAt(0) + p.method.slice(1).toLowerCase();
  const known = ["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"].includes(cls);
  const lines = ['require "net/http"', 'require "uri"', "", `uri = URI(${dq(p.url)})`];
  lines.push(known ? `request = Net::HTTP::${cls}.new(uri)` : `request = Net::HTTPGenericRequest.new(${dq(p.method)}, true, true, uri)`);
  for (const [k, v] of p.headers) lines.push(`request[${dq(k)}] = ${dq(v)}`);
  if (p.raw !== undefined) lines.push(`request.body = ${dq(p.raw)}`);
  else if (p.form) lines.push(`request.set_form_data(${p.form.map(([k, v]) => `${dq(k)} => ${dq(v)}`).join(", ")})`);
  else if (p.multipart) lines.push(`request.set_form([${p.multipart.map((f) => `[${dq(f.key)}, ${f.file ? `File.open(${dq(f.value)})` : dq(f.value)}]`).join(", ")}], "multipart/form-data")`);
  else if (p.file) lines.push(`request.body = File.binread(${dq(p.file)})`);
  lines.push("", 'response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") { |http| http.request(request) }', "puts response.code", "puts response.body");
  return lines.join("\n");
}

function rust(p: Parts): string {
  const lines = [`let client = reqwest::Client::new();`, `let res = client`, `    .request(reqwest::Method::from_bytes(b${dq(p.method)})?, ${dq(p.url)})`];
  for (const [k, v] of p.headers) lines.push(`    .header(${dq(k)}, ${dq(v)})`);
  if (p.raw !== undefined) lines.push(`    .body(${p.raw.includes('"#') ? dq(p.raw) : `r#"${p.raw}"#`})`);
  else if (p.form) lines.push(`    .form(&[${p.form.map(([k, v]) => `(${dq(k)}, ${dq(v)})`).join(", ")}])`);
  else if (p.multipart)
    lines.splice(
      1,
      0,
      `let form = reqwest::multipart::Form::new()${p.multipart.map((f) => (f.file ? `\n    .file(${dq(f.key)}, ${dq(f.value)}).await?` : `\n    .text(${dq(f.key)}, ${dq(f.value)})`)).join("")};`,
    ),
      lines.push("    .multipart(form)");
  else if (p.file) lines.push(`    .body(std::fs::read(${dq(p.file)})?)`);
  lines.push("    .send()", "    .await?;", 'println!("{}", res.status());', 'println!("{}", res.text().await?);');
  return `// Cargo.toml: reqwest = { version = "0.12", features = ["json", "multipart"] }, tokio = { version = "1", features = ["full"] }
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ${lines.join("\n    ")}
    Ok(())
}`;
}

function httpie(p: Parts): string {
  const out = [`http ${p.multipart ? "--multipart " : p.form ? "--form " : ""}${p.method} ${shq(p.url)}`];
  for (const [k, v] of p.headers) out.push(shq(`${k}:${v}`));
  if (p.form) for (const [k, v] of p.form) out.push(shq(`${k}=${v}`));
  if (p.multipart) for (const f of p.multipart) out.push(shq(f.file ? `${f.key}@${f.value}` : `${f.key}=${f.value}`));
  let cmd = out.join(" \\\n  ");
  if (p.raw !== undefined) cmd = `echo ${shq(p.raw)} | ${cmd}`;
  if (p.file) cmd = `${cmd} < ${shq(p.file)}`;
  return cmd;
}

function powershell(p: Parts): string {
  const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const lines: string[] = [];
  if (p.headers.length) lines.push(`$headers = @{\n${p.headers.map(([k, v]) => `    ${psq(k)} = ${psq(v)}`).join("\n")}\n}`);
  const args = [`-Uri ${psq(p.url)}`, `-Method ${p.method}`];
  if (p.headers.length) args.push("-Headers $headers");
  if (p.raw !== undefined) {
    lines.push(`$body = @'\n${p.raw}\n'@`);
    args.push("-Body $body");
  } else if (p.form) {
    lines.push(`$body = @{\n${p.form.map(([k, v]) => `    ${psq(k)} = ${psq(v)}`).join("\n")}\n}`);
    args.push("-Body $body");
  } else if (p.multipart) {
    lines.push(`$form = @{\n${p.multipart.map((f) => `    ${psq(f.key)} = ${f.file ? `Get-Item ${psq(f.value)}` : psq(f.value)}`).join("\n")}\n}`);
    args.push("-Form $form");
  } else if (p.file) args.push(`-InFile ${psq(p.file)}`);
  lines.push(`$response = Invoke-WebRequest ${args.join(" ")} -SkipHttpErrorCheck`, "$response.StatusCode", "$response.Content");
  return lines.join("\n");
}

export function generate(lang: LangId, req: RawRequest): string {
  const p = parts(req);
  switch (lang) {
    case "curl":
      return toCurl(req);
    case "fetch":
      return fetchJs(p);
    case "axios":
      return axios(p);
    case "python":
      return python(p);
    case "go":
      return go(p);
    case "java":
      return java(p);
    case "csharp":
      return csharp(p);
    case "php":
      return php(p);
    case "ruby":
      return ruby(p);
    case "rust":
      return rust(p);
    case "httpie":
      return httpie(p);
    case "powershell":
      return powershell(p);
  }
}
