/**
 * Crypto for the atlas read path. Verified against atlas source:
 *   - ChaCha20-Poly1305 AEAD, 256-bit key.
 *   - Nonce is FIXED at 12 zero bytes. No associated data.
 *   - Stored asset bytes = ciphertext || 16-byte Poly1305 tag.
 *   - chunk_id = blake3(ciphertext), 32-byte digest, lowercase hex.
 *
 * The fixed nonce is safe here because atlas uses convergent encryption: each
 * chunk's key is derived per-plaintext, so no (key, nonce) pair ever repeats.
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { decodeHex, encodeHex } from "@std/encoding/hex";
import { BadVaultError } from "./errors.ts";

const KEY_LEN = 32;
const CHUNK_ID_LEN = 32;
/** atlas: `_FIXED_NONCE = b"\x00" * 12`. */
const FIXED_NONCE = new Uint8Array(12);

/**
 * Decrypt one chunk's stored asset bytes (ciphertext||tag) with its 32-byte key.
 * Throws BadVaultError if the key is the wrong length or the AEAD tag fails to
 * authenticate (tampered/corrupt ciphertext, or wrong key).
 */
export function decryptChunk(key: Uint8Array, asset: Uint8Array): Uint8Array {
  if (key.length !== KEY_LEN) {
    throw new BadVaultError(`chunk key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  try {
    return chacha20poly1305(key, FIXED_NONCE).decrypt(asset);
  } catch (e) {
    throw new BadVaultError(`chunk decryption/authentication failed: ${(e as Error).message}`);
  }
}

/** Compute the chunk_id (blake3 of the ciphertext) as lowercase hex. */
export function chunkIdHex(asset: Uint8Array): string {
  return encodeHex(blake3(asset, { dkLen: CHUNK_ID_LEN }));
}

/**
 * Decode a 64-char lowercase-hex string into 32 raw bytes, validating length.
 * Used on the ROOT manifest pointer, where cid/key are HEX (unlike manifest
 * entries, where they are already raw bytes).
 */
export function hexToKey(hex: string): Uint8Array {
  const bytes = hexToBytes(hex, "key");
  if (bytes.length !== KEY_LEN) {
    throw new BadVaultError(`hex key must decode to ${KEY_LEN} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Decode a hex chunk_id into 32 raw bytes, validating length. */
export function hexToCid(hex: string): Uint8Array {
  const bytes = hexToBytes(hex, "chunk_id");
  if (bytes.length !== CHUNK_ID_LEN) {
    throw new BadVaultError(
      `hex chunk_id must decode to ${CHUNK_ID_LEN} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

function hexToBytes(hex: string, what: string): Uint8Array {
  try {
    return decodeHex(hex);
  } catch (e) {
    throw new BadVaultError(`invalid hex ${what}: ${(e as Error).message}`);
  }
}

/** Encode raw bytes as lowercase hex (e.g. a chunk_id for asset lookup). */
export function bytesToHex(bytes: Uint8Array): string {
  return encodeHex(bytes);
}

export { CHUNK_ID_LEN, KEY_LEN };
