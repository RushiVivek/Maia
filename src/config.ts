/**
 * Configuration, parsed and validated from environment variables at startup.
 * Fails fast with a clear message if a required secret is missing.
 */

export interface Config {
  owner: string;
  repo: string;
  vaultId: string;
  /** Read-only fine-grained PAT. Server-side only — never sent to the browser. */
  githubToken: string;
  /** Bearer token clients must present on every request. */
  authToken: string;
  port: number;
}

const REQUIRED = [
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "ATLAS_VAULT_ID",
  "GITHUB_TOKEN",
  "AUTH_TOKEN",
] as const;

/**
 * Read config from the environment. Throws if any required var is missing or
 * empty, listing all of them at once so the operator fixes it in one pass.
 */
export function loadConfig(env: { get(key: string): string | undefined } = Deno.env): Config {
  const missing: string[] = [];
  const get = (key: string): string => {
    const v = env.get(key)?.trim();
    if (!v) missing.push(key);
    return v ?? "";
  };

  const owner = get("GITHUB_OWNER");
  const repo = get("GITHUB_REPO");
  const vaultId = get("ATLAS_VAULT_ID");
  const githubToken = get("GITHUB_TOKEN");
  const authToken = get("AUTH_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Required: ${REQUIRED.join(", ")}.`,
    );
  }

  // A short AUTH_TOKEN defeats the only gate in front of the vault. Refuse it.
  if (authToken.length < 16) {
    throw new Error("AUTH_TOKEN must be at least 16 characters (use e.g. `openssl rand -hex 32`).");
  }

  const portRaw = env.get("PORT")?.trim();
  const port = portRaw ? Number(portRaw) : 8000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer in 1..65535, got ${portRaw}`);
  }

  return { owner, repo, vaultId, githubToken, authToken, port };
}
