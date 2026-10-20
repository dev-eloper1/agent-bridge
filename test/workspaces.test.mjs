import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  renameSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveWorkspace,
  identifyWorkspace,
  verifyWorkspace,
} from "../dist/workspaces.js";

test("outside absolute paths, parent traversal and initial symlink aliases are intentional directory selections", () => {
  const base = realpathSync(
    mkdtempSync(path.join(tmpdir(), "ab-path-policy-")),
  );
  const root = path.join(base, "project"),
    other = path.join(base, "other");
  mkdirSync(root);
  mkdirSync(other);
  symlinkSync(other, path.join(root, "alias"));
  for (const selected of [other, "../other", "alias"])
    assert.deepEqual(
      resolveWorkspace({ mode: "directory", path: selected }, root),
      { mode: "directory", path: other },
    );
  symlinkSync(root, path.join(base, "project-alias"));
  assert.deepEqual(
    resolveWorkspace({ mode: "directory", path: "../project-alias" }, root),
    { mode: "project" },
  );
});

test("workspace identity rejects both a symlink redirection and a new directory at the same canonical path", () => {
  const base = realpathSync(
    mkdtempSync(path.join(tmpdir(), "ab-path-identity-")),
  );
  const original = path.join(base, "original"),
    replacement = path.join(base, "replacement");
  mkdirSync(original);
  mkdirSync(replacement);
  const identity = identifyWorkspace(original);
  assert.deepEqual(verifyWorkspace(original, identity), identity);
  renameSync(original, path.join(base, "retained"));
  symlinkSync(replacement, original);
  assert.throws(() => verifyWorkspace(original, identity), /identity changed/);
  assert.throws(() => verifyWorkspace(original), /identity changed/);
  const second = identifyWorkspace(replacement);
  renameSync(replacement, path.join(base, "retained-replacement"));
  mkdirSync(replacement);
  assert.throws(() => verifyWorkspace(replacement, second), /identity changed/);
});

test("workspace verification rejects a directory replaced with a regular file", () => {
  const base = realpathSync(
    mkdtempSync(path.join(tmpdir(), "ab-path-file-")),
  );
  const directory = path.join(base, "workspace");
  mkdirSync(directory);
  const identity = identifyWorkspace(directory);
  renameSync(directory, path.join(base, "retained"));
  writeFileSync(directory, "not a directory");
  assert.throws(
    () => verifyWorkspace(directory, identity),
    { message: "Conversation workspace missing or no longer a directory" },
  );
});
