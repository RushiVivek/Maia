/**
 * HTTP server: routing, auth wrapping, and error→Response mapping.
 *
 * Routes (all behind withAuth):
 *   GET /                      -> snapshot list (HTML, or JSON if Accept: json)
 *   GET /<snap>/               -> directory listing of a snapshot
 *   GET /<snap>/<dir>/         -> directory listing of a subdir
 *   GET /<snap>/<path>         -> stream a file (Range-aware)
 *
 * The whole router is wrapped once in withAuth, so every route is gated.
 */

import type { Config } from "./config.ts";
import { createGithubClient } from "./github.ts";
import { Vault } from "./vault.ts";
import { rangeStream } from "./reconstruct.ts";
import { parseRange } from "./range.ts";
import { contentType } from "./mime.ts";
import { decodeSegment, dirExists, listDir, normalizePath } from "./tree.ts";
import { COOKIE_NAME, type Handler, tokensEqual, withAuth } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { renderSnapshotList } from "./views/snapshots.ts";
import { renderListing } from "./views/listing.ts";

export function buildHandler(config: Config): Deno.ServeHandler {
  const client = createGithubClient({
    owner: config.owner,
    repo: config.repo,
    vaultId: config.vaultId,
    token: config.githubToken,
  });
  return buildHandlerWithVault(config.authToken, new Vault(client));
}

/** Build the handler around an already-constructed Vault (used by tests). */
export function buildHandlerWithVault(authToken: string, vault: Vault): Deno.ServeHandler {
  const router: Handler = async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return text(405, "Method Not Allowed");
    }
    try {
      return await route(vault, req);
    } catch (e) {
      if (e instanceof HttpError) {
        // 4xx messages are safe + useful to the client. 5xx messages can carry
        // upstream GitHub error snippets and owner/repo paths — log those
        // server-side and return a generic body so nothing internal leaks.
        if (e.status >= 500) {
          console.error("upstream/vault error:", e.message);
          return text(e.status, "Bad Gateway");
        }
        return text(e.status, e.message);
      }
      console.error("unhandled error:", e instanceof Error ? e.message : String(e));
      return text(500, "Internal Server Error");
    }
  };

  const guarded = withAuth(authToken, router);
  const withBootstrap = withCookieBootstrap(authToken, guarded);
  return (req, _info) => withBootstrap(req);
}

/**
 * When the request carries a valid `?token=`, (re)set the cookie so subsequent
 * tokenless navigations/asset loads work. We set it even if a cookie is already
 * present, so a stale cookie (after an AUTH_TOKEN rotation) is refreshed by
 * visiting a fresh `?token=` link rather than wedging the browser at 401.
 */
function withCookieBootstrap(authToken: string, guarded: Handler): Handler {
  return async (req) => {
    const url = new URL(req.url);
    const qpToken = url.searchParams.get("token");
    const res = await guarded(req);
    // Set the cookie only when the guard served real content (2xx) and the
    // request's ?token is the valid token (verified CONSTANT-TIME, never with
    // `===` on the raw secret). Gating on 2xx (not merely "not 401") keeps the
    // long-lived auth cookie off redirects and error responses.
    if (
      res.status >= 200 && res.status < 300 && qpToken !== null &&
      await tokensEqual(qpToken, authToken)
    ) {
      const headers = new Headers(res.headers);
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${
          encodeURIComponent(authToken)
        }; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`,
      );
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  };
}

async function route(vault: Vault, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tokenQuery = url.searchParams.has("token")
    ? `?token=${encodeURIComponent(url.searchParams.get("token")!)}`
    : "";

  // Split path into segments, dropping empties.
  const rawSegments = url.pathname.split("/").filter((s) => s.length > 0);

  // GET /
  if (rawSegments.length === 0) {
    const snaps = await vault.listSnapshots();
    if (wantsJson(req)) {
      return json(200, snaps.map((s) => ({ id: s.id, name: s.name, created: s.created })));
    }
    return html(200, renderSnapshotList(snaps, tokenQuery));
  }

  // First segment is the snapshot selector.
  const snapSel = decodeSegment(rawSegments[0]!);
  const snap = await vault.getSnapshot(snapSel);

  // Remaining path (already without snapshot segment).
  const restRaw = rawSegments.slice(1).join("/");
  const path = normalizePath(restRaw);
  // A trailing slash (or empty rest) means "directory listing".
  const isDirRequest = restRaw === "" || url.pathname.endsWith("/");

  const manifest = await vault.loadManifest(snap);

  if (isDirRequest) {
    const prefix = path === "" ? "" : path + "/";
    if (!dirExists(manifest.entries, prefix)) {
      return text(404, `directory '${path}' not found in snapshot`);
    }
    const children = listDir(manifest.entries, prefix);
    if (wantsJson(req)) {
      return json(200, {
        snapshot: { id: snap.id, name: snap.name },
        dir: path,
        children,
      });
    }
    return html(200, renderListing(snap, prefix, children, tokenQuery, url.origin));
  }

  // File request: but the path might actually be a directory (no trailing /).
  // If it's a directory, redirect to the trailing-slash form.
  const asDirPrefix = path + "/";
  const isFile = manifest.entries.some((e) => e.p === path);
  if (!isFile && dirExists(manifest.entries, asDirPrefix)) {
    // Safe from header (CRLF) injection: `url` is a parsed URL, so pathname and
    // search are already percent-encoded (control chars cannot appear raw).
    const loc = url.pathname.replace(/\/?$/, "/") + url.search;
    // no-store: the Location may carry ?token=, which must not be cached by an
    // intermediary (308 is cacheable by default).
    return new Response(null, {
      status: 308,
      headers: { "Location": loc, "Cache-Control": "no-store" },
    });
  }

  const entry = await vault.resolveEntry(snap, path);
  return streamFile(vault, req, entry.c, entry.s, contentType(path));
}

function streamFile(
  vault: Vault,
  req: Request,
  chunks: import("./types.ts").ChunkRef[],
  size: number,
  ctype: string,
): Response {
  const range = parseRange(req.headers.get("range"), size);

  const baseHeaders: Record<string, string> = {
    "Content-Type": ctype,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    // Vault contents are untrusted: forbid MIME sniffing so the browser honors
    // the declared Content-Type and can't upgrade e.g. a .txt holding <script>
    // into text/html and execute it in maia's (cookie-bearing) origin.
    "X-Content-Type-Options": "nosniff",
  };
  // Anything we don't render inline is forced to download, so a hostile file
  // can never execute as active content in the origin.
  if (ctype === "application/octet-stream") {
    baseHeaders["Content-Disposition"] = "attachment";
  }

  if (range.kind === "unsatisfiable") {
    return new Response("Range Not Satisfiable\n", {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  const start = range.kind === "partial" ? range.start : 0;
  const end = range.kind === "partial" ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  const status = range.kind === "partial" ? 206 : 200;
  const headers = new Headers(baseHeaders);
  headers.set("Content-Length", String(length));
  if (range.kind === "partial") {
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }

  // HEAD or empty body: no stream needed.
  if (req.method === "HEAD" || size === 0) {
    return new Response(null, { status, headers });
  }

  return new Response(rangeStream(vault, chunks, start, end), { status, headers });
}

// ---- response helpers ----

function wantsJson(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

function text(status: number, body: string): Response {
  return new Response(body + "\n", {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Our HTML uses one tiny inline <script> (the copy-URL button) and inline
      // CSS; allow those but nothing external. No object/base; restrict to self.
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
