import { assertEquals, assertRejects } from "@std/assert";
import { buildMockVault } from "./fixture/mkvault.ts";
import { Vault } from "../src/vault.ts";
import { type ChunkReader, rangeStream } from "../src/reconstruct.ts";
import { parseRange } from "../src/range.ts";
import type { ChunkRef } from "../src/types.ts";
import { nn } from "./util.ts";

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

// A file whose content is 0..199 split into deliberately uneven chunks
// (10, 7, 13, ... via chunkSize) to exercise boundary math.
const original = new Uint8Array(200);
for (let i = 0; i < original.length; i++) original[i] = i % 256;

function makeVault() {
  const vault = buildMockVault("testvault", [{
    id: "snap0001",
    name: "test",
    files: [
      { path: "media/clip.bin", bytes: original, chunkSize: 13 },
      { path: "small.txt", bytes: new TextEncoder().encode("hi"), chunkSize: 64 },
      { path: "empty", bytes: new Uint8Array(0), chunkSize: 64 },
    ],
    manifestChunkSize: 40, // force a multi-chunk manifest too
  }]);
  return new Vault(vault.client);
}

Deno.test("end-to-end: full file reconstructs byte-identical", async () => {
  const vault = makeVault();
  const snap = await vault.getSnapshot("snap0001");
  const entry = await vault.resolveEntry(snap, "media/clip.bin");
  assertEquals(entry.s, 200);
  const got = await collect(rangeStream(vault, entry.c, 0, entry.s - 1));
  assertEquals(got, original);
});

Deno.test("end-to-end: many random ranges match original.slice", async () => {
  const vault = makeVault();
  const snap = await vault.getSnapshot("snap0001");
  const entry = await vault.resolveEntry(snap, "media/clip.bin");
  const cases: Array<[number, number]> = [
    [0, 0],
    [0, 12], // exactly first chunk
    [12, 13], // straddles chunk boundary
    [13, 25], // exactly second chunk
    [5, 150], // spans many chunks, partial ends
    [199, 199], // last byte
    [180, 199], // tail
  ];
  for (const [a, b] of cases) {
    const got = await collect(rangeStream(vault, entry.c, a, b));
    assertEquals(got, original.slice(a, b + 1), `range ${a}-${b}`);
  }
});

Deno.test("end-to-end: parseRange + stream agree for suffix range", async () => {
  const vault = makeVault();
  const snap = await vault.getSnapshot("snap0001");
  const entry = await vault.resolveEntry(snap, "media/clip.bin");
  const r = parseRange("bytes=-20", entry.s);
  if (r.kind !== "partial") throw new Error("expected partial");
  const got = await collect(rangeStream(vault, entry.c, r.start, r.end));
  assertEquals(got, original.slice(180, 200));
});

Deno.test("end-to-end: small + empty files", async () => {
  const vault = makeVault();
  const snap = await vault.getSnapshot("snap0001");

  const small = await vault.resolveEntry(snap, "small.txt");
  assertEquals(small.s, 2);
  const sgot = await collect(rangeStream(vault, small.c, 0, small.s - 1));
  assertEquals(new TextDecoder().decode(sgot), "hi");

  const empty = await vault.resolveEntry(snap, "empty");
  assertEquals(empty.s, 0);
  assertEquals(empty.c.length, 0);
});

Deno.test("snapshot selector: id prefix and name resolve", async () => {
  const vault = makeVault();
  assertEquals((await vault.getSnapshot("snap")).id, "snap0001");
  assertEquals((await vault.getSnapshot("test")).id, "snap0001");
  assertEquals((await vault.getSnapshot("snap0001")).name, "test");
});

Deno.test("stream errors if chunks fall short of the promised length", async () => {
  // A reader returning one 4-byte chunk, but we ask for 10 bytes (corrupt `s`).
  const ref: ChunkRef = { cid: new Uint8Array(32), key: new Uint8Array(32) };
  const reader: ChunkReader = {
    readChunk: () => Promise.resolve(new Uint8Array([1, 2, 3, 4])),
  };
  await assertRejects(
    () => collect(rangeStream(reader, [ref], 0, 9)),
    Error,
    "Content-Length promised",
  );
});

Deno.test("stream propagates a chunk read failure", async () => {
  const ref: ChunkRef = { cid: new Uint8Array(32), key: new Uint8Array(32) };
  const reader: ChunkReader = {
    readChunk: () => Promise.reject(new Error("boom")),
  };
  await assertRejects(() => collect(rangeStream(reader, [ref], 0, 9)), Error, "boom");
});

Deno.test("chunk index resolves real chunk ids", async () => {
  const built = buildMockVault("v2", [{
    id: "s1",
    name: "n",
    files: [{ path: "f", bytes: original, chunkSize: 50 }],
  }]);
  const vault = new Vault(built.client);
  const snap = await vault.getSnapshot("s1");
  const entry = await vault.resolveEntry(snap, "f");
  const ref = nn(entry.c[0]);
  const pt = await vault.readChunk(ref);
  assertEquals(pt.length, 50);
});
