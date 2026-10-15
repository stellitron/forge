/**
 * Hiding sensitive values in examples that leave Forge (generated docs, OpenAPI export).
 * Secrets are always hidden. In "sample" mode, personal data is also replaced with fake values
 * of the same shape, so examples stay useful without exposing real people.
 */

export type ExampleMode = "off" | "sample" | "real";

export const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|auth|cookie|session|signature|credential|private/i;
const SECRET_VALUE = (v: string) => /^eyJ[\w-]+\.[\w-]+\./.test(v) || /^(bearer|basic)\s+\S{8,}/i.test(v) || (v.length >= 32 && /^[\w\-+/=.~]+$/.test(v) && /\d/.test(v) && /[a-z]/i.test(v) && !/^\d+$/.test(v));
export const HIDDEN = "••••••";

// Personal data, by field name and by value. Matching is generous on purpose: a fake value in
// the docs costs little, a real customer's address in a shared page costs a lot.
const PII_KEY = /e-?mail|phone|mobile|^fax|(first|last|full|middle|given|family|display|user|customer|contact|account)_?name|^name$|^contact|address|street|^city$|^zip|postal|post_?code|birth|^dob$|^ssn$|national_?id|passport|tax_?id|^vat|iban|account_?(number|no)|card_?(number|no)|^pan$|^ip$|ip_?addr|latitude|longitude|^lat$|^lng$|^lon$|^geo$/i;
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi;
const PHONE = /^\+?[\d\s().-]{7,20}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const EMAIL_ONLY = /^[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}$/i;
/** A whole value that is an email, phone number or IP address. Emails inside text are swapped in place instead. */
const looksPersonal = (v: string) => EMAIL_ONLY.test(v.trim()) || (PHONE.test(v) && (v.match(/\d/g) ?? []).length >= 7 && /[\s().+-]/.test(v)) || IPV4.test(v);

function sampleValue(key: string, v: string): string {
  const k = key.toLowerCase();
  if (/mail/.test(k) || EMAIL_ONLY.test(v.trim())) return "user@example.com";
  if (/phone|mobile|fax/.test(k) || PHONE.test(v)) return "+1 555 0100";
  if (/^ip|ip_?addr/.test(k) || IPV4.test(v)) return "192.0.2.1";
  if (/birth|dob/.test(k)) return "1990-01-01";
  if (/street|address/.test(k)) return "1 Example Street";
  if (/city/.test(k)) return "Example City";
  if (/zip|postal|post_?code/.test(k)) return "00000";
  if (/name/.test(k)) return "Example Name";
  return HIDDEN;
}

/**
 * Copies a JSON value for documentation: secrets hidden, and in "sample" mode personal data
 * replaced with fake values of the same type. Long arrays are shortened and long strings cut.
 */
export function redact(v: unknown, key = "", depth = 0, mode: Exclude<ExampleMode, "off"> = "sample"): unknown {
  if (depth > 8) return "…";
  const sample = mode === "sample";
  if (typeof v === "string") {
    // {{placeholders}} aren't secrets and tell readers what to fill in.
    if (v.includes("{{")) return v;
    if (SECRET_KEY.test(key) || SECRET_VALUE(v)) return HIDDEN;
    if (sample && (PII_KEY.test(key) || looksPersonal(v))) return sampleValue(key, v);
    const text = sample ? v.replace(EMAIL, "user@example.com") : v;
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  }
  if (typeof v === "number" || typeof v === "boolean" || v === null) {
    if (v !== null && SECRET_KEY.test(key)) return HIDDEN;
    return sample && typeof v === "number" && PII_KEY.test(key) ? 0 : v;
  }
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => redact(x, key, depth + 1, mode));
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redact(x, k, depth + 1, mode)]));
  return v;
}

/** Plain-text bodies: hide emails, JWTs and bearer tokens. */
export const redactText = (s: string) => s.replace(EMAIL, "user@example.com").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, HIDDEN).replace(/(bearer|basic)\s+\S{8,}/gi, `$1 ${HIDDEN}`);
