import { assertEquals } from "@std/assert";
import { contentType, isVideo } from "../src/mime.ts";

Deno.test("known types map to inline-renderable content types", () => {
  assertEquals(contentType("a/b/photo.JPG"), "image/jpeg");
  assertEquals(contentType("doc.pdf"), "application/pdf");
  assertEquals(contentType("notes.txt"), "text/plain; charset=utf-8");
});

Deno.test("SVG is served as a download, not inline (active content)", () => {
  // SVG can carry <script>; it must NOT get image/svg+xml (which renders inline).
  assertEquals(contentType("logo.svg"), "application/octet-stream");
});

Deno.test("unknown / extensionless -> octet-stream", () => {
  assertEquals(contentType("README"), "application/octet-stream");
  assertEquals(contentType("archive.xyz"), "application/octet-stream");
});

Deno.test("isVideo detects video extensions", () => {
  assertEquals(isVideo("clip.mp4"), true);
  assertEquals(isVideo("movie.MKV"), true);
  assertEquals(isVideo("photo.jpg"), false);
});
