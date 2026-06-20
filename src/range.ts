/**
 * Parse a single HTTP Range header against a known total size. We support a
 * single byte range (the only form browsers/VLC send): `bytes=A-B`, `bytes=A-`
 * (to EOF), and `bytes=-N` (suffix). Multi-range requests are treated as a full
 * response (200), which is a valid server choice.
 *
 * All offsets are inclusive. `size` is the authoritative file length from the
 * manifest entry's `s` field.
 */

export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number } // inclusive
  | { kind: "unsatisfiable" };

export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: "full" };

  const trimmed = header.trim();
  const prefix = "bytes=";
  if (!trimmed.toLowerCase().startsWith(prefix)) return { kind: "full" };

  const spec = trimmed.slice(prefix.length);
  // Multiple ranges -> serve the whole thing.
  if (spec.includes(",")) return { kind: "full" };

  const dash = spec.indexOf("-");
  if (dash < 0) return { kind: "full" };

  const startRaw = spec.slice(0, dash).trim();
  const endRaw = spec.slice(dash + 1).trim();

  // Suffix range: bytes=-N  -> last N bytes.
  if (startRaw === "") {
    if (endRaw === "") return { kind: "full" };
    const n = parseUint(endRaw);
    if (n === null) return { kind: "full" };
    if (size === 0 || n === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - n);
    return { kind: "partial", start, end: size - 1 };
  }

  const start = parseUint(startRaw);
  if (start === null) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };

  // Open-ended: bytes=A-
  if (endRaw === "") {
    return { kind: "partial", start, end: size - 1 };
  }

  const end = parseUint(endRaw);
  if (end === null) return { kind: "full" };
  if (end < start) return { kind: "unsatisfiable" };

  return { kind: "partial", start, end: Math.min(end, size - 1) };
}

function parseUint(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
