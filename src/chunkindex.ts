/**
 * The chunk index: a cached map of chunk_id_hex -> GitHub asset_id, built by
 * paginating all `atlas-chunk-<vaultId>-*` releases and their assets.
 *
 * This is the cold-start cost (100+ releases per vault), so it is built once and
 * held for the process lifetime. A lookup miss (a manifest references a chunk
 * the map doesn't know — e.g. the vault grew since we built it) refreshes the
 * map, then re-looks-up. That refresh is THROTTLED to at most once per
 * REBUILD_COOLDOWN_MS: otherwise a genuinely-absent chunk (corrupt manifest, or
 * a request for a path whose chunk is gone) would re-paginate every release on
 * every lookup and burn the GitHub rate limit. The cooldown still lets a grown
 * vault be picked up — just not on every single miss.
 */

import type { GithubClient } from "./github.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const REBUILD_COOLDOWN_MS = 30_000;

export class ChunkIndex {
  #client: GithubClient;
  #map: Map<string, number> | null = null;
  #building: Promise<Map<string, number>> | null = null;
  /** Wall-clock ms marking the start of the cooldown window; 0 until first build. */
  #lastBuiltAt = 0;

  constructor(client: GithubClient) {
    this.#client = client;
  }

  /**
   * Resolve a chunk_id_hex to its asset id. On a miss, refresh the map at most
   * once per cooldown window, then re-look-up. `now` is injectable for tests.
   */
  async assetId(cidHex: string, now: number = Date.now()): Promise<number | undefined> {
    const key = cidHex.toLowerCase();
    let map = await this.#ensure(now);
    const hit = map.get(key);
    if (hit !== undefined) return hit;
    // Miss: the vault may have grown since we built. Refresh — but only if the
    // last build is older than the cooldown, so repeated misses don't re-index.
    if (now - this.#lastBuiltAt >= REBUILD_COOLDOWN_MS) {
      map = await this.#rebuild(now);
    }
    return map.get(key);
  }

  /** Number of indexed chunks (for diagnostics/tests). Builds if needed. */
  async size(): Promise<number> {
    return (await this.#ensure()).size;
  }

  #ensure(now: number = Date.now()): Promise<Map<string, number>> {
    if (this.#map) return Promise.resolve(this.#map);
    return this.#rebuild(now);
  }

  #rebuild(now: number): Promise<Map<string, number>> {
    // Collapse concurrent rebuilds into one in-flight build.
    if (this.#building) return this.#building;
    this.#building = this.#build().then((m) => {
      this.#map = m;
      this.#lastBuiltAt = now;
      this.#building = null;
      return m;
    }).catch((e) => {
      this.#building = null;
      throw e;
    });
    return this.#building;
  }

  async #build(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const releases = await this.#client.listChunkReleases();
    for (const release of releases) {
      const assets = await this.#client.listReleaseAssets(release.id);
      for (const a of assets) {
        const name = a.name.toLowerCase();
        // Only accept assets whose name is exactly a 64-char lowercase hex
        // chunk_id; ignore anything else atlas might attach.
        if (HEX64.test(name)) map.set(name, a.id);
      }
    }
    return map;
  }
}
