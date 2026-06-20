import { assertEquals } from "@std/assert";
import { extractTokens, isAuthorized, tokensEqual, withAuth } from "../src/auth.ts";

const TOKEN = "s3cret-token-abcdefghijklmnop";

function req(headers: Record<string, string> = {}, url = "http://x/"): Request {
  return new Request(url, { headers });
}

Deno.test("extractTokens reads Authorization Bearer", () => {
  assertEquals(extractTokens(req({ authorization: `Bearer ${TOKEN}` })), [TOKEN]);
});

Deno.test("extractTokens reads cookie", () => {
  assertEquals(extractTokens(req({ cookie: `other=1; maia_token=${TOKEN}; x=2` })), [TOKEN]);
});

Deno.test("extractTokens reads query param", () => {
  assertEquals(extractTokens(req({}, `http://x/?token=${TOKEN}`)), [TOKEN]);
});

Deno.test("extractTokens returns ALL presented tokens (header, cookie, query)", () => {
  const r = req(
    { authorization: `Bearer HEADER`, cookie: `maia_token=COOKIE` },
    `http://x/?token=QUERY`,
  );
  assertEquals(extractTokens(r), ["HEADER", "COOKIE", "QUERY"]);
});

Deno.test("tokensEqual is correct (and length-insensitive in shape)", async () => {
  assertEquals(await tokensEqual(TOKEN, TOKEN), true);
  assertEquals(await tokensEqual(TOKEN, TOKEN + "x"), false);
  assertEquals(await tokensEqual("", ""), true);
  assertEquals(await tokensEqual("a", "b"), false);
});

Deno.test("isAuthorized accepts if ANY presented token matches", async () => {
  // A stale/wrong cookie must NOT shadow a valid ?token= (fail-open across
  // channels, since all carry the same shared secret).
  const r = req({ cookie: `maia_token=STALE-WRONG` }, `http://x/?token=${TOKEN}`);
  assertEquals(await isAuthorized(r, TOKEN), true);
});

Deno.test("a malformed cookie %-escape does not throw and does not shadow a valid token", async () => {
  // `%zz` would make decodeURIComponent throw; extractTokens must swallow it.
  const bad = req({ cookie: "maia_token=%zz" });
  assertEquals(extractTokens(bad), []); // malformed cookie skipped, not thrown
  assertEquals(await isAuthorized(bad, TOKEN), false);

  // And it must not block a valid ?token= presented alongside it.
  const withQuery = req({ cookie: "maia_token=%zz" }, `http://x/?token=${TOKEN}`);
  assertEquals(extractTokens(withQuery), [TOKEN]);
  assertEquals(await isAuthorized(withQuery, TOKEN), true);
});

Deno.test("withAuth rejects missing and wrong tokens with 401", async () => {
  const ok = withAuth(TOKEN, () => new Response("ok"));
  assertEquals((await ok(req())).status, 401);
  assertEquals((await ok(req({ authorization: "Bearer nope" }))).status, 401);
  assertEquals((await ok(req({ authorization: `Bearer ${TOKEN}` }))).status, 200);
});
