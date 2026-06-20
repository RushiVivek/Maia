import { assertEquals, assertThrows } from "@std/assert";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { encodeHex } from "@std/encoding/hex";
import { bytesToHex, chunkIdHex, decryptChunk, hexToCid, hexToKey } from "../src/crypto.ts";
import { BadVaultError } from "../src/errors.ts";

const NONCE = new Uint8Array(12);

function encrypt(key: Uint8Array, pt: Uint8Array): Uint8Array {
  return chacha20poly1305(key, NONCE).encrypt(pt);
}

Deno.test("decryptChunk round-trips with fixed zero nonce", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const pt = new TextEncoder().encode("the eldest Pleiad");
  const asset = encrypt(key, pt);
  assertEquals(asset.length, pt.length + 16); // Poly1305 tag
  assertEquals(decryptChunk(key, asset), pt);
});

Deno.test("decryptChunk rejects a tampered ciphertext", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const asset = encrypt(key, new TextEncoder().encode("hello"));
  asset[0] = (asset[0] ?? 0) ^ 0xff;
  assertThrows(() => decryptChunk(key, asset), BadVaultError);
});

Deno.test("decryptChunk rejects a wrong-length key", () => {
  assertThrows(() => decryptChunk(new Uint8Array(16), new Uint8Array(32)), BadVaultError);
});

Deno.test("chunkIdHex equals blake3(asset) as 32-byte lowercase hex", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const asset = encrypt(key, new TextEncoder().encode("x"));
  const expected = encodeHex(blake3(asset, { dkLen: 32 }));
  const hex = chunkIdHex(asset);
  // Independently compute the digest so a wrong hash input/algorithm is caught.
  assertEquals(hex, expected);
  assertEquals(hex.length, 64);
  assertEquals(hex, hex.toLowerCase());
});

Deno.test("hexToKey / hexToCid validate length", () => {
  const good = "ab".repeat(32);
  assertEquals(hexToKey(good).length, 32);
  assertEquals(hexToCid(good).length, 32);
  assertEquals(bytesToHex(hexToCid(good)), good);
  assertThrows(() => hexToKey("ab".repeat(31)), BadVaultError);
  assertThrows(() => hexToCid("nothex!!"), BadVaultError);
});
