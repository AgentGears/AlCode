// Canonical JSON serialization for event payloads, digests, and golden
// fixtures. See docs/event-contract.md §"Serialization".
//
// Properties of canonical output:
//   - object keys sorted lexicographically (UTF-16 code-unit order)
//   - UTF-8 encoded, no insignificant whitespace, no trailing newline
//   - timestamps serialized as RFC 3339 UTC strings ending in "Z"
//   - no `undefined`, no `NaN`, no ±Infinity, no functions, no symbols, no
//     BigInts beyond the safe-integer range, no locale-formatted numbers.
//
// The serializer throws on any value that would make output non-deterministic
// across runtimes (per the contract's "canonical payloads are valid JSON
// values only" rule).

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/**
 * Validate that a value is canonical-JSON-safe, recursively. Throws on
 * `undefined`, functions, symbols, `NaN`, ±Infinity, non-safe-number BigInts,
 * and circular references. Call this at append time.
 */
export function assertCanonical(value: unknown, path = "$"): void {
  switch (typeof value) {
    case "undefined":
      throw new TypeError(`canonical-json: undefined is not allowed (at ${path})`);
    case "function":
    case "symbol":
      throw new TypeError(`canonical-json: ${typeof value} is not allowed (at ${path})`);
    case "bigint": {
      throw new TypeError(`canonical-json: bigint is not supported (at ${path}); use number`);
    }
    case "number": {
      if (Number.isNaN(value)) {
        throw new TypeError(`canonical-json: NaN is not allowed (at ${path})`);
      }
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonical-json: Infinity/-Infinity is not allowed (at ${path})`);
      }
      return;
    }
    case "string":
    case "boolean":
      return;
    case "object": {
      if (value === null) return;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          assertCanonical(value[i], `${path}[${i}]`);
        }
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        assertCanonical(record[key], `${path}.${key}`);
      }
      return;
    }
    default:
      throw new TypeError(`canonical-json: unsupported type ${typeof value} (at ${path})`);
  }
}

/**
 * Serialize a canonical-JSON-safe value to a stable string. Object keys are
 * sorted lexicographically; no whitespace. Throws on unsafe values (callers
 * should validate with {@link assertCanonical} first, or accept the throw).
 *
 * Sorting is done by walking the structure and emitting into an array of
 * string chunks; this avoids relying on `JSON.stringify`'s insertion-order
 * output for object keys (V8 preserves insertion order, which is not
 * canonical across producers).
 */
export function canonicalStringify(value: unknown): string {
  assertCanonical(value);
  const out: string[] = [];
  emit(value, out);
  return out.join("");
}

function emit(value: unknown, out: string[]): void {
  switch (typeof value) {
    case "string":
      out.push(quoteString(value));
      return;
    case "number":
      // Number.prototype.toString is canonical for finite IEEE-754 doubles
      // (V8, SpiderMonkey, JavaScriptCore all agree on shortest round-trip).
      out.push(value.toString());
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "object": {
      if (value === null) {
        out.push("null");
        return;
      }
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(",");
          emit(value[i], out);
        }
        out.push("]");
        return;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      out.push("{");
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        if (i > 0) out.push(",");
        out.push(quoteString(key));
        out.push(":");
        emit(record[key], out);
      }
      out.push("}");
      return;
    }
    default:
      // assertCanonical already rejected function/symbol/bigint/undefined.
      throw new TypeError(`canonical-json: unreachable type ${typeof value}`);
  }
}

// Minimal JSON-string quoting. Does not depend on JSON.stringify's quoting
// choices (some engines escape non-ASCII; we do not — valid UTF-8 in/out).
// Escapes the required control characters and the quote and backslash.
const ESCAPE: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function quoteString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const escaped = ESCAPE[ch];
    if (escaped !== undefined) {
      out += escaped;
    } else {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += "\\u" + code.toString(16).padStart(4, "0");
      } else {
        out += ch;
      }
    }
  }
  out += '"';
  return out;
}

/**
 * Compute a SHA-256 hex digest over the canonical JSON of the given value.
 * Used by `append` to compute `eventDigest` over the persisted event.
 */
export async function sha256Canonical(value: unknown): Promise<string> {
  const canonical = canonicalStringify(value);
  return sha256CanonicalText(canonical);
}

/**
 * Compute a SHA-256 hex digest over an already-canonical JSON string. Used
 * for digest verification (re-hashing exactly what was hashed at append time,
 * without reconstructing the value and risking field drift).
 */
export async function sha256CanonicalText(canonical: string): Promise<string> {
  const data = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
