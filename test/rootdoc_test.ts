import { assertEquals, assertThrows } from "@std/assert";
import { parseManifestPointer, parseRootBody, ROOT_MARKER } from "../src/rootdoc.ts";
import { BadVaultError } from "../src/errors.ts";
import { nn } from "./util.ts";

function body(json: unknown): string {
  return ROOT_MARKER + "\n" + JSON.stringify(json);
}

const validDoc = {
  schema: 1,
  vault_mode: "snapshot",
  index_chunk: null,
  manifest: null,
  snapshots: [
    { id: "abc123", name: "first", created: "2026-01-01T00:00:00Z", manifest: "[]", parent: null },
  ],
  updated_at: "2026-01-01T00:00:00Z",
};

Deno.test("parseRootBody accepts a valid doc and ignores index_chunk", () => {
  const doc = parseRootBody(body(validDoc));
  assertEquals(doc.vaultMode, "snapshot");
  assertEquals(doc.snapshots.length, 1);
  assertEquals(nn(doc.snapshots[0]).id, "abc123");
  assertEquals(nn(doc.snapshots[0]).parent, null);
});

Deno.test("parseRootBody tolerates surrounding whitespace", () => {
  const doc = parseRootBody("\n  " + body(validDoc) + "  \n");
  assertEquals(doc.snapshots.length, 1);
});

Deno.test("parseRootBody rejects a missing marker", () => {
  assertThrows(() => parseRootBody(JSON.stringify(validDoc)), BadVaultError, "missing");
});

Deno.test("parseRootBody distinguishes a newer marker", () => {
  const b = "<!-- ATLAS_ROOT_v2 -->\n" + JSON.stringify(validDoc);
  assertThrows(() => parseRootBody(b), BadVaultError, "unsupported ROOT schema marker");
});

Deno.test("parseRootBody rejects schema != 1", () => {
  assertThrows(() => parseRootBody(body({ ...validDoc, schema: 2 })), BadVaultError, "schema");
});

Deno.test("parseRootBody rejects an unknown vault_mode", () => {
  assertThrows(
    () => parseRootBody(body({ ...validDoc, vault_mode: "archive" })),
    BadVaultError,
    "vault_mode",
  );
});

Deno.test("parseRootBody rejects a snapshot missing required fields", () => {
  const bad = { ...validDoc, snapshots: [{ id: "x", name: "y", created: "z" }] };
  assertThrows(() => parseRootBody(body(bad)), BadVaultError, "manifest");
});

Deno.test("parseRootBody rejects a lone surrogate in a snapshot field", () => {
  const bad = { ...validDoc, snapshots: [{ ...validDoc.snapshots[0], name: "bad\uD800name" }] };
  assertThrows(() => parseRootBody(body(bad)), BadVaultError, "well-formed");
});

Deno.test("parseManifestPointer decodes hex pairs in order", () => {
  const pointer = JSON.stringify([
    ["aa".repeat(32), "bb".repeat(32)],
    ["cc".repeat(32), "dd".repeat(32)],
  ]);
  const refs = parseManifestPointer(pointer);
  assertEquals(refs.length, 2);
  assertEquals(nn(refs[0]).cidHex, "aa".repeat(32));
  assertEquals(nn(refs[1]).keyHex, "dd".repeat(32));
});

Deno.test("parseManifestPointer rejects malformed shapes", () => {
  assertThrows(() => parseManifestPointer("not json"), BadVaultError);
  assertThrows(() => parseManifestPointer(JSON.stringify({})), BadVaultError);
  assertThrows(() => parseManifestPointer(JSON.stringify([["onlyone"]])), BadVaultError);
  assertThrows(() => parseManifestPointer(JSON.stringify([[1, 2]])), BadVaultError);
});
