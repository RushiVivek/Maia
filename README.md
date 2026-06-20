# maia

A read-only, no-upload web client that streams files out of an [atlas](../atlas) encrypted backup
vault stored in **GitHub Releases** — so you can browse and stream the vault (photos and PDFs
inline, video out to VLC) from your phone, with **no connection to the machine that created the
vault**.

maia reimplements only atlas's **read path** against the GitHub-Releases storage backend. It targets
**snapshot-mode** vaults. Reads are gated solely by GitHub repo access — no vault secret or
passphrase is needed to decrypt, because each chunk's key lives in the (itself-encrypted) manifest.
Personal use only.

## How it works

1. Fetches the ROOT release (`atlas-root-<vault_id>`), whose body is the plaintext snapshot index.
2. For a chosen snapshot, fetches + decrypts the manifest chunks, giving the file tree and, per
   file, an ordered list of `(chunk_id, key)` chunk refs.
3. Streams a file by fetching each chunk asset, decrypting it (ChaCha20-Poly1305, fixed nonce), and
   concatenating — honoring HTTP `Range` so video seeking and inline rendering work.

All crypto/format parameters are matched byte-for-byte to atlas. The one subtle point: the ROOT
manifest _pointer_ encodes `(chunk_id, key)` as **hex**, but a manifest entry's `c` field encodes
them as **raw 32-byte msgpack bin** — maia keeps these as distinct types so they can't be confused.

## Run locally

Requires [Deno](https://deno.com) 2.x.

```sh
cp .env.example .env      # fill in the values (see below)
deno task dev             # watches + reloads, reads .env
# open http://localhost:8000/?token=<AUTH_TOKEN>
```

Other tasks: `deno task test`, `deno task check`, `deno task fmt`, `deno task lint`.

## Configuration (environment variables)

| Var              | What                                                          |
| ---------------- | ------------------------------------------------------------- |
| `GITHUB_OWNER`   | Owner of the vault repo (the **primary** repo if mirrored).   |
| `GITHUB_REPO`    | The vault repo name.                                          |
| `ATLAS_VAULT_ID` | The `<vault_id>` from the atlas release tags.                 |
| `GITHUB_TOKEN`   | **Read-only** fine-grained PAT scoped to just the vault repo. |
| `AUTH_TOKEN`     | Bearer token clients must present (≥16 chars).                |
| `PORT`           | Optional local listen port (default 8000).                    |

Generate `AUTH_TOKEN` with e.g. `openssl rand -hex 32`.

## Auth

Every endpoint is gated. A client may present `AUTH_TOKEN` three ways (preferred first):

1. `Authorization: Bearer <token>` — for curl/VLC.
2. `Cookie: maia_token=<token>` — set automatically the first time you open `/?token=<token>` in a
   browser, so later navigations and inline image/PDF loads work without the token in every URL.
3. `?token=<token>` — a single pasteable URL. The **copy URL** button next to a video produces
   exactly this so you can paste it into VLC.

> The URL + token _is_ the vault in plaintext. The `GITHUB_TOKEN` is server-side only and never
> reaches the browser. Keep your `AUTH_TOKEN` private; HTTPS is mandatory (Deno Deploy provides it).

## Deploy (Deno Deploy)

No container. `main.ts` is the entrypoint.

- Push this repo to GitHub and link it in the [Deno Deploy](https://deno.com/deploy) dashboard
  (auto-deploy on push), or `deployctl deploy --project=maia --entrypoint=main.ts`.
- Set `GITHUB_OWNER`, `GITHUB_REPO`, `ATLAS_VAULT_ID`, `GITHUB_TOKEN`, `AUTH_TOKEN` as project
  environment variables (encrypted at rest).
- You get HTTPS and a stable `*.deno.dev` URL.

**Memory:** ChaCha20-Poly1305 is one-shot, so peak RAM is ~2× a single chunk. With atlas's
small-chunk override (~20 MB) this is ~40 MB — comfortably under the Deno Deploy isolate limit. If a
vault uses very large chunks, host on an always-on VM instead (e.g. Oracle Always-Free) behind Caddy
for HTTPS — no code change needed.

**Cold starts:** the chunk-index map (chunk_id → asset id) is rebuilt on the first request after an
isolate is evicted, so the first tap after idle is slower, then warm.

## Tests

```sh
deno task test                 # offline: builds a byte-exact mock vault
```

End-to-end against a real vault (read-only, manual):

```sh
MAIA_E2E=1 GITHUB_OWNER=... GITHUB_REPO=... ATLAS_VAULT_ID=... GITHUB_TOKEN=... \
  deno test --allow-net --allow-env test/e2e_test.ts
```
