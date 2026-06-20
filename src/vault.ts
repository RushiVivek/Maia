/**
 * Vault orchestration: ties the GitHub client, chunk index, and parsers into
 * the read operations the server needs. Owns the caches:
 *   - ROOT doc: single value, short TTL (new snapshots appear without redeploy).
 *   - manifest: per snapshot id, process-life (immutable per id).
 */

import type { GithubClient } from "./github.ts";
import { ChunkIndex } from "./chunkindex.ts";
import type { ChunkRef, Manifest, ManifestEntry, RootDoc, Snapshot } from "./types.ts";
import { parseManifestPointer, parseRootBody } from "./rootdoc.ts";
import { decodeManifest } from "./manifest.ts";
import { bytesToHex, decryptChunk, hexToCid, hexToKey } from "./crypto.ts";
import { BadVaultError, NotFoundError } from "./errors.ts";

const ROOT_TTL_MS = 60_000;

export class Vault {
  #client: GithubClient;
  #index: ChunkIndex;
  #root: { doc: RootDoc; at: number } | null = null;
  #manifests = new Map<string, Manifest>();

  constructor(client: GithubClient) {
    this.#client = client;
    this.#index = new ChunkIndex(client);
  }

  /** Load the ROOT doc, using a short TTL cache. */
  async loadRoot(now: number = Date.now()): Promise<RootDoc> {
    if (this.#root && now - this.#root.at < ROOT_TTL_MS) return this.#root.doc;
    const body = await this.#client.getRootBody();
    if (body === null) {
      throw new NotFoundError("vault ROOT release not found (check owner/repo/vault id)");
    }
    const doc = parseRootBody(body);
    if (doc.vaultMode !== "snapshot") {
      throw new BadVaultError(
        `maia supports snapshot vaults only, got vault_mode=${doc.vaultMode}`,
      );
    }
    this.#root = { doc, at: now };
    return doc;
  }

  /** List snapshots (newest-last, as atlas stores them). */
  async listSnapshots(): Promise<Snapshot[]> {
    return (await this.loadRoot()).snapshots;
  }

  /**
   * Resolve a `<snap>` selector to a snapshot. Accepts an exact id, a unique
   * id prefix, or an exact name. Ambiguous prefixes/names are rejected.
   */
  async getSnapshot(selector: string): Promise<Snapshot> {
    const snaps = await this.listSnapshots();

    const byId = snaps.find((s) => s.id === selector);
    if (byId) return byId;

    const byName = snaps.filter((s) => s.name === selector);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new NotFoundError(`ambiguous snapshot name '${selector}' (use the id)`);
    }

    if (selector.length >= 4) {
      const byPrefix = snaps.filter((s) => s.id.startsWith(selector));
      if (byPrefix.length === 1) return byPrefix[0]!;
      if (byPrefix.length > 1) {
        throw new NotFoundError(`ambiguous snapshot id prefix '${selector}'`);
      }
    }

    throw new NotFoundError(`snapshot '${selector}' not found`);
  }

  /** Load and cache a snapshot's manifest (immutable per snapshot id). */
  async loadManifest(snapshot: Snapshot): Promise<Manifest> {
    const cached = this.#manifests.get(snapshot.id);
    if (cached) return cached;

    const refs = parseManifestPointer(snapshot.manifest);
    const parts: Uint8Array[] = [];
    for (const ref of refs) {
      // Validate the cid hex (length-checks), then look it up by its hex form.
      const cid = hexToCid(ref.cidHex);
      const asset = await this.#fetchAsset(bytesToHex(cid));
      parts.push(decryptChunk(hexToKey(ref.keyHex), asset));
    }
    const manifest = decodeManifest(concat(parts));
    this.#manifests.set(snapshot.id, manifest);
    return manifest;
  }

  /** Find a file entry in a snapshot by its relative path. */
  async resolveEntry(snapshot: Snapshot, path: string): Promise<ManifestEntry> {
    const manifest = await this.loadManifest(snapshot);
    const entry = manifest.entries.find((e) => e.p === path);
    if (!entry) throw new NotFoundError(`path '${path}' not found in snapshot`);
    return entry;
  }

  /**
   * Fetch + decrypt one of a file's chunks (raw-bytes ref). Used by the range
   * streamer. Kept on the Vault so it shares the chunk index + client.
   */
  async readChunk(ref: ChunkRef): Promise<Uint8Array> {
    const asset = await this.#fetchAsset(bytesToHex(ref.cid));
    return decryptChunk(ref.key, asset);
  }

  async #fetchAsset(cidHex: string): Promise<Uint8Array> {
    const assetId = await this.#index.assetId(cidHex);
    if (assetId === undefined) {
      throw new NotFoundError(`chunk ${cidHex} not found in vault releases`);
    }
    return await this.#client.downloadAsset(assetId);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
