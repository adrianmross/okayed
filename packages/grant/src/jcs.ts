/**
 * JSON Canonicalization Scheme (RFC 8785) for the JSON this format uses: objects with keys sorted by UTF-16
 * code units, no whitespace, ECMAScript number serialization. `undefined` members are dropped, as in JSON.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : jcs(v))).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`JCS: cannot serialize ${typeof value}`);
}
