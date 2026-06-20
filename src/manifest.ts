/**
 * Decode an atlas manifest (msgpack). Mirrors atlas's `manifest.loads`:
 *   - envelope is a map with `schema` (must be 1) and `entries` (a list).
 *   - each entry: p (rel path), m (mode), t (mtime_ns), s (size), c (chunks).
 *   - ⚠️ in `c`, each chunk is [chunk_id, key] as RAW 32-byte msgpack bin
 *     (Uint8Array), NOT hex — unlike the ROOT pointer. This is the hex-vs-bytes
 *     trap; the 32-byte length assert below is what catches a hex mix-up.
 *   - rel_path: non-empty, no NUL, not absolute, no ".." segment.
 *   - mode 0..0xFFFF; mtime_ns >= 0; size >= 0; rel_paths unique.
 */

import { decode } from "@msgpack/msgpack";
import type { ChunkRef, Manifest, ManifestEntry } from "./types.ts";
import { CHUNK_ID_LEN, KEY_LEN } from "./crypto.ts";
import { BadVaultError } from "./errors.ts";

const SCHEMA_VERSION = 1;

export function decodeManifest(data: Uint8Array): Manifest {
  let payload: unknown;
  try {
    payload = decode(data);
  } catch (e) {
    throw new BadVaultError(`manifest is not valid msgpack: ${(e as Error).message}`);
  }
  if (!isPlainObject(payload)) {
    throw new BadVaultError("manifest envelope must be a map");
  }

  const schema = payload.schema;
  if (typeof schema !== "number" || !Number.isInteger(schema)) {
    throw new BadVaultError(`manifest schema must be an integer, got ${JSON.stringify(schema)}`);
  }
  if (schema !== SCHEMA_VERSION) {
    throw new BadVaultError(`unsupported manifest schema ${schema}; expected ${SCHEMA_VERSION}`);
  }

  const entriesRaw = payload.entries;
  if (!Array.isArray(entriesRaw)) {
    throw new BadVaultError("manifest entries must be a list");
  }

  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < entriesRaw.length; i++) {
    const entry = parseEntry(entriesRaw[i], i);
    if (seen.has(entry.p)) {
      throw new BadVaultError(`duplicate rel_path in manifest: ${entry.p}`);
    }
    seen.add(entry.p);
    entries.push(entry);
  }

  return { schema: SCHEMA_VERSION, entries };
}

function parseEntry(raw: unknown, i: number): ManifestEntry {
  if (!isPlainObject(raw)) {
    throw new BadVaultError(`entries[${i}] must be a map`);
  }

  const p = raw.p;
  validateRelPath(p, i);

  const m = intField(raw.m, `entries[${i}].m`);
  if (m < 0 || m > 0xFFFF) throw new BadVaultError(`entries[${i}].m must fit in 16 bits, got ${m}`);

  const t = intField(raw.t, `entries[${i}].t`);
  if (t < 0) throw new BadVaultError(`entries[${i}].t (mtime_ns) must be >= 0, got ${t}`);

  const s = intField(raw.s, `entries[${i}].s`);
  if (s < 0) throw new BadVaultError(`entries[${i}].s (size) must be >= 0, got ${s}`);

  const chunksRaw = raw.c;
  if (!Array.isArray(chunksRaw)) {
    throw new BadVaultError(`entries[${i}].c must be a list`);
  }
  const c: ChunkRef[] = chunksRaw.map((pair, j) => parseChunkRef(pair, i, j));

  return { p, m, t, s, c };
}

function parseChunkRef(raw: unknown, i: number, j: number): ChunkRef {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new BadVaultError(`entries[${i}].c[${j}] must be a 2-element list`);
  }
  const [cid, key] = raw;
  // The trap-catcher: hex would arrive as a string, and a raw cid/key must be
  // exactly 32 bytes. Anything else is a malformed (or misencoded) vault.
  if (!(cid instanceof Uint8Array) || cid.length !== CHUNK_ID_LEN) {
    throw new BadVaultError(
      `entries[${i}].c[${j}] chunk_id must be ${CHUNK_ID_LEN} raw bytes`,
    );
  }
  if (!(key instanceof Uint8Array) || key.length !== KEY_LEN) {
    throw new BadVaultError(`entries[${i}].c[${j}] key must be ${KEY_LEN} raw bytes`);
  }
  return { cid, key };
}

function validateRelPath(p: unknown, i: number): asserts p is string {
  if (typeof p !== "string") throw new BadVaultError(`entries[${i}].p must be a string`);
  if (p.length === 0) throw new BadVaultError(`entries[${i}].p must be non-empty`);
  if (p.includes("\x00")) throw new BadVaultError(`entries[${i}].p contains a NUL byte`);
  if (p.startsWith("/")) throw new BadVaultError(`entries[${i}].p must be relative, not absolute`);
  if (p.split("/").some((seg) => seg === "..")) {
    throw new BadVaultError(`entries[${i}].p must not contain '..' segments`);
  }
  // A lone surrogate would make encodeURIComponent throw when we build links —
  // reject it as a malformed vault (502) rather than letting it surface as 500.
  if (!p.isWellFormed()) throw new BadVaultError(`entries[${i}].p is not well-formed UTF-16`);
}

function intField(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new BadVaultError(`${label} must be an integer, got ${JSON.stringify(v)}`);
  }
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

export { SCHEMA_VERSION };
