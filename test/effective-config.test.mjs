import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { stringify, parse } from "yaml";
import {
  compilePluginConfig,
  bundledConfigFile,
} from "../dist/effective-config.js";
import { loadConfig } from "../dist/config.js";
import { projectConfig } from "../dist/project-config.js";
import { savePreferences, preferencePath } from "../dist/preferences.js";
import { identifyWorkspace } from "../dist/workspaces.js";
const home = mkdtempSync(path.join(tmpdir(), "ab-ec-home-"));
const previous = process.env.XDG_CONFIG_HOME;
const previousBridge = process.env.AGENT_BRIDGE_CONFIG;
before(() => {
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.AGENT_BRIDGE_CONFIG;
});
after(() => {
  if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previous;
  if (previousBridge === undefined) delete process.env.AGENT_BRIDGE_CONFIG;
  else process.env.AGENT_BRIDGE_CONFIG = previousBridge;
});
function workspace() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "ab-ec-ws-")));
}
function prefs(ws, overrides = {}) {
  return {
    version: 1,
    workspaceIdentity: identifyWorkspace(ws),
    useManagedDefaults: false,
    agents: {},
    ...overrides,
  };
}
function projectFile(ws, sessionConfig = {}) {
  const file = path.join(ws, "agents.bridge.yaml");
  writeFileSync(
    file,
    stringify({
      version: 1,
      providers: {
        mock: { command: "node", args: ["x"], env: {}, readOnlyEnforced: true },
      },
      agents: {
        one: {
          provider: "mock",
          description: "project worker",
          workspace: "read-only",
          sessionConfig,
        },
      },
    }),
  );
  return file;
}
test("new workspaces compile managed defaults without creating plugin-agents.yaml", () => {
  const ws = workspace();
  const context = compilePluginConfig(ws);
  assert.equal(
    context.file,
    path.join(ws, ".agent-bridge", "effective-agents.yaml"),
  );
  assert.equal(
    existsSync(path.join(ws, ".agent-bridge", "plugin-agents.yaml")),
    false,
  );
  assert.equal(context.workspace, realpathSync(ws));
  assert.equal(context.sources.bundled, bundledConfigFile);
  assert.equal(context.sources.project, undefined);
  assert.equal(context.preferencesFile, undefined);
  assert.equal(context.migrationWarnings.length, 0);
  assert.ok(context.config.agents.demo);
  assert.equal(context.config.agents.demo.sessionConfig.mode, undefined);
  assert.equal(
    statSync(context.file).mode & 0o777,
    0o600,
    "effective file is private",
  );
  const first = statSync(context.file).mtimeMs;
  const again = compilePluginConfig(ws);
  assert.equal(
    statSync(again.file).mtimeMs,
    first,
    "unchanged bytes are not rewritten",
  );
  assert.equal(again.config.configDigest, context.config.configDigest);
});
test("project sessionConfig is stripped unless matching user preference exists", () => {
  const ws = workspace();
  const file = projectFile(ws, { mode: "bypass" });
  const context = compilePluginConfig(ws);
  assert.equal(context.sources.project, file);
  assert.deepEqual(context.projectRequestedSessionConfig, {
    one: { mode: "bypass" },
  });
  assert.equal(
    context.config.agents.one.sessionConfig.mode,
    undefined,
    "project cannot broaden session config without user preference",
  );
  assert.equal(context.config.agents.demo, undefined);
  savePreferences(
    ws,
    prefs(ws, { agents: { one: { sessionConfig: { mode: "bypass" } } } }),
  );
  const approved = compilePluginConfig(ws);
  assert.equal(approved.config.agents.one.sessionConfig.mode, "bypass");
  assert.equal(approved.preferencesFile, preferencePath(ws));
  savePreferences(
    ws,
    prefs(ws, {
      agents: {
        one: { sessionConfig: { mode: "bypass" } },
        ghost: { sessionConfig: { mode: "bypass" } },
      },
    }),
  );
  const after_ = compilePluginConfig(ws);
  assert.equal(
    after_.config.agents.ghost,
    undefined,
    "unknown saved profiles never create agents",
  );
});
test("useManagedDefaults records the choice outside the project file", () => {
  const ws = workspace();
  projectFile(ws, { mode: "bypass" });
  savePreferences(ws, prefs(ws, { useManagedDefaults: true }));
  const context = compilePluginConfig(ws);
  assert.equal(context.sources.project, undefined);
  assert.equal(context.projectRequestedSessionConfig.one, undefined);
  assert.ok(context.config.agents.demo, "managed bundled agents apply");
});
test("AGENT_BRIDGE_CONFIG remains a trusted explicit base", () => {
  const ws = workspace();
  const file = path.join(ws, "custom.yaml");
  writeFileSync(
    file,
    stringify({
      version: 1,
      providers: {
        mock: { command: "node", args: ["x"], env: {}, readOnlyEnforced: true },
      },
      agents: {
        trusted: {
          provider: "mock",
          description: "explicit",
          workspace: "read-only",
          sessionConfig: { mode: "bypass" },
        },
      },
    }),
  );
  process.env.AGENT_BRIDGE_CONFIG = file;
  try {
    const context = compilePluginConfig(ws);
    assert.equal(context.file, file);
    assert.equal(context.sources.explicitEnvironment, file);
    assert.equal(context.config.agents.trusted.sessionConfig.mode, "bypass");
    assert.equal(context.preferencesFile, undefined);
  } finally {
    delete process.env.AGENT_BRIDGE_CONFIG;
  }
});
test("managed defaults track the current bundled config", () => {
  const ws = workspace();
  const fixtureFile = path.join(
    mkdtempSync(path.join(tmpdir(), "ab-ec-bundle-")),
    "bundled.yaml",
  );
  const parsed = parse(readFileSync(bundledConfigFile, "utf8"));
  parsed.agents["bumped-check"] = { ...parsed.agents.demo };
  parsed.agents["bumped-check"].description = "temporary bundled marker";
  writeFileSync(fixtureFile, stringify(parsed));
  const context = compilePluginConfig(ws, { bundledFile: fixtureFile });
  assert.equal(context.sources.bundled, fixtureFile);
  assert.equal(
    context.config.agents["bumped-check"].description,
    "temporary bundled marker",
    "managed workspace picks up bundled updates without user action",
  );
  assert.equal(
    parse(readFileSync(bundledConfigFile, "utf8")).agents["bumped-check"],
    undefined,
    "tracked bundled config is never modified",
  );
});
test("runtime preferences overlay bounded fields only", () => {
  const ws = workspace();
  savePreferences(
    ws,
    prefs(ws, {
      runtime: { maxConcurrentTasks: 7, maxInlineChars: 3000 },
    }),
  );
  const context = compilePluginConfig(ws);
  assert.equal(context.config.runtime.maxConcurrentTasks, 7);
  assert.equal(context.config.runtime.maxInlineChars, 3000);
});
test("matching legacy generated config imports choices once and uses managed defaults", () => {
  const ws = workspace();
  const dir = path.join(ws, ".agent-bridge");
  mkdirSync(dir, { recursive: true });
  const prepared = projectConfig(loadConfig(bundledConfigFile));
  prepared.runtime = {
    ...prepared.runtime,
    workspaceRoot: ws,
    maxInlineChars: 4242,
  };
  prepared.agents.demo = {
    ...prepared.agents.demo,
    sessionConfig: { mode: "bypass" },
  };
  const legacy = path.join(dir, "plugin-agents.yaml");
  writeFileSync(legacy, stringify(prepared));
  const context = compilePluginConfig(ws);
  assert.equal(context.sources.legacyGenerated, undefined);
  assert.equal(context.migrationWarnings.length, 0);
  assert.equal(context.preferencesFile, preferencePath(ws));
  const yaml = parse(readFileSync(preferencePath(ws), "utf8"));
  assert.equal(yaml.legacy.importedFrom, legacy);
  assert.equal(yaml.agents.demo.sessionConfig.mode, "bypass");
  assert.equal(yaml.runtime.maxInlineChars, 4242);
  assert.equal(context.config.runtime.maxInlineChars, 4242);
  assert.equal(context.config.agents.demo.sessionConfig.mode, "bypass");
  assert.equal(existsSync(legacy), true, "legacy file is never deleted");
});
test("legacy provider differences keep the legacy base with a warning and no env copy", () => {
  const ws = workspace();
  const dir = path.join(ws, ".agent-bridge");
  mkdirSync(dir, { recursive: true });
  const prepared = projectConfig(loadConfig(bundledConfigFile));
  prepared.runtime = { ...prepared.runtime, workspaceRoot: ws };
  prepared.providers.mock = {
    ...prepared.providers.mock,
    env: { ...prepared.providers.mock.env, CUSTOM_SECRET: "s3cr3t-marker" },
  };
  const legacy = path.join(dir, "plugin-agents.yaml");
  writeFileSync(legacy, stringify(prepared));
  const context = compilePluginConfig(ws);
  assert.equal(context.sources.legacyGenerated, legacy);
  assert.ok(context.migrationWarnings.length > 0);
  assert.match(context.migrationWarnings[0], /differ|customiz/i);
  assert.equal(
    context.config.providers.mock.env.CUSTOM_SECRET,
    "s3cr3t-marker",
    "legacy provider customization remains the active base",
  );
  const yaml = existsSync(preferencePath(ws))
    ? readFileSync(preferencePath(ws), "utf8")
    : "";
  assert.doesNotMatch(yaml, /s3cr3t-marker/, "env never copied to preferences");
  assert.equal(existsSync(legacy), true);
});
test("a safe legacy import stays managed when bundled defaults change", () => {
  const ws = workspace();
  const dir = path.join(ws, ".agent-bridge");
  mkdirSync(dir, { recursive: true });
  const fixtureFile = path.join(
    mkdtempSync(path.join(tmpdir(), "ab-ec-bundle-")),
    "bundled.yaml",
  );
  writeFileSync(fixtureFile, readFileSync(bundledConfigFile, "utf8"));
  const prepared = projectConfig(loadConfig(fixtureFile));
  prepared.runtime = {
    ...prepared.runtime,
    workspaceRoot: ws,
    maxInlineChars: 4242,
  };
  prepared.agents.demo = {
    ...prepared.agents.demo,
    sessionConfig: { mode: "bypass" },
  };
  const legacy = path.join(dir, "plugin-agents.yaml");
  writeFileSync(legacy, stringify(prepared));
  const first = compilePluginConfig(ws, { bundledFile: fixtureFile });
  assert.equal(first.sources.legacyGenerated, undefined);
  assert.equal(
    parse(readFileSync(preferencePath(ws), "utf8")).useManagedDefaults,
    true,
    "safe import records managed defaults",
  );
  const changed = parse(readFileSync(fixtureFile, "utf8"));
  changed.providers.mock.args = ["scripts/mock-acp.mjs", "--bumped"];
  changed.agents["added-later"] = {
    provider: "mock",
    description: "added by a bundled update",
    workspace: "project",
  };
  writeFileSync(fixtureFile, stringify(changed));
  const second = compilePluginConfig(ws, { bundledFile: fixtureFile });
  assert.equal(
    second.sources.legacyGenerated,
    undefined,
    "legacy file never becomes the base again after a safe import",
  );
  assert.ok(second.config.agents["added-later"], "current bundled data wins");
  assert.equal(second.config.providers.mock.args[1], "--bumped");
  assert.equal(
    second.config.runtime.maxInlineChars,
    4242,
    "imported runtime preferences remain",
  );
  assert.equal(
    second.config.agents.demo.sessionConfig.mode,
    "bypass",
    "imported session preferences remain",
  );
});
test("advanced project config resolves root and state inside the workspace", () => {
  const ws = workspace();
  const file = path.join(ws, "agents.bridge.yaml");
  writeFileSync(
    file,
    stringify({
      version: 1,
      runtime: { stateDir: "bridge-state" },
      providers: {
        mock: { command: "node", args: ["x"], env: {}, readOnlyEnforced: true },
      },
      agents: {
        one: { provider: "mock", description: "p", workspace: "read-only" },
      },
      specialistCatalogs: {
        local: { path: "catalogs" },
      },
    }),
  );
  const context = compilePluginConfig(ws);
  const canonical = realpathSync(ws);
  assert.equal(context.config.root, canonical);
  assert.equal(
    context.config.stateDir,
    path.join(canonical, "bridge-state"),
    "relative stateDir stays project-relative, not .agent-bridge-relative",
  );
  assert.equal(
    context.config.specialistCatalogs.local.path,
    path.join(canonical, "catalogs"),
    "relative specialist catalog paths stay project-relative",
  );
  const written = parse(readFileSync(context.file, "utf8"));
  assert.equal(written.runtime.workspaceRoot, canonical);
});
test("an advanced project config keeps an intentional external workspaceRoot", () => {
  const ws = workspace();
  const external = realpathSync(mkdtempSync(path.join(tmpdir(), "ab-ec-ext-")));
  writeFileSync(
    path.join(ws, "agents.bridge.yaml"),
    stringify({
      version: 1,
      runtime: { workspaceRoot: external, stateDir: "ext-state" },
      providers: {
        mock: { command: "node", args: ["x"], env: {}, readOnlyEnforced: true },
      },
      agents: {
        one: { provider: "mock", description: "p", workspace: "read-only" },
      },
    }),
  );
  const context = compilePluginConfig(ws);
  assert.equal(context.config.root, external);
  assert.equal(
    context.config.stateDir,
    path.join(external, "ext-state"),
    "resolved stateDir follows the configured external root",
  );
  assert.equal(
    parse(readFileSync(context.file, "utf8")).runtime.workspaceRoot,
    external,
  );
});
test("nested git directories resolve the repository root", () => {
  const ws = workspace();
  execFileSync("git", ["init", "-q", ws]);
  const nested = path.join(ws, "a", "b");
  mkdirSync(nested, { recursive: true });
  const context = compilePluginConfig(nested);
  assert.equal(context.workspace, realpathSync(ws));
  const again = compilePluginConfig(path.join(ws, "a"));
  assert.equal(again.workspace, context.workspace);
});
test("a replacement directory at the same path does not reuse preferences", () => {
  const ws = workspace();
  savePreferences(
    ws,
    prefs(ws, { agents: { demo: { sessionConfig: { mode: "bypass" } } } }),
  );
  rmSync(ws, { recursive: true });
  mkdirSync(ws);
  const context = compilePluginConfig(ws);
  assert.equal(
    context.preferencesFile,
    undefined,
    "replaced workspace identity starts with no preferences",
  );
  assert.equal(context.config.agents.demo.sessionConfig.mode, undefined);
});
test("a symlinked .agent-bridge directory or effective leaf is rejected", () => {
  const ws = workspace();
  symlinkSync(
    mkdtempSync(path.join(tmpdir(), "ab-ec-real-")),
    path.join(ws, ".agent-bridge"),
  );
  assert.throws(() => compilePluginConfig(ws), /symlink|real directory/);
  const ws2 = workspace();
  const dir = path.join(ws2, ".agent-bridge");
  mkdirSync(dir);
  const decoy = path.join(ws2, "decoy.yaml");
  writeFileSync(decoy, "version: 1\nproviders: {}\nagents: {}\n");
  symlinkSync(decoy, path.join(dir, "effective-agents.yaml"));
  assert.throws(() => compilePluginConfig(ws2), /symlink/);
});
