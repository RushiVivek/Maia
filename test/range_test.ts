import { assertEquals } from "@std/assert";
import { parseRange } from "../src/range.ts";

Deno.test("no header -> full", () => {
  assertEquals(parseRange(null, 100), { kind: "full" });
  assertEquals(parseRange("", 100), { kind: "full" });
});

Deno.test("bytes=A-B inclusive", () => {
  assertEquals(parseRange("bytes=10-19", 100), { kind: "partial", start: 10, end: 19 });
});

Deno.test("bytes=A- to EOF", () => {
  assertEquals(parseRange("bytes=50-", 100), { kind: "partial", start: 50, end: 99 });
});

Deno.test("bytes=-N suffix", () => {
  assertEquals(parseRange("bytes=-10", 100), { kind: "partial", start: 90, end: 99 });
  assertEquals(parseRange("bytes=-500", 100), { kind: "partial", start: 0, end: 99 });
});

Deno.test("end clamped to size-1", () => {
  assertEquals(parseRange("bytes=90-9999", 100), { kind: "partial", start: 90, end: 99 });
});

Deno.test("start past EOF -> unsatisfiable", () => {
  assertEquals(parseRange("bytes=100-200", 100), { kind: "unsatisfiable" });
  assertEquals(parseRange("bytes=100-", 100), { kind: "unsatisfiable" });
});

Deno.test("suffix on empty / zero-length -> unsatisfiable", () => {
  assertEquals(parseRange("bytes=-10", 0), { kind: "unsatisfiable" });
  assertEquals(parseRange("bytes=-0", 100), { kind: "unsatisfiable" });
});

Deno.test("end < start -> unsatisfiable", () => {
  assertEquals(parseRange("bytes=20-10", 100), { kind: "unsatisfiable" });
});

Deno.test("multi-range and junk -> full", () => {
  assertEquals(parseRange("bytes=0-1,5-6", 100), { kind: "full" });
  assertEquals(parseRange("items=0-1", 100), { kind: "full" });
  assertEquals(parseRange("bytes=abc-def", 100), { kind: "full" });
});
