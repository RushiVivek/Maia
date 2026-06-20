import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildMockVault } from "./fixture/mkvault.ts";
import { Vault } from "../src/vault.ts";
import { buildHandlerWithVault } from "../src/server.ts";

const TOKEN = "test-token-0123456789abcdef";

const bigFile = new Uint8Array(300);
for (let i = 0; i < bigFile.length; i++) bigFile[i] = i % 256;

function makeHandler() {
  const built = buildMockVault("v", [{
    id: "snapaaaa",
    name: "shots",
    files: [
      { path: "photos/cat.jpg", bytes: new TextEncoder().encode("JPEGDATA"), chunkSize: 4 },
      { path: "videos/clip.mp4", bytes: bigFile, chunkSize: 32 },
      { path: "notes.txt", bytes: new TextEncoder().encode("hello world"), chunkSize: 5 },
    ],
    manifestChunkSize: 50,
  }]);
  return buildHandlerWithVault(TOKEN, new Vault(built.client));
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://maia.test${path}`, { headers });
}

async function call(h: Deno.ServeHandler, req: Request): Promise<Response> {
  // deno-lint-ignore no-explicit-any
  return await (h as any)(req, { remoteAddr: { hostname: "127.0.0.1" } });
}

const auth = { authorization: `Bearer ${TOKEN}` };

Deno.test("every endpoint refuses access without the token", async () => {
  const h = makeHandler();
  for (const p of ["/", "/snapaaaa/", "/snapaaaa/notes.txt", "/snapaaaa/photos/"]) {
    assertEquals((await call(h, get(p))).status, 401, p);
  }
});

Deno.test("GET / lists snapshots (HTML and JSON)", async () => {
  const h = makeHandler();
  const htmlRes = await call(h, get("/", auth));
  assertEquals(htmlRes.status, 200);
  assertStringIncludes(await htmlRes.text(), "shots");

  const jsonRes = await call(h, get("/", { ...auth, accept: "application/json" }));
  const data = await jsonRes.json() as Array<{ id: string }>;
  assertEquals(data[0]!.id, "snapaaaa");
});

Deno.test("directory listing groups by prefix", async () => {
  const h = makeHandler();
  const res = await call(h, get("/snapaaaa/", { ...auth, accept: "application/json" }));
  const data = await res.json() as { children: Array<{ name: string; isDir: boolean }> };
  const names = data.children.map((c) => `${c.name}${c.isDir ? "/" : ""}`).sort();
  assertEquals(names, ["notes.txt", "photos/", "videos/"]);
});

Deno.test("file download returns full bytes with correct type + nosniff", async () => {
  const h = makeHandler();
  const res = await call(h, get("/snapaaaa/notes.txt", auth));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(res.headers.get("accept-ranges"), "bytes");
  assertEquals(res.headers.get("content-length"), "11");
  // Untrusted vault content must never be sniffed into executable HTML.
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(await res.text(), "hello world");
});

Deno.test("octet-stream (unknown ext) is forced to download", async () => {
  const built = buildMockVault("v", [{
    id: "snapbbbb",
    name: "s",
    files: [{
      path: "thing.bin",
      bytes: new TextEncoder().encode("<script>x</script>"),
      chunkSize: 8,
    }],
  }]);
  const h = buildHandlerWithVault(TOKEN, new Vault(built.client));
  const res = await call(h, get("/snapbbbb/thing.bin", auth));
  assertEquals(res.headers.get("content-type"), "application/octet-stream");
  assertEquals(res.headers.get("content-disposition"), "attachment");
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  await res.body?.cancel();
});

Deno.test("HTML pages carry nosniff and a restrictive CSP", async () => {
  const h = makeHandler();
  const res = await call(h, get("/", auth));
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertStringIncludes(res.headers.get("content-security-policy") ?? "", "default-src 'none'");
  await res.body?.cancel();
});

Deno.test("Range request returns 206 with correct slice", async () => {
  const h = makeHandler();
  const res = await call(h, get("/snapaaaa/videos/clip.mp4", { ...auth, range: "bytes=40-99" }));
  assertEquals(res.status, 206);
  assertEquals(res.headers.get("content-range"), "bytes 40-99/300");
  assertEquals(res.headers.get("content-length"), "60");
  assertEquals(res.headers.get("content-type"), "video/mp4");
  const body = new Uint8Array(await res.arrayBuffer());
  assertEquals(body, bigFile.slice(40, 100));
});

Deno.test("unsatisfiable range -> 416", async () => {
  const h = makeHandler();
  const res = await call(h, get("/snapaaaa/notes.txt", { ...auth, range: "bytes=999-" }));
  assertEquals(res.status, 416);
  assertEquals(res.headers.get("content-range"), "bytes */11");
  await res.body?.cancel();
});

Deno.test("HEAD returns headers without body", async () => {
  const h = makeHandler();
  const res = await call(
    h,
    new Request("http://maia.test/snapaaaa/notes.txt", {
      method: "HEAD",
      headers: auth,
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-length"), "11");
  assertEquals(await res.text(), "");
});

Deno.test("directory path without trailing slash redirects (308) with no-store", async () => {
  const h = makeHandler();
  const res = await call(h, get("/snapaaaa/photos", auth));
  assertEquals(res.status, 308);
  assertEquals(res.headers.get("location"), "/snapaaaa/photos/");
  // The Location may carry ?token=, so the redirect must not be cached.
  assertEquals(res.headers.get("cache-control"), "no-store");
  await res.body?.cancel();
});

Deno.test("missing file -> 404, missing snapshot -> 404", async () => {
  const h = makeHandler();
  assertEquals((await call(h, get("/snapaaaa/nope.txt", auth))).status, 404);
  assertEquals((await call(h, get("/doesnotexist/", auth))).status, 404);
});

Deno.test("malformed percent-escape in path -> 404, not 500", async () => {
  const h = makeHandler();
  // %zz / lone % are invalid escapes; decodeURIComponent would throw URIError.
  for (const p of ["/snapaaaa/%zz", "/snapaaaa/foo/%", "/%zz/"]) {
    const res = await call(h, get(p, auth));
    assertEquals(res.status, 404, p);
    await res.body?.cancel();
  }
});

Deno.test("query-token auth sets a cookie on a 2xx response", async () => {
  const h = makeHandler();
  const res = await call(h, get(`/?token=${TOKEN}`));
  assertEquals(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assertStringIncludes(setCookie, "maia_token=");
  assertStringIncludes(setCookie, "HttpOnly");
  assertStringIncludes(setCookie, "Secure");
  assertStringIncludes(setCookie, "SameSite=Strict");
  await res.body?.cancel();
});

Deno.test("cookie is NOT set on a 401 (wrong query token)", async () => {
  const h = makeHandler();
  const res = await call(h, get(`/?token=wrong-token-totally-invalid`));
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("set-cookie"), null);
  await res.body?.cancel();
});

Deno.test("cookie is NOT set on a redirect (308) even with valid query token", async () => {
  const h = makeHandler();
  // `photos` (no trailing slash) is a directory -> 308 redirect.
  const res = await call(h, get(`/snapaaaa/photos?token=${TOKEN}`));
  assertEquals(res.status, 308);
  assertEquals(res.headers.get("set-cookie"), null);
  await res.body?.cancel();
});

Deno.test("cookie is NOT set on a 404 even with valid query token", async () => {
  const h = makeHandler();
  const res = await call(h, get(`/snapaaaa/nope.txt?token=${TOKEN}`));
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("set-cookie"), null);
  await res.body?.cancel();
});

Deno.test("a malformed cookie yields 401 (not an unauthenticated 500)", async () => {
  const h = makeHandler();
  const res = await call(h, get("/", { cookie: "maia_token=%zz" }));
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("a malformed cookie does not block a valid ?token=", async () => {
  const h = makeHandler();
  const res = await call(h, get(`/?token=${TOKEN}`, { cookie: "maia_token=%zz" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("a stale cookie does not block a valid ?token=, and the cookie is refreshed", async () => {
  const h = makeHandler();
  const res = await call(
    h,
    get(`/?token=${TOKEN}`, { cookie: "maia_token=STALE-WRONG-VALUE" }),
  );
  assertEquals(res.status, 200); // valid query token wins over the stale cookie
  assertStringIncludes(res.headers.get("set-cookie") ?? "", "maia_token="); // refreshed
  await res.body?.cancel();
});
