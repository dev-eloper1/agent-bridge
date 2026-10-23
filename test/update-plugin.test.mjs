import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nodeMajor,
  pluginBlock,
  updatePlugin,
} from "../scripts/update-plugin.mjs";

const PLUGIN_LIST = `❯ agent-bridge@agent-bridge-local\n  Status: ✔ enabled\n  Version: 0.5.2\n`;

function harness(script = {}, extra = {}) {
  const calls = [];
  const warnings = [];
  const lines = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const key = `${command} ${args.join(" ")}`;
    const response =
      typeof script[key] === "function" ? script[key]() : script[key];
    if (response instanceof Error) throw response;
    return { stdout: response ?? "", stderr: "" };
  };
  return {
    calls,
    warnings,
    lines,
    options: {
      root: "/tmp/agent-bridge",
      run,
      log: (line) => lines.push(line),
      warn: (line) => warnings.push(line),
      nodeVersion: "v24.0.0",
      ...extra,
    },
  };
}

const baseScript = (overrides = {}) => ({
  "git symbolic-ref --short HEAD": "main\n",
  "git status --porcelain": "",
  "git rev-parse HEAD": "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee\n",
  "git fetch origin main": "",
  "git rev-list --left-right --count HEAD...origin/main": "0\t0\n",
  "npm --version": "10.9.0\n",
  "claude --version": "2.1.309\n",
  "claude plugin list": PLUGIN_LIST,
  ...overrides,
});

test("up-to-date clean main runs install/build/update without merging", async () => {
  const h = harness(baseScript());
  const result = await updatePlugin(h.options);
  assert.equal(result.changed, false);
  assert.equal(result.dirty, false);
  const commands = h.calls.map((call) => call.join(" "));
  assert.ok(!commands.some((c) => c.startsWith("git merge")));
  for (const expected of [
    "git symbolic-ref --short HEAD",
    "git rev-parse HEAD",
    "git status --porcelain",
    "git fetch origin main",
    "git rev-list --left-right --count HEAD...origin/main",
    "npm --version",
    "npm ci",
    "npm run build",
    "claude --version",
    "claude plugin list",
    "claude plugin update agent-bridge@agent-bridge-local --scope user",
    "claude plugin list",
  ])
    assert.ok(commands.includes(expected), `missing ${expected}`);
  assert.ok(h.lines.some((line) => line.includes("Already current")));
});

test("behind dirty main warns, fast-forwards once and reports changed", async () => {
  const heads = ["aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee\n"];
  const script = baseScript({
    "git status --porcelain": " M src/a.ts\n M src/b.ts\n",
    "git rev-list --left-right --count HEAD...origin/main": "0\t3\n",
    "git rev-parse HEAD": () =>
      heads.shift() ?? "ffffffffffffffffffffffffffffffffffffffff\n",
  });
  const h = harness(script);
  const result = await updatePlugin(h.options);
  assert.equal(result.changed, true);
  assert.equal(result.dirty, true);
  assert.equal(
    h.calls.filter((c) => c.join(" ") === "git merge --ff-only origin/main")
      .length,
    1,
  );
  assert.ok(h.warnings.some((line) => line.includes("2 local path")));
  assert.ok(!h.warnings.some((line) => line.includes("src/a.ts")));
  assert.ok(h.lines.some((line) => line.includes("aaaaaaa")));
  assert.ok(h.lines.some((line) => line.includes("fffffff")));
});

test("non-main refuses before fetch, merge or npm", async () => {
  const h = harness(
    baseScript({ "git symbolic-ref --short HEAD": "feature\n" }),
  );
  await assert.rejects(
    () => updatePlugin(h.options),
    /requires the main branch.*feature/,
  );
  assert.deepEqual(
    h.calls.map((c) => c.join(" ")),
    ["git symbolic-ref --short HEAD"],
  );
});

test("ahead-only and diverged local main refuse before merge or npm", async () => {
  for (const count of ["2\t0\n", "2\t3\n"]) {
    const h = harness(
      baseScript({
        "git rev-list --left-right --count HEAD...origin/main": count,
      }),
    );
    await assert.rejects(
      () => updatePlugin(h.options),
      /ahead of origin\/main/,
    );
    const commands = h.calls.map((c) => c.join(" "));
    assert.ok(!commands.some((c) => c.startsWith("git merge")));
    assert.ok(!commands.some((c) => c.startsWith("npm")));
  }
});

test("a failed ff-only merge propagates and stops before npm", async () => {
  const h = harness(
    baseScript({
      "git rev-list --left-right --count HEAD...origin/main": "0\t2\n",
      "git merge --ff-only origin/main": Error(
        "fatal: Not possible to fast-forward",
      ),
    }),
  );
  await assert.rejects(
    () => updatePlugin(h.options),
    /git merge --ff-only origin\/main failed/,
  );
  const commands = h.calls.map((c) => c.join(" "));
  assert.ok(!commands.some((c) => c.startsWith("npm")));
  assert.ok(!commands.some((c) => c.startsWith("claude")));
});

test("missing npm and claude fail with actionable errors", async () => {
  const noNpm = harness(
    baseScript({ "npm --version": Error("spawn npm ENOENT") }),
  );
  await assert.rejects(
    () => updatePlugin(noNpm.options),
    /npm is required.*not found/,
  );
  const noClaude = harness(
    baseScript({ "claude --version": Error("spawn claude ENOENT") }),
  );
  await assert.rejects(
    () => updatePlugin(noClaude.options),
    /claude CLI is required.*not found/,
  );
});

test("missing plugin prints the exact install command and never updates", async () => {
  const h = harness(
    baseScript({
      "claude plugin list": "other-plugin@local\n  Status: ✔ enabled\n",
    }),
  );
  await assert.rejects(
    () => updatePlugin(h.options),
    /claude plugin install agent-bridge --marketplace "\/tmp\/agent-bridge" --scope user/,
  );
  assert.ok(
    !h.calls.some((c) => c.join(" ").startsWith("claude plugin update")),
  );
});

test("plugin missing or disabled after update fails", async () => {
  const gone = harness(
    baseScript({
      "claude plugin list": (() => {
        let n = 0;
        return () => (++n === 1 ? PLUGIN_LIST : "other-plugin@local\n");
      })(),
    }),
  );
  await assert.rejects(() => updatePlugin(gone.options), /missing or disabled/);
  const disabled = harness(
    baseScript({
      "claude plugin list": (() => {
        let n = 0;
        return () =>
          ++n === 1
            ? PLUGIN_LIST
            : "❯ agent-bridge@agent-bridge-local\n  Status: ✘ disabled\n\n❯ other-plugin@local\n  Status: ✔ enabled\n";
      })(),
    }),
  );
  await assert.rejects(
    () => updatePlugin(disabled.options),
    /missing or disabled/,
  );
});

test("Node engine warnings: 20 warns, 24 silent, malformed warns", async () => {
  for (const [version, shouldWarn] of [
    ["v20.9.0", true],
    ["v24.0.0", false],
    ["not-a-version", true],
  ]) {
    const h = harness(baseScript(), { nodeVersion: version });
    await updatePlugin(h.options);
    const engine = h.warnings.some((line) => line.includes("Node >=24"));
    assert.equal(engine, shouldWarn, `nodeVersion ${version}`);
  }
});

test("command errors are bounded, name the command and redact secrets", async () => {
  const token = "ghp_" + "x".repeat(30);
  const secret =
    `fatal: ${token} via https://user:password9@example.com/repo.git ` +
    "x".repeat(2000);
  const h = harness(baseScript({ "git fetch origin main": Error(secret) }));
  const error = await updatePlugin(h.options).then(
    () => assert.fail("expected rejection"),
    (e) => e,
  );
  assert.match(error.message, /git fetch origin main failed/);
  assert.ok(error.message.length < 600);
  assert.ok(!error.message.includes(token));
  assert.ok(!error.message.includes("password9"));
  assert.ok(error.message.includes("[REDACTED]"));
});

test("nodeMajor parses versions and rejects malformed input", () => {
  assert.equal(nodeMajor("v24.1.0"), 24);
  assert.equal(nodeMajor("v20.9.0"), 20);
  assert.ok(Number.isNaN(nodeMajor("garbage")));
});

test("pluginBlock extracts only the named plugin's entry", () => {
  const list = [
    "❯ other-plugin@market",
    "  Status: ✔ enabled",
    "",
    "❯ agent-bridge@agent-bridge-local",
    "    Status: ✔ enabled",
    "    Version: 0.5.2",
    "",
    "❯ third-plugin@market",
    "  Status: ✔ enabled",
  ].join("\n");
  const block = pluginBlock(list);
  assert.match(block, /agent-bridge@agent-bridge-local/);
  assert.match(block, /Status: ✔ enabled/);
  assert.ok(!block.includes("other-plugin"));
  assert.ok(!block.includes("third-plugin"));
  assert.equal(pluginBlock("nothing installed\n"), undefined);
  assert.match(
    pluginBlock("agent-bridge@agent-bridge-local\n  Status: ✔ enabled\n"),
    /enabled/,
  );
  assert.equal(
    pluginBlock("agent-bridge@agent-bridge-local-extra\n"),
    undefined,
  );
  assert.equal(pluginBlock("my-agent-bridge@agent-bridge-local\n"), undefined);
  assert.match(
    pluginBlock("  agent-bridge@agent-bridge-local  \n  Status: ✔ enabled\n"),
    /enabled/,
  );
  assert.equal(
    pluginBlock("Uses agent-bridge@agent-bridge-local for updates\n"),
    undefined,
  );
});

test("malformed rev-list and HEAD output refuse before merge and npm", async () => {
  for (const count of [
    "nonsense\n",
    "1\n",
    "\n",
    "x\ty\n",
    "1.5\t2\n",
    "-1\t2\n",
  ]) {
    const h = harness(
      baseScript({
        "git rev-list --left-right --count HEAD...origin/main": count,
      }),
    );
    await assert.rejects(
      () => updatePlugin(h.options),
      /Could not determine relation to origin\/main/,
    );
    const commands = h.calls.map((c) => c.join(" "));
    assert.ok(!commands.some((c) => c.startsWith("git merge")));
    assert.ok(!commands.some((c) => c.startsWith("npm")));
  }
  const badHead = harness(baseScript({ "git rev-parse HEAD": "not-a-sha\n" }));
  await assert.rejects(() => updatePlugin(badHead.options), /valid HEAD/);
  assert.ok(!badHead.calls.some((c) => c[0] === "npm" || c[0] === "claude"));
});
