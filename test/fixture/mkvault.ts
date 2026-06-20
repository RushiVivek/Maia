/**
 * Builds a byte-exact in-memory atlas vault fixture + a mock GithubClient, so
 * the whole read path is testable offline. Everything here matches the verified
 * atlas format:
 *   - ChaCha20-Poly1305, fixed 12-zero-byte nonce, asset = ciphertext||tag.
 *   - chunk_id = blake3(asset) lowercase hex; asset filename == that hex.
 *   - ROOT body = marker + "\n" + compact JSON; manifest pointer = double-encoded
 *     JSON array of HEX [cid, key] pairs.
 *   - manifest = msgpack {schema, entries:[{p,m,t,s,c}]} with c = RAW 32-byte
 *     bin [cid, key] pairs (the hex-vs-bytes trap, exercised on purpose).
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { encodeHex } from "@std/encoding/hex";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { ROOT_MARKER } from "../../src/rootdoc.ts";
import type { GithubClient, Release, ReleaseAsset } from "../../src/github.ts";

const FIXED_NONCE = new Uint8Array(12);

export interface MockFile {
  path: string;
  mode?: number;
  mtimeNs?: number;
  bytes: Uint8Array;
  /** Plaintext chunk size; the file is split into pieces of this many bytes. */
  chunkSize: number;
}

export interface MockSnapshotSpec {
  id: string;
  name: string;
  created?: string;
  parent?: string | null;
  files: MockFile[];
  /** Chunk size for the serialized manifest itself. */
  manifestChunkSize?: number;
}

export interface MockVault {
  vaultId: string;
  rootBody: string;
  /** chunk_id_hex -> ciphertext (the "asset" bytes). */
  assets: Map<string, Uint8Array>;
  client: GithubClient;
}

interface BuiltAsset {
  cidHex: string;
  key: Uint8Array;
  asset: Uint8Array;
}

function encryptChunk(plaintext: Uint8Array): BuiltAsset {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const asset = chacha20poly1305(key, FIXED_NONCE).encrypt(plaintext);
  const cidHex = encodeHex(blake3(asset, { dkLen: 32 }));
  return { cidHex, key, asset };
}

function splitChunks(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (chunkSize < 1) throw new Error("chunkSize must be >= 1");
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += chunkSize) {
    out.push(bytes.subarray(off, Math.min(off + chunkSize, bytes.length)));
  }
  // An empty file still produces zero chunks; size 0 is valid.
  return out;
}

export function buildMockVault(
  vaultId: string,
  snapshots: MockSnapshotSpec[],
): MockVault {
  const assets = new Map<string, Uint8Array>();
  const record = (b: BuiltAsset) => {
    assets.set(b.cidHex, b.asset);
    return b;
  };

  const snapRecords = snapshots.map((spec) => {
    // Build each file's chunks (raw-bytes refs go into the manifest).
    const entries = spec.files.map((f) => {
      const built = splitChunks(f.bytes, f.chunkSize).map((pt) => record(encryptChunk(pt)));
      const c = built.map((b) => [hexToBytes(b.cidHex), b.key]);
      return {
        p: f.path,
        m: f.mode ?? 0o644,
        t: f.mtimeNs ?? 0,
        s: f.bytes.length,
        c,
      };
    });

    // Serialize the manifest, then chunk + encrypt it; pointer holds HEX pairs.
    const manifestBytes = msgpackEncode({ schema: 1, entries }, { useBigInt64: false });
    const manifestPieces = splitChunks(
      manifestBytes,
      spec.manifestChunkSize ?? Math.max(1, manifestBytes.length),
    ).map((pt) => record(encryptChunk(pt)));
    const pointerPairs = manifestPieces.map((b) => [b.cidHex, encodeHex(b.key)]);
    const pointer = JSON.stringify(pointerPairs);

    return {
      id: spec.id,
      name: spec.name,
      created: spec.created ?? "2026-01-01T00:00:00Z",
      manifest: pointer,
      parent: spec.parent ?? null,
    };
  });

  const rootBody = ROOT_MARKER + "\n" + JSON.stringify({
    schema: 1,
    vault_mode: "snapshot",
    index_chunk: null,
    manifest: null,
    snapshots: snapRecords,
    updated_at: "2026-01-01T00:00:00Z",
  });

  // Mock GitHub: lay assets out across chunk releases the way atlas would, so
  // the chunk-index builder (paginate releases -> paginate assets) exercises.
  const cidList = [...assets.keys()];
  const releases: Release[] = [];
  const assetsByRelease = new Map<number, ReleaseAsset[]>();
  // assetId is just an index; map back to cidHex for downloadAsset.
  const assetIdToCid = new Map<number, string>();
  let nextAssetId = 1000;
  cidList.forEach((cidHex, idx) => {
    const releaseId = 1 + Math.floor(idx / 3); // ~3 assets per release
    const tag = `atlas-chunk-${vaultId}-${String(releaseId).padStart(6, "0")}`;
    if (!assetsByRelease.has(releaseId)) {
      releases.push({ id: releaseId, tag_name: tag });
      assetsByRelease.set(releaseId, []);
    }
    const assetId = nextAssetId++;
    assetIdToCid.set(assetId, cidHex);
    assetsByRelease.get(releaseId)!.push({
      id: assetId,
      name: cidHex,
      size: assets.get(cidHex)!.length,
    });
  });

  const client: GithubClient = {
    getRootBody: () => Promise.resolve(rootBody),
    listChunkReleases: () => Promise.resolve(releases.map((r) => ({ ...r }))),
    listReleaseAssets: (releaseId: number) =>
      Promise.resolve((assetsByRelease.get(releaseId) ?? []).map((a) => ({ ...a }))),
    downloadAsset: (assetId: number) => {
      const cidHex = assetIdToCid.get(assetId);
      const asset = cidHex ? assets.get(cidHex) : undefined;
      if (!asset) return Promise.reject(new Error(`mock: unknown asset ${assetId}`));
      return Promise.resolve(asset);
    },
  };

  return { vaultId, rootBody, assets, client };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
