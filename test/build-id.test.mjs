import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { computeBuildId } from "../dist/build-id.js";
function fixture(overrides = {}) {
  const files = new Map();
  return (file) => {
    const base = path.basename(file);
    if (base === "package.json")
      return JSON.stringify({ name: "agent-bridge", version: "0.5.2" });
    if (/\.js$/.test(base)) return overrides[base] ?? `content of ${base}`;
    files.set(base, true);
    throw new Error(`ENOENT: ${file}`);
  };
}
test("computeBuildId is deterministic for identical content and order", () => {
  assert.equal(computeBuildId(fixture()), computeBuildId(fixture()));
});
test("computeBuildId changes when any required module changes", () => {
  const base = computeBuildId(fixture());
  assert.notEqual(
    computeBuildId(fixture({ "runtime.js": "changed content" })),
    base,
    "module content changes the id",
  );
  assert.notEqual(
    computeBuildId((file) =>
      path.basename(file) === "package.json"
        ? JSON.stringify({ name: "agent-bridge", version: "9.9.9" })
        : fixture()(file),
    ),
    base,
    "package version changes the id",
  );
});
test("computeBuildId fails with an actionable error when files are unreadable", () => {
  assert.throws(
    () =>
      computeBuildId(() => {
        throw new Error("ENOENT: gone");
      }),
    /build files are unreadable|npm run build/i,
  );
});
