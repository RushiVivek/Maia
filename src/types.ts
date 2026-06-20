/**
 * Shared types mirroring the atlas read-path format. The crypto/format params
 * are fixed by atlas and verified against its source — see the plan and README.
 */

/** atlas vault mode. maia targets `snapshot`; `live` is recognized but unsupported. */
export type VaultMode = "snapshot" | "live";

/**
 * A (chunk_id, key) pair as it appears in the ROOT manifest *pointer*: both HEX
 * strings (64 chars each). This is the encoding ONLY for the pointer.
 */
export interface ManifestPointerRef {
  cidHex: string;
  keyHex: string;
}

/**
 * A (chunk_id, key) pair as it appears in a manifest entry's `c` field: RAW
 * 32-byte values (msgpack bin), NOT hex. This is the hex-vs-bytes trap — the
 * two encodings are intentionally distinct types so they can never be confused.
 */
export interface ChunkRef {
  cid: Uint8Array;
  key: Uint8Array;
}

/** One snapshot entry from the ROOT doc's `snapshots` array. */
export interface Snapshot {
  id: string;
  name: string;
  created: string;
  /** The raw manifest pointer string (double-encoded JSON of hex pairs). */
  manifest: string;
  parent: string | null;
}

/** Parsed ROOT doc (after marker strip + schema validation). */
export interface RootDoc {
  schema: 1;
  vaultMode: VaultMode;
  snapshots: Snapshot[];
  updatedAt: string;
}

/** One file entry in a decoded manifest. */
export interface ManifestEntry {
  /** Relative POSIX path: no leading "/", no ".." segments. */
  p: string;
  /** POSIX mode bits. */
  m: number;
  /** mtime in nanoseconds. */
  t: number;
  /** Authoritative total file length in bytes. */
  s: number;
  /** Ordered chunks; concat of decrypted chunks (in order) == the file. */
  c: ChunkRef[];
}

/** A decoded manifest. */
export interface Manifest {
  schema: 1;
  entries: ManifestEntry[];
}
