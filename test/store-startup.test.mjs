import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../dist/store.js";
import { ensureRuntime } from "../dist/plugin.js";
import { loadConfig } from "../dist/config.js";

test("invalid or truncated state fails with a recovery diagnostic and preserves original bytes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-corrupt-"));
  const file = path.join(dir, "state.json");
  for (const contents of [
    '{"version":1',
    '{"version":1,"tasks":[],"sessions":{},"events":[]}',
    '{"version":1,"tasks":{"bad":{}},"sessions":{},"events":[]}',
  ]) {
    writeFileSync(file, contents);
    assert.throws(() => new Store(dir, 10000), /Original file preserved/);
    assert.equal(readFileSync(file, "utf8"), contents);
  }
});

test("daemon spawn errors report their cause promptly rather than an eight-second generic timeout", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-e-"));
  const c = {
    ...loadConfig(),
    root: path.join(dir, "missing-cwd"),
    stateDir: dir,
    socket: path.join(dir, "missing.sock"),
  };
  const start = performance.now();
  await assert.rejects(
    ensureRuntime(path.join(dir, "agents.yaml"), c),
    /daemon launch failed:.*ENOENT/,
  );
  assert.ok(performance.now() - start < 2000);
});
