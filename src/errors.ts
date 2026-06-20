/**
 * Typed errors used across maia. Each carries the HTTP status it maps to so the
 * server's error handler can translate without a pile of `instanceof` checks.
 */

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/** 401 — missing or wrong AUTH_TOKEN. */
export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message);
  }
}

/** 404 — snapshot, path, or chunk not found. */
export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

/** 416 — Range not satisfiable. `size` is the authoritative file length. */
export class RangeNotSatisfiableError extends HttpError {
  readonly size: number;
  constructor(size: number, message = "Range not satisfiable") {
    super(416, message);
    this.size = size;
  }
}

/**
 * 502 — the vault data on GitHub is malformed or violates the atlas format
 * contract (bad ROOT marker, wrong schema, non-32-byte chunk ref, etc.).
 * maia is a faithful reader: it refuses to guess, it reports a broken vault.
 */
export class BadVaultError extends HttpError {
  constructor(message: string) {
    super(502, `Bad vault: ${message}`);
  }
}

/** 502 — an upstream GitHub API call failed unexpectedly. */
export class UpstreamError extends HttpError {
  constructor(message: string) {
    super(502, `Upstream error: ${message}`);
  }
}
