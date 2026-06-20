import { assertEquals, assertThrows } from "@std/assert";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { decodeManifest } from "../src/manifest.ts";
import { BadVaultError } from "../src/errors.ts";
import { nn } from "./util.ts";

function cid(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function validManifest(): Uint8Array {
  return msgpackEncode({
    schema: 1,
    entries: [
      { p: "docs/readme.txt", m: 0o644, t: 0, s: 11, c: [[cid(1), cid(2)]] },
      { p: "a/b/c.bin", m: 0o600, t: 5, s: 0, c: [] },
    ],
  });
}

Deno.test("decodeManifest decodes entries with RAW-BYTES chunk refs", () => {
  const m = decodeManifest(validManifest());
  assertEquals(m.entries.length, 2);
  const first = nn(m.entries[0]);
  assertEquals(first.p, "docs/readme.txt");
  assertEquals(first.s, 11);
  // The trap: c[i].cid/key MUST be 32-byte Uint8Array, not hex strings.
  const ref = nn(first.c[0]);
  assertEquals(ref.cid instanceof Uint8Array, true);
  assertEquals(ref.cid.length, 32);
  assertEquals(ref.key.length, 32);
});

Deno.test("decodeManifest REJECTS hex-encoded chunk refs (the trap guard)", () => {
  // A vault that wrongly stored hex strings in `c` instead of raw bytes.
  const bad = msgpackEncode({
    schema: 1,
    entries: [{ p: "x", m: 0, t: 0, s: 1, c: [["aa".repeat(32), "bb".repeat(32)]] }],
  });
  assertThrows(() => decodeManifest(bad), BadVaultError, "raw bytes");
});

Deno.test("decodeManifest rejects a non-32-byte chunk ref", () => {
  const bad = msgpackEncode({
    schema: 1,
    entries: [{ p: "x", m: 0, t: 0, s: 1, c: [[new Uint8Array(16), cid(2)]] }],
  });
  assertThrows(() => decodeManifest(bad), BadVaultError, "32 raw bytes");
});

Deno.test("decodeManifest rejects schema != 1", () => {
  const bad = msgpackEncode({ schema: 2, entries: [] });
  assertThrows(() => decodeManifest(bad), BadVaultError, "schema");
});

Deno.test("decodeManifest rejects path traversal and absolute paths", () => {
  for (const p of ["../escape", "a/../../etc", "/abs/path", "x/..", ""]) {
    const bad = msgpackEncode({ schema: 1, entries: [{ p, m: 0, t: 0, s: 0, c: [] }] });
    assertThrows(() => decodeManifest(bad), BadVaultError);
  }
});

Deno.test("decodeManifest rejects mode out of 16-bit range and negatives", () => {
  const badMode = msgpackEncode({
    schema: 1,
    entries: [{ p: "x", m: 0x10000, t: 0, s: 0, c: [] }],
  });
  assertThrows(() => decodeManifest(badMode), BadVaultError, "16 bits");
  const badSize = msgpackEncode({ schema: 1, entries: [{ p: "x", m: 0, t: 0, s: -1, c: [] }] });
  assertThrows(() => decodeManifest(badSize), BadVaultError, "size");
});

Deno.test("decodeManifest rejects a lone surrogate in a path (malformed UTF-16)", () => {
  const bad = msgpackEncode({
    schema: 1,
    entries: [{ p: "bad\uD800name.txt", m: 0, t: 0, s: 0, c: [] }],
  });
  assertThrows(() => decodeManifest(bad), BadVaultError, "well-formed");
});

Deno.test("decodeManifest rejects duplicate rel_paths", () => {
  const dup = msgpackEncode({
    schema: 1,
    entries: [
      { p: "same", m: 0, t: 0, s: 0, c: [] },
      { p: "same", m: 0, t: 0, s: 0, c: [] },
    ],
  });
  assertThrows(() => decodeManifest(dup), BadVaultError, "duplicate");
});
