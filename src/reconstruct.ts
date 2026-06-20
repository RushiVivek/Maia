/**
 * Stream a file (or a byte range of it) by decrypting its chunks one at a time.
 *
 * Memory: ChaCha20-Poly1305 is one-shot, so a whole chunk's ciphertext +
 * plaintext live transiently while it decrypts — but only ONE chunk at a time.
 * The ReadableStream is pull-based, so `pull` runs only when the consumer wants
 * more, and each chunk's plaintext goes out of scope between pulls. We never
 * buffer the whole file.
 *
 * Range math: per-chunk plaintext sizes are not stored, so we learn each
 * chunk's length only after decrypting. We walk chunks in order, track the
 * running plaintext offset, skip chunks entirely before the range, slice the
 * boundary chunks, and stop once we pass the end. Cold seeks (large `start`)
 * pay to decrypt-and-discard the chunks before `start` — correct, just CPU.
 */

import type { ChunkRef } from "./types.ts";

export interface ChunkReader {
  readChunk(ref: ChunkRef): Promise<Uint8Array>;
}

/**
 * Build a ReadableStream emitting bytes [start, end] (inclusive) of the file
 * reconstructed from `chunks`. If start/end span the whole file, it streams all
 * of it. Assumes 0 <= start <= end (caller resolves Range first).
 */
export function rangeStream(
  reader: ChunkReader,
  chunks: ChunkRef[],
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let i = 0;
  let offset = 0; // plaintext offset of the start of chunk i
  let emitted = 0; // bytes enqueued so far within [start, end]
  const expected = end - start + 1; // bytes the caller promised (Content-Length)
  let done = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      try {
        await pump(controller);
      } catch (e) {
        // A chunk fetch/decrypt failed after headers were already sent. Log it
        // (the route's try/catch has long since returned) and error the body so
        // the client connection aborts instead of hanging.
        console.error("stream error:", e instanceof Error ? e.message : String(e));
        done = true;
        controller.error(e);
      }
    },
  });

  async function pump(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    while (i < chunks.length) {
      if (offset > end) break;
      const ref = chunks[i]!;
      const pt = await reader.readChunk(ref);
      const chunkStart = offset;
      const chunkEnd = offset + pt.length - 1; // inclusive
      offset += pt.length;
      i++;

      // Entirely before the requested range — skip (but offset advanced).
      if (chunkEnd < start) continue;

      const from = Math.max(start, chunkStart) - chunkStart;
      const to = Math.min(end, chunkEnd) - chunkStart + 1; // exclusive
      const slice = pt.subarray(from, to);
      emitted += slice.length;
      controller.enqueue(slice);
      // Enqueue one slice per pull so back-pressure bounds memory to ~1 chunk.
      if (offset > end) break;
      return;
    }
    done = true;
    // Chunks exhausted before reaching the promised length: the vault's `s`
    // disagrees with its actual chunk data (corrupt/inconsistent vault). Error
    // the stream so the client sees a clean abort, not a hang waiting for bytes
    // that will never come.
    if (emitted < expected) {
      controller.error(
        new Error(`reconstructed ${emitted} bytes but Content-Length promised ${expected}`),
      );
      return;
    }
    controller.close();
  }
}
