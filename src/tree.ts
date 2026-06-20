/**
 * Group flat manifest entry paths into a single directory level's listing.
 * Given all file paths and a directory prefix (""=root, or "a/b/"), returns the
 * immediate subdirectories and files directly under that prefix.
 */

import type { ManifestEntry } from "./types.ts";
import { NotFoundError } from "./errors.ts";

export interface DirChild {
  name: string;
  isDir: boolean;
  /** Full relative path for a file; undefined for a dir. */
  path?: string;
  /** File size for a file; undefined for a dir. */
  size?: number;
}

/**
 * `prefix` is "" for root or ends with "/" for a subdir. Throws nothing; an
 * unknown prefix simply yields an empty listing (caller decides 404).
 */
export function listDir(entries: ManifestEntry[], prefix: string): DirChild[] {
  const dirs = new Map<string, true>();
  const files: DirChild[] = [];

  for (const e of entries) {
    if (!e.p.startsWith(prefix)) continue;
    const rest = e.p.slice(prefix.length);
    if (rest.length === 0) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      // A file directly in this directory.
      files.push({ name: rest, isDir: false, path: e.p, size: e.s });
    } else {
      // A subdirectory; record its immediate name once.
      dirs.set(rest.slice(0, slash), true);
    }
  }

  const dirChildren: DirChild[] = [...dirs.keys()].map((name) => ({ name, isDir: true }));
  dirChildren.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirChildren, ...files];
}

/** True if any entry exists at or under this directory prefix. */
export function dirExists(entries: ManifestEntry[], prefix: string): boolean {
  if (prefix === "") return true; // root always listable
  return entries.some((e) => e.p.startsWith(prefix));
}

/** Normalize a request path segment into a clean relative path (no leading/trailing slash issues). */
export function normalizePath(raw: string): string {
  // Decode each segment, then trim leading/trailing slashes. Interior "//" is
  // left as-is — it simply won't match any (validated) manifest path and 404s.
  const decoded = raw.split("/").map(decodeSegment).join("/");
  return decoded.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Percent-decode one path segment. A malformed escape (e.g. `%zz`) makes
 * decodeURIComponent throw URIError; translate that into a 404 rather than
 * letting it bubble up as a generic 500.
 */
export function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new NotFoundError("malformed path encoding");
  }
}
