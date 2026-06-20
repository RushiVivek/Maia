import { assert } from "@std/assert";

/** Non-null assertion for tests under noUncheckedIndexedAccess. */
export function nn<T>(v: T | undefined | null, msg = "expected a value"): T {
  assert(v !== undefined && v !== null, msg);
  return v;
}
