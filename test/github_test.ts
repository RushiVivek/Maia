import { assert, assertEquals } from "@std/assert";
import { createGithubClient } from "../src/github.ts";

const PAT = "ghp_supersecret_pat_value";

interface Captured {
  url: string;
  headers: Headers;
}

/** Install a fake global fetch; returns captured requests + a restore fn. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): {
  calls: Captured[];
  restore: () => void;
} {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, headers: new Headers(init?.headers) });
    return Promise.resolve(handler(url, init));
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

Deno.test("downloadAsset does NOT forward Authorization to the signed redirect URL", async () => {
  const SIGNED = "https://objects.example.com/signed-blob?sig=abc";
  const PAYLOAD = new Uint8Array([1, 2, 3, 4, 5]);

  const { calls, restore } = stubFetch((url) => {
    if (url.startsWith("https://api.github.com/")) {
      // GitHub redirects asset downloads to a signed object-store URL.
      return new Response(null, { status: 302, headers: { location: SIGNED } });
    }
    if (url === SIGNED) {
      return new Response(PAYLOAD, { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });

  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    const bytes = await client.downloadAsset(42);
    assertEquals(bytes, PAYLOAD);

    assertEquals(calls.length, 2);
    // 1st call hits api.github.com WITH the PAT.
    const api = calls[0]!;
    assert(api.url.startsWith("https://api.github.com/"));
    assertEquals(api.headers.get("authorization"), `Bearer ${PAT}`);
    // 2nd call hits the signed store and must NOT carry the PAT.
    const signed = calls[1]!;
    assertEquals(signed.url, SIGNED);
    assertEquals(signed.headers.get("authorization"), null);
  } finally {
    restore();
  }
});

Deno.test("downloadAsset returns inline body when there is no redirect", async () => {
  const PAYLOAD = new Uint8Array([9, 8, 7]);
  const { restore } = stubFetch(() => new Response(PAYLOAD, { status: 200 }));
  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    assertEquals(await client.downloadAsset(1), PAYLOAD);
  } finally {
    restore();
  }
});

Deno.test("getRootBody returns null on a 404 ROOT tag", async () => {
  const { restore } = stubFetch(() => new Response("not found", { status: 404 }));
  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    assertEquals(await client.getRootBody(), null);
  } finally {
    restore();
  }
});
