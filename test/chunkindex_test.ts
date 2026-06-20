import { assertEquals } from "@std/assert";
import { ChunkIndex } from "../src/chunkindex.ts";
import type { GithubClient, Release, ReleaseAsset } from "../src/github.ts";

const CID_A = "a".repeat(64);
const CID_B = "b".repeat(64);

/** A client that counts how many times the releases are paginated (= rebuilds). */
function countingClient(assetsByName: Record<string, number>): {
  client: GithubClient;
  builds: () => number;
} {
  let builds = 0;
  const release: Release = { id: 1, tag_name: "atlas-chunk-v-000001" };
  const assets: ReleaseAsset[] = Object.entries(assetsByName).map(([name, id]) => ({
    id,
    name,
    size: 10,
  }));
  const client: GithubClient = {
    getRootBody: () => Promise.resolve(null),
    listChunkReleases: () => {
      builds++;
      return Promise.resolve([release]);
    },
    listReleaseAssets: () => Promise.resolve(assets),
    downloadAsset: () => Promise.reject(new Error("n/a")),
  };
  return { client, builds: () => builds };
}

Deno.test("assetId resolves a known chunk after one build", async () => {
  const { client, builds } = countingClient({ [CID_A]: 100 });
  const idx = new ChunkIndex(client);
  assertEquals(await idx.assetId(CID_A), 100);
  assertEquals(await idx.assetId(CID_A), 100);
  assertEquals(builds(), 1); // hit is cached; no rebuild
});

Deno.test("repeated misses do NOT rebuild on every lookup (cooldown throttles)", async () => {
  const { client, builds } = countingClient({ [CID_A]: 100 });
  const idx = new ChunkIndex(client);
  // Many lookups for an absent chunk within the cooldown window: the index was
  // just built, so none of them should re-paginate the releases.
  for (let k = 0; k < 5; k++) {
    assertEquals(await idx.assetId(CID_B, 1000 + k), undefined);
  }
  assertEquals(builds(), 1); // only the initial build
});

Deno.test("a miss after the cooldown window rebuilds and can pick up growth", async () => {
  const store: Record<string, number> = { [CID_A]: 100 };
  let builds = 0;
  const client: GithubClient = {
    getRootBody: () => Promise.resolve(null),
    listChunkReleases: () => {
      builds++;
      return Promise.resolve([{ id: 1, tag_name: "atlas-chunk-v-000001" }]);
    },
    listReleaseAssets: () =>
      Promise.resolve(Object.entries(store).map(([name, id]) => ({ id, name, size: 10 }))),
    downloadAsset: () => Promise.reject(new Error("n/a")),
  };
  const idx = new ChunkIndex(client);
  assertEquals(await idx.assetId(CID_A, 0), 100); // initial build at t=0
  // Vault grows.
  store[CID_B] = 200;
  // A miss within the cooldown won't see it yet.
  assertEquals(await idx.assetId(CID_B, 1000), undefined);
  // A miss past the cooldown rebuilds and finds it.
  assertEquals(await idx.assetId(CID_B, 40_000), 200);
  assertEquals(builds, 2); // initial build at t=0 + one rebuild past the cooldown
});
