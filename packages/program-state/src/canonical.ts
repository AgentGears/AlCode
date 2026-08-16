// Versioned deterministic canonical JSON profile for the pure ProgramState
// package. The implementation intentionally has no dependency on storage,
// events, filesystem, process, network, or Host runtime packages.

export function assertCanonical(value: unknown, path = "$", seen = new Set<object>()): void {
  switch (typeof value) {
    case "undefined":
      throw new TypeError(`canonical-json: undefined is not allowed (at ${path})`);
    case "function":
    case "symbol":
      throw new TypeError(`canonical-json: ${typeof value} is not allowed (at ${path})`);
    case "bigint":
      throw new TypeError(`canonical-json: bigint is not supported (at ${path})`);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonical-json: non-finite number is not allowed (at ${path})`);
      }
      return;
    case "string":
    case "boolean":
      return;
    case "object": {
      if (value === null) return;
      if (seen.has(value)) throw new TypeError(`canonical-json: circular value is not allowed (at ${path})`);
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) assertCanonical(value[i], `${path}[${i}]`, seen);
          return;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new TypeError(`canonical-json: non-plain object is not allowed (at ${path})`);
        }
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) assertCanonical(record[key], `${path}.${key}`, seen);
        return;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`canonical-json: unsupported type ${typeof value} (at ${path})`);
  }
}

export function canonicalStringify(value: unknown): string {
  assertCanonical(value);
  const out: string[] = [];
  emit(value, out);
  return out.join("");
}

function emit(value: unknown, out: string[]): void {
  switch (typeof value) {
    case "string": out.push(quoteString(value)); return;
    case "number": out.push(value.toString()); return;
    case "boolean": out.push(value ? "true" : "false"); return;
    case "object": {
      if (value === null) { out.push("null"); return; }
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
        out.push(quoteString(key), ":");
        emit(record[key], out);
      }
      out.push("}");
      return;
    }
    default:
      throw new TypeError(`canonical-json: unreachable type ${typeof value}`);
  }
}

const ESCAPE: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function quoteString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    const escaped = ESCAPE[ch];
    if (escaped !== undefined) out += escaped;
    else {
      const code = ch.charCodeAt(0);
      out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
    }
  }
  return `${out}"`;
}
