import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  linkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../dist/store.js";
const taskId = "task_00000000-0000-0000-0000-000000000000";
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-artifacts-"));
  return { dir, store: new Store(dir, 10000) };
}
test("artifact reads and appends reject symlinked task directories", () => {
  const { dir, store } = fixture();
  store.append(taskId, "output.txt", "original");
  const target = path.join(dir, "other");
  mkdirSync(target);
  writeFileSync(path.join(target, "output.txt"), "KEEP_PRIVATE");
  const taskDir = path.dirname(store.artifactPath(taskId, "output.txt"));
  renameSync(taskDir, taskDir + "-retained");
  symlinkSync(target, taskDir);
  assert.throws(
    () => store.readArtifact(taskId, "output.txt", 0, 100),
    /Unsafe artifact directory/,
  );
  assert.throws(
    () => store.append(taskId, "output.txt", "CHANGED"),
    /Unsafe artifact directory/,
  );
  assert.equal(
    readFileSync(path.join(target, "output.txt"), "utf8"),
    "KEEP_PRIVATE",
  );
});
test("artifact I/O rejects hard-linked files and replacement artifact roots", () => {
  const { dir, store } = fixture();
  const file = store.artifactPath(taskId, "output.txt");
  const victim = path.join(dir, "victim");
  writeFileSync(victim, "KEEP_PRIVATE");
  linkSync(victim, file);
  assert.throws(
    () => store.readArtifact(taskId, "output.txt", 0, 100),
    /Unsafe artifact file/,
  );
  assert.throws(
    () => store.append(taskId, "output.txt", "CHANGED"),
    /Unsafe artifact file/,
  );
  assert.equal(readFileSync(victim, "utf8"), "KEEP_PRIVATE");
  const root = store.artifactRoot;
  renameSync(root, root + "-retained");
  symlinkSync(root + "-retained", root);
  assert.throws(
    () => store.artifactPath(taskId, "output.txt"),
    /Unsafe artifact directory/,
  );
});
test("descriptor-based artifact I/O preserves append, pagination and byte budgets", () => {
  const { store } = fixture();
  store.append(taskId, "output.txt", "first\n");
  store.append(taskId, "output.txt", "second");
  assert.equal(store.readArtifactText(taskId, "output.txt"), "first\nsecond");
  const page = store.readArtifact(taskId, "output.txt", 0, 6);
  assert.equal(page.text, "first\n");
  assert.equal(page.nextOffset, 6);
  assert.equal(page.eof, false);
  assert.equal(store.readArtifact(taskId, "output.txt", 6, 100).text, "second");
  assert.throws(
    () => store.append(taskId, "output.txt", "x".repeat(10000)),
    /budget exceeded/,
  );
  assert.equal(store.readArtifactText(taskId, "output.txt"), "first\nsecond");
});
