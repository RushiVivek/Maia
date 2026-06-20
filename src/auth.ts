/**
 * Auth gate. The entire router is wrapped once in `withAuth`, so no route can
 * be added that bypasses it. The client's token (AUTH_TOKEN) is accepted, in
 * order of preference:
 *   1. `Authorization: Bearer <token>`  (curl, VLC custom headers)
 *   2. `Cookie: maia_token=<token>`     (set once via `/?token=...`; lets plain
 *                                        <img>/<a> navigations work tokenless)
 *   3. `?token=<token>`                 (single pasteable URL for VLC)
 *
 * Comparison is constant-time. The PAT is never involved here and never leaves
 * the server — only the client's own AUTH_TOKEN is checked.
 */

import { timingSafeEqual } from "@std/crypto/timing-safe-equal";

const COOKIE_NAME = "maia_token";

export type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Collect every token the request presents, across all three channels. We
 * return ALL of them (not first-found) so that a stale `maia_token` cookie
 * can't shadow a fresh, valid `?token=` link after an AUTH_TOKEN rotation —
 * auth succeeds if ANY presented credential matches. They all carry the same
 * shared secret, so accepting any is no weaker than accepting one.
 */
export function extractTokens(req: Request): string[] {
  const tokens: string[] = [];

  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) tokens.push(m[1]!);
  }

  const cookie = req.headers.get("cookie");
  if (cookie) {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === COOKIE_NAME) {
        // A malformed %-escape makes decodeURIComponent throw URIError. This
        // runs inside the auth gate (before the router's try/catch), so an
        // unguarded throw would turn a junk cookie into an unauthenticated 500
        // — and would shadow a valid ?token=/Bearer also on the request. Skip a
        // malformed cookie instead, treating it as simply not-presented.
        try {
          tokens.push(decodeURIComponent(part.slice(eq + 1).trim()));
        } catch { /* ignore malformed cookie value */ }
      }
    }
  }

  const qp = new URL(req.url).searchParams.get("token");
  if (qp) tokens.push(qp);

  return tokens;
}

/**
 * Constant-time token equality. We SHA-256 both inputs to fixed 32-byte digests
 * first: this equalizes lengths (so timingSafeEqual is happy and no length
 * oracle leaks) while a digest mismatch still implies a token mismatch.
 */
export async function tokensEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(da), new Uint8Array(db));
}

/** True if any presented token matches authToken (each checked constant-time). */
export async function isAuthorized(req: Request, authToken: string): Promise<boolean> {
  for (const t of extractTokens(req)) {
    if (await tokensEqual(t, authToken)) return true;
  }
  return false;
}

export function withAuth(authToken: string, handler: Handler): Handler {
  return async (req: Request) => {
    if (!(await isAuthorized(req, authToken))) {
      return new Response("Unauthorized\n", {
        status: 401,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return handler(req);
  };
}

export { COOKIE_NAME };
