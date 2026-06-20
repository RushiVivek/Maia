/**
 * End-to-end test against a REAL atlas vault on GitHub. Read-only.
 *
 * Gated: only runs when MAIA_E2E=1 and the real env secrets are present. Run it
 * manually, never in default CI (it hits the network and needs the PAT):
 *
 *   MAIA_E2E=1 \
 *   GITHUB_OWNER=... GITHUB_REPO=... ATLAS_VAULT_ID=... GITHUB_TOKEN=... \
 *   deno test --allow-net --allow-env test/e2e_test.ts
 */

import { assert, assertEquals } from "@std/assert";
import { createGithubClient } from "../src/github.ts";
import { Vault } from "../src/vault.ts";
import { rangeStream } from "../src/reconstruct.ts";

const enabled = Deno.env.get("MAIA_E2E") === "1";

Deno.test({
  name: "e2e: read a real atlas vault",
  ignore: !enabled,
  fn: async () => {
    const owner = required("GITHUB_OWNER");
    const repo = required("GITHUB_REPO");
    const vaultId = required("ATLAS_VAULT_ID");
    const token = required("GITHUB_TOKEN");

    const vault = new Vault(createGithubClient({ owner, repo, vaultId, token }));

    const snaps = await vault.listSnapshots();
    assert(snaps.length > 0, "expected at least one snapshot");
    const newest = snaps[snaps.length - 1]!;
    console.log(`newest snapshot: ${newest.id} (${newest.name})`);

    const manifest = await vault.loadManifest(newest);
    assert(manifest.entries.length > 0, "expected at least one file entry");

    // Pick the smallest non-empty file to keep the test cheap.
    const small = manifest.entries
      .filter((e) => e.s > 0)
      .sort((a, b) => a.s - b.s)[0];
    assert(small, "expected a non-empty file");
    console.log(`smallest file: ${small.p} (${small.s} bytes, ${small.c.length} chunks)`);

    // Full read: byte count must equal the authoritative size.
    const full = await collect(rangeStream(vault, small.c, 0, small.s - 1));
    assertEquals(full.length, small.s, "full read length must equal s");

    // Range read: first 16 bytes (or the whole file if smaller) must match.
    const end = Math.min(15, small.s - 1);
    const part = await collect(rangeStream(vault, small.c, 0, end));
    assertEquals(part, full.slice(0, end + 1), "range slice must match the full read");
  },
});

function required(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`e2e requires env var ${key}`);
  return v;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of stream) parts.push(c);
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
