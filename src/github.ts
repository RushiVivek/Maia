/**
 * Minimal GitHub REST client for the atlas read path. Read-only.
 *
 * Auth: every api.github.com call sends `Authorization: Bearer <PAT>`. The one
 * exception is the actual asset *download*, which GitHub 302-redirects to a
 * signed object-store URL — we must NOT forward the Authorization header there
 * (the store rejects it, and forwarding would leak the PAT cross-origin).
 */

import { UpstreamError } from "./errors.ts";

const API_BASE = "https://api.github.com";
const USER_AGENT = "maia/0.1 (+https://github.com/RushiVivek/maia)";

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
}

export interface Release {
  id: number;
  tag_name: string;
}

export interface GithubClient {
  /** ROOT release body for `atlas-root-<vaultId>`, or null if the tag is absent. */
  getRootBody(): Promise<string | null>;
  /** All releases whose tag starts with `atlas-chunk-<vaultId>-`. */
  listChunkReleases(): Promise<Release[]>;
  /** All assets of a release (paginated). */
  listReleaseAssets(releaseId: number): Promise<ReleaseAsset[]>;
  /** Raw ciphertext bytes for an asset (follows the signed-URL redirect). */
  downloadAsset(assetId: number): Promise<Uint8Array>;
}

export interface GithubConfig {
  owner: string;
  repo: string;
  vaultId: string;
  token: string;
}

export function createGithubClient(cfg: GithubConfig): GithubClient {
  const { owner, repo, vaultId, token } = cfg;
  const apiHeaders: HeadersInit = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };

  async function api(path: string): Promise<Response> {
    const res = await fetch(`${API_BASE}${path}`, { headers: apiHeaders });
    return res;
  }

  async function apiJson<T>(path: string): Promise<T> {
    const res = await api(path);
    if (!res.ok) {
      const body = await safeBody(res);
      throw new UpstreamError(`GET ${path} -> ${res.status} ${res.statusText}${body}`);
    }
    return await res.json() as T;
  }

  return {
    async getRootBody(): Promise<string | null> {
      const tag = `atlas-root-${vaultId}`;
      const res = await api(`/repos/${owner}/${repo}/releases/tags/${tag}`);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        const body = await safeBody(res);
        throw new UpstreamError(`ROOT tag ${tag} -> ${res.status} ${res.statusText}${body}`);
      }
      const release = await res.json() as { body?: string | null };
      return release.body ?? "";
    },

    async listChunkReleases(): Promise<Release[]> {
      const prefix = `atlas-chunk-${vaultId}-`;
      const out: Release[] = [];
      for (let page = 1;; page++) {
        const releases = await apiJson<Release[]>(
          `/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
        );
        for (const r of releases) {
          if (r.tag_name.startsWith(prefix)) out.push({ id: r.id, tag_name: r.tag_name });
        }
        if (releases.length < 100) break;
      }
      return out;
    },

    async listReleaseAssets(releaseId: number): Promise<ReleaseAsset[]> {
      const out: ReleaseAsset[] = [];
      for (let page = 1;; page++) {
        const assets = await apiJson<ReleaseAsset[]>(
          `/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`,
        );
        for (const a of assets) out.push({ id: a.id, name: a.name, size: a.size });
        if (assets.length < 100) break;
      }
      return out;
    },

    async downloadAsset(assetId: number): Promise<Uint8Array> {
      const path = `/repos/${owner}/${repo}/releases/assets/${assetId}`;
      // Request the binary; handle the redirect manually so we can strip auth.
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { ...apiHeaders, "Accept": "application/octet-stream" },
        redirect: "manual",
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) throw new UpstreamError(`asset ${assetId} redirect missing Location`);
        // Follow to the signed store URL WITHOUT the Authorization header.
        const signed = await fetch(location, { headers: { "User-Agent": USER_AGENT } });
        if (!signed.ok) {
          const body = await safeBody(signed);
          throw new UpstreamError(`asset ${assetId} download -> ${signed.status}${body}`);
        }
        return new Uint8Array(await signed.arrayBuffer());
      }

      if (!res.ok) {
        const body = await safeBody(res);
        throw new UpstreamError(`asset ${assetId} -> ${res.status} ${res.statusText}${body}`);
      }
      // No redirect (some setups serve inline): body is the ciphertext.
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Read a short snippet of an error response body for diagnostics (never logged file content). */
async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? `: ${text.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}
