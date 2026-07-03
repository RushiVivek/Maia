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

No container. `main.ts` is the entrypoint. Repo: `github.com/RushiVivek/Maia` (private).

**One-time setup:**

1. [Deno Deploy dashboard](https://dash.deno.com) → **New Project** → link `RushiVivek/Maia`,
   entrypoint `main.ts`, install `main` branch (auto-deploy on push). Or CLI:
   `deployctl deploy --project=maia --entrypoint=main.ts`.
2. Project → **Settings → Environment Variables**, add all five (encrypted at rest):
   - `GITHUB_OWNER` — the vault repo owner (e.g. `atlas-git-storage`)
   - `GITHUB_REPO` — the vault repo (e.g. `Test`)
   - `ATLAS_VAULT_ID` — the atlas vault id (e.g. `maiatest`)
   - `GITHUB_TOKEN` — a **fresh, read-only, fine-grained PAT** scoped to just the vault repo
     (Contents: Read-only). Do NOT reuse a PAT that was ever pasted into a shell/chat.
   - `AUTH_TOKEN` — `openssl rand -hex 32`
3. You now have HTTPS at `https://<project>.deno.dev`. Open
   `https://<project>.deno.dev/?token=<AUTH_TOKEN>` once to set the auth cookie.

**Custom domain (`maia.rushivivek.com`):**

1. Deno Deploy → project → **Settings → Domains → Add `maia.rushivivek.com`**. It shows the DNS
   records to create (an `A`/`CNAME` for the host + a `CNAME`/`TXT` for ACME cert validation).
2. In **Cloudflare** (rushivivek.com DNS) → **DNS → Records**, add those records. Set the maia
   record to **DNS only (grey cloud), NOT Proxied** — Cloudflare's proxy breaks Deno Deploy's ACME
   challenge and TLS. Deno Deploy terminates HTTPS itself.
3. Back in Deno Deploy → Domains → **Verify / provision certificate**. Once green,
   `https://maia.rushivivek.com/?token=<AUTH_TOKEN>` works (cert auto-renews).

**Acceptance test (from the phone, after deploy):** open the `?token=` URL → (1) the snapshot
listing matches the vault, (2) a small file downloads byte-identical, (3) an image/PDF renders
inline, (4) a video's "copy URL" pastes into VLC and seeks, (5) any endpoint returns 401 without the
token.

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

End-to-end against a real vault (read-only, manual — hits GitHub, needs the PAT):

```sh
MAIA_E2E=1 GITHUB_OWNER=... GITHUB_REPO=... ATLAS_VAULT_ID=... GITHUB_TOKEN=... \
  deno test --allow-net --allow-env test/e2e_test.ts
```

## Maintenance (solo)

Before every commit: `deno task check && deno task lint && deno task fmt && deno task test`. CI
(`.github/workflows/ci.yml`) runs the same on push/PR, so a red check = don't deploy. Deno Deploy
auto-deploys `main`, so **only push what passes locally.**

**Rotating a secret** (PAT compromised, or changing `AUTH_TOKEN`): update the value in Deno Deploy →
Environment Variables and redeploy (or just save — it triggers a new isolate). Old `AUTH_TOKEN`
cookies/URLs stop working immediately; re-open the `?token=` URL to re-bootstrap.

**Load-bearing invariants — do NOT change these without re-verifying against atlas**
(`~/Scripts/atlas`):

- `src/crypto.ts`: ChaCha20-Poly1305, nonce = 12 zero bytes, no AAD, asset = ciphertext‖16-byte tag,
  `chunk_id = blake3(asset)` lowercase hex. Any drift = decryption fails.
- `src/rootdoc.ts` / `src/manifest.ts`: the ROOT manifest **pointer** carries `[cid_hex, key_hex]`
  (HEX); manifest entry `c` carries raw 32-byte msgpack-bin `[cid, key]` (NOT hex). This
  hex-vs-bytes split is the classic trap — `manifest.ts` asserts 32-byte length to catch a mix-up.
- `src/auth.ts` / `src/server.ts`: the whole router is wrapped once in `withAuth`; token compare is
  constant-time; the read-only PAT is server-side only and is stripped before the signed-asset
  redirect in `src/github.ts`. Every response sends `nosniff`; HTML sends a restrictive CSP.
- If you add a route, it's auto-gated (single wrap point) — but any new HTML must HTML-escape all
  vault-derived strings (`src/views/escape.ts`) since vault contents are untrusted.

**Common safe edits:** add a MIME type in `src/mime.ts` (keep active-content types like
`.svg`/`.html` OUT of the map so they download rather than render); tweak the HTML/CSS in
`src/views/`; adjust the chunk-index rebuild cooldown (`REBUILD_COOLDOWN_MS` in `src/chunkindex.ts`)
or ROOT TTL (`ROOT_TTL_MS` in `src/vault.ts`). Add a test for anything you change.

**If a vault uses chunks too large for the 512 MB isolate:** no code change — host `main.ts` on an
always-on VM (`deno task start`) behind Caddy for HTTPS instead of Deno Deploy.
