import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  preferencePath,
  loadPreferences,
  savePreferences,
} from "../dist/preferences.js";
import { identifyWorkspace } from "../dist/workspaces.js";
const home = mkdtempSync(path.join(tmpdir(), "ab-prefs-home-"));
const previous = process.env.XDG_CONFIG_HOME;
before(() => {
  process.env.XDG_CONFIG_HOME = home;
});
after(() => {
  if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previous;
});
function workspace() {
  return mkdtempSync(path.join(tmpdir(), "ab-prefs-ws-"));
}
function prefs(ws, overrides = {}) {
  return {
    version: 1,
    workspaceIdentity: identifyWorkspace(ws),
    useManagedDefaults: false,
    agents: { demo: { sessionConfig: { mode: "bypass" } } },
    ...overrides,
  };
}
test("preferences save and load atomically under the user config directory", () => {
  const ws = workspace();
  const file = preferencePath(ws);
  assert.match(file, /agent-bridge[\\/]workspaces[\\/][a-f0-9]{64}\.yaml$/);
  savePreferences(ws, prefs(ws));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const loaded = loadPreferences(ws);
  assert.equal(loaded.useManagedDefaults, false);
  assert.equal(loaded.agents.demo.sessionConfig.mode, "bypass");
  assert.equal(
    loaded.workspaceIdentity.canonicalPath,
    identifyWorkspace(ws).canonicalPath,
  );
  const unknown = workspace();
  assert.equal(loadPreferences(unknown), undefined);
});
test("identity mismatch, unsupported fields and corrupt files fail closed with the original preserved", () => {
  const ws = workspace();
  savePreferences(ws, prefs(ws));
  const file = preferencePath(ws);
  const other = workspace();
  const foreign = readFileSync(file, "utf8");
  mkdirSync(path.dirname(preferencePath(other)), { recursive: true });
  writeFileSync(preferencePath(other), foreign, { mode: 0o600 });
  chmodSync(preferencePath(other), 0o600);
  assert.throws(() => loadPreferences(other), /different directory identity/);
  for (const body of [
    '{"version":1',
    "version: 2\nworkspaceIdentity: {}\n",
    "version: 1\nworkspaceIdentity: {canonicalPath: /a, device: '1', inode: '1'}\nagents: {demo: {sessionConfig: {m: 'x'}}, extra: 1}\nunexpected: true\n",
  ]) {
    writeFileSync(file, body);
    assert.throws(() => loadPreferences(ws), /preserved|belong/);
    assert.equal(readFileSync(file, "utf8"), body);
  }
  writeFileSync(file, `version: 1\n# ${"x".repeat(70000)}\n`);
  assert.throws(() => loadPreferences(ws), /exceed|preserved/);
});
test("symlinked leaf or ancestors are rejected on load and save", () => {
  const ws = workspace();
  savePreferences(ws, prefs(ws));
  const file = preferencePath(ws);
  const target = path.join(home, "elsewhere.yaml");
  writeFileSync(target, "version: 1\n");
  rmSync(file);
  symlinkSync(target, file);
  assert.throws(() => loadPreferences(ws), /symlink|regular file/);
  assert.throws(() => savePreferences(ws, prefs(ws)), /symlink/);
  rmSync(file);
  const ws2 = workspace();
  const dir = path.dirname(preferencePath(ws2));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  const real = path.join(home, "real-workspaces");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, dir);
  assert.throws(() => savePreferences(ws2, prefs(ws2)), /symlink/);
  rmSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
});
test("insecure directories and leaves are rejected", () => {
  const ws = workspace();
  const file = preferencePath(ws);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, "version: 1\n", { mode: 0o600 });
  chmodSync(file, 0o644);
  assert.throws(() => loadPreferences(ws), /Unsafe|group\/other/);
  chmodSync(file, 0o600);
  chmodSync(dir, 0o755);
  assert.throws(() => loadPreferences(ws), /Unsafe|group\/other/);
  assert.throws(() => savePreferences(ws, prefs(ws)), /Unsafe|group\/other/);
  chmodSync(dir, 0o700);
  chmodSync(path.dirname(dir), 0o755);
  assert.throws(() => savePreferences(ws, prefs(ws)), /Unsafe|group\/other/);
  chmodSync(path.dirname(dir), 0o700);
  savePreferences(ws, prefs(ws));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
test("a symlinked config home is rejected on load and save", () => {
  const ws = workspace();
  const real = mkdtempSync(path.join(tmpdir(), "ab-prefs-realhome-"));
  const link = path.join(
    tmpdir(),
    `ab-prefs-linkhome-${process.pid}-${Date.now()}`,
  );
  symlinkSync(real, link);
  process.env.XDG_CONFIG_HOME = link;
  try {
    const file = preferencePath(ws);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, "version: 1\n", { mode: 0o600 });
    assert.throws(() => loadPreferences(ws), /symlink/);
    assert.throws(() => savePreferences(ws, prefs(ws)), /symlink/);
  } finally {
    process.env.XDG_CONFIG_HOME = home;
    rmSync(real, { recursive: true, force: true });
    rmSync(link, { force: true });
  }
});
test("a failed save cleans up its temporary file", () => {
  const ws = workspace();
  savePreferences(ws, prefs(ws));
  const file = preferencePath(ws);
  const dir = path.dirname(file);
  rmSync(file);
  mkdirSync(file);
  writeFileSync(path.join(file, "occupant"), "x");
  assert.throws(() => savePreferences(ws, prefs(ws)));
  assert.equal(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")).length,
    0,
  );
});
test("save over an insecure or non-regular leaf rejects and preserves it", () => {
  const ws = workspace();
  savePreferences(ws, prefs(ws));
  const file = preferencePath(ws);
  chmodSync(file, 0o644);
  const bytes = readFileSync(file, "utf8");
  assert.throws(() => savePreferences(ws, prefs(ws)), /Unsafe|group\/other/);
  assert.equal(readFileSync(file, "utf8"), bytes);
  assert.equal(
    statSync(file).mode & 0o777,
    0o644,
    "the original leaf is preserved untouched",
  );
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => savePreferences(ws, prefs(ws)), /regular file/);
  assert.ok(statSync(file).isDirectory());
});
test("repeated saves replace the file atomically and keep it private", () => {
  const ws = workspace();
  savePreferences(ws, prefs(ws));
  savePreferences(ws, prefs(ws, { useManagedDefaults: true }));
  const file = preferencePath(ws);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadPreferences(ws).useManagedDefaults, true);
});
test("save writes private files and rejects mismatched records", () => {
  const ws = workspace();
  const other = workspace();
  assert.throws(
    () => savePreferences(ws, prefs(other)),
    /identity does not match/,
  );
  assert.equal(existsSync(preferencePath(ws)), false);
  const bad = prefs(ws);
  bad.agents["../escape"] = { sessionConfig: {} };
  assert.throws(
    () => savePreferences(ws, bad),
    /invalid workspace preferences/i,
  );
});
