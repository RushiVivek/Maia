/**
 * Parse and validate the atlas ROOT release body. Mirrors atlas's
 * `RootDoc.from_body` reject conditions exactly:
 *   - body = `<!-- ATLAS_ROOT_v1 -->` + "\n" + compact JSON (after .strip()).
 *   - reject if the marker is wrong; distinguish a newer ATLAS_ROOT_ marker.
 *   - schema must be the integer 1.
 *   - vault_mode must be "snapshot" or "live".
 *   - each snapshot needs non-empty string id/name/created/manifest; parent
 *     is a string or null.
 *
 * Also parses a snapshot's `manifest` field, which for snapshot-mode vaults is
 * a "manifest pointer": a JSON STRING whose value is a JSON array of
 * [chunk_id_hex, key_hex] pairs (double-encoded; both HEX here).
 */

import type { ManifestPointerRef, RootDoc, Snapshot, VaultMode } from "./types.ts";
import { BadVaultError } from "./errors.ts";

const ROOT_MARKER = "<!-- ATLAS_ROOT_v1 -->";
const SCHEMA_VERSION = 1;

export function parseRootBody(body: string): RootDoc {
  const text = body.trim();
  if (!text.startsWith(ROOT_MARKER)) {
    if (text.startsWith("<!-- ATLAS_ROOT_")) {
      throw new BadVaultError(`unsupported ROOT schema marker; this reader expects ${ROOT_MARKER}`);
    }
    throw new BadVaultError("ROOT body missing the ATLAS_ROOT_v1 marker");
  }

  const jsonPart = text.slice(ROOT_MARKER.length).trim();
  let payload: unknown;
  try {
    payload = JSON.parse(jsonPart);
  } catch (e) {
    throw new BadVaultError(`ROOT body JSON is malformed: ${(e as Error).message}`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new BadVaultError("ROOT body must be a JSON object");
  }
  const obj = payload as Record<string, unknown>;

  const schema = obj.schema;
  // JSON has no bool/int ambiguity, but guard against `true`/floats anyway.
  if (typeof schema !== "number" || !Number.isInteger(schema)) {
    throw new BadVaultError(`ROOT schema must be an integer, got ${JSON.stringify(schema)}`);
  }
  if (schema !== SCHEMA_VERSION) {
    throw new BadVaultError(`unsupported ROOT schema ${schema}; expected ${SCHEMA_VERSION}`);
  }

  const vaultMode = obj.vault_mode;
  if (vaultMode !== "snapshot" && vaultMode !== "live") {
    throw new BadVaultError(
      `ROOT vault_mode must be 'snapshot' or 'live', got ${JSON.stringify(vaultMode)}`,
    );
  }

  const snapsRaw = obj.snapshots ?? [];
  if (!Array.isArray(snapsRaw)) {
    throw new BadVaultError("ROOT snapshots must be a list");
  }
  const snapshots = snapsRaw.map(parseSnapshot);

  const updatedAt = typeof obj.updated_at === "string" ? obj.updated_at : "";

  return {
    schema: SCHEMA_VERSION,
    vaultMode: vaultMode as VaultMode,
    snapshots,
    updatedAt,
  };
}

function parseSnapshot(raw: unknown): Snapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadVaultError("snapshot record must be an object");
  }
  const d = raw as Record<string, unknown>;
  const str = (field: string): string => {
    const v = d[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new BadVaultError(`snapshot.${field} must be a non-empty string`);
    }
    // A lone surrogate would make encodeURIComponent throw when building links;
    // reject as a malformed vault (502) rather than a later 500.
    if (!v.isWellFormed()) throw new BadVaultError(`snapshot.${field} is not well-formed UTF-16`);
    return v;
  };
  const parent = d.parent;
  if (parent !== undefined && parent !== null && typeof parent !== "string") {
    throw new BadVaultError("snapshot.parent must be a string or null");
  }
  return {
    id: str("id"),
    name: str("name"),
    created: str("created"),
    manifest: str("manifest"),
    parent: typeof parent === "string" ? parent : null,
  };
}

/**
 * Parse a snapshot's manifest pointer string into an ordered list of HEX
 * (chunk_id, key) refs. Double-encoded: the field is a JSON string whose value
 * is a JSON array of [cid_hex, key_hex] pairs.
 */
export function parseManifestPointer(pointer: string): ManifestPointerRef[] {
  let arr: unknown;
  try {
    arr = JSON.parse(pointer);
  } catch (e) {
    throw new BadVaultError(`manifest pointer is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr)) {
    throw new BadVaultError("manifest pointer must be a JSON array of [cid_hex, key_hex] pairs");
  }
  return arr.map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new BadVaultError(`manifest pointer pair ${i} must be [cid_hex, key_hex]`);
    }
    const [cidHex, keyHex] = pair;
    if (typeof cidHex !== "string" || typeof keyHex !== "string") {
      throw new BadVaultError(`manifest pointer pair ${i} must contain two hex strings`);
    }
    return { cidHex, keyHex };
  });
}

export { ROOT_MARKER, SCHEMA_VERSION };
