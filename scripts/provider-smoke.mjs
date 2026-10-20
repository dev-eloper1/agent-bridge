// Runs installed providers through the same runtime/ACP path used by the MCP tools.
// Each gets a disposable repository; no user project or CLI settings are edited.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { resolveExecutable } from "../dist/executables.js";
import { Runtime } from "../dist/runtime.js";
import { Worker } from "../dist/acp.js";
import { discoverModels } from "../dist/models.js";
const root = process.cwd();
const base = loadConfig();
const arg = process.argv.indexOf("--providers");
const names =
  arg >= 0
    ? process.argv[arg + 1].split(",")
    : ["pi", "codex", "claude", "opencode", "cursor", "devin", "copilot"];
const timeoutArg = process.argv.indexOf("--timeout-ms");
const timeout = timeoutArg >= 0 ? Number(process.argv[timeoutArg + 1]) : 60000;
const probeOnly = process.argv.includes("--probe-only");
const evidenceFile = path.join(
  root,
  probeOnly ? "docs/provider-probes.json" : "docs/provider-smoke.json",
);
const prior = existsSync(evidenceFile)
  ? JSON.parse(readFileSync(evidenceFile, "utf8"))
  : { providers: {} };
const report = {
  ...prior,
  date: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  providers: { ...prior.providers },
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}
function read(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
function save() {
  writeFileSync(evidenceFile, JSON.stringify(report, null, 2) + "\n");
}
for (const name of names) {
  const source = base.providers[name];
  if (!source) throw Error(`Unknown provider ${name}`);
  const result = {
    testedAt: new Date().toISOString(),
    provider: name,
    steps: [],
    permissions: [],
    artifacts: null,
  };
  report.providers[name] = result;
  save();
  const command = resolveExecutable(source.command, base.root);
  const missing = source.requires.filter(
    (x) => !resolveExecutable(x, base.root),
  );
  if (!command || missing.length) {
    result.availability = "missing";
    result.error = `Missing executable/dependency: ${!command ? source.command : missing.join(",")}`;
    save();
    console.log(name + ": " + result.error);
    continue;
  }
  const cli = {
    pi: "pi",
    codex: "codex",
    claude: "claude",
    opencode: "opencode",
    cursor: "agent",
    devin: "devin",
    copilot: "copilot",
  }[name];
  try {
    result.cliVersion = execFileSync(
      resolveExecutable(cli, root),
      ["--version"],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, CMUX_CLAUDE_HOOKS_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .trim()
      .split("\n")
      .find((line) => /\d/.test(line));
  } catch {
    result.cliVersion = "version command failed";
  }
  result.availability = "installed";
  result.command = command;
  const dir = mkdtempSync(path.join(tmpdir(), `ab-${name}-`));
  result.artifacts = dir;
  git(dir, ["init", "-q"]);
  writeFileSync(
    path.join(dir, "answer.js"),
    'export function sum(a, b) { throw new Error("not implemented"); }\n',
  );
  writeFileSync(
    path.join(dir, "sum.test.mjs"),
    'import {test} from "node:test"; import assert from "node:assert/strict"; import {sum} from "./answer.js"; test("sum",()=>{assert.equal(sum(2,3),5);assert.equal(sum(-3,3),0);assert.equal(sum(0,0),0);});\n',
  );
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
  git(dir, ["add", "answer.js", "sum.test.mjs", "package.json"]);
  git(dir, [
    "-c",
    "user.name=Bridge Smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const provider = {
    ...source,
    command,
    args: source.args.map((x) =>
      /^(\.\/|scripts\/)/.test(x) ? path.resolve(root, x) : x,
    ),
    env: { ...source.env },
  };
  for (const key of source.envPaths)
    if (provider.env[key])
      provider.env[key] =
        resolveExecutable(provider.env[key], root) ??
        path.resolve(root, provider.env[key]);
  const agent = {
    provider: name,
    description: `${name} isolated smoke`,
    workspace: name === "pi" ? "read-only" : "isolated-worktree",
  };
  const file = path.join(dir, "agents.yaml");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runtime: {
        stateDir: path.join(dir, "state"),
        maxRuntimeMs: timeout,
        maxInlineChars: 1500,
      },
      providers: { [name]: provider },
      agents: { worker: agent },
    }),
  );
  let runtime = new Runtime(loadConfig(file));
  const marker = `bridge-${Math.random().toString(16).slice(2, 12)}`;
  let conversation;
  async function turn(stage, prompt) {
    const start = performance.now();
    const task = await runtime.call("spawn", {
      agentId: "worker",
      prompt,
      agentSessionId: conversation,
    });
    conversation = task.agentSessionId;
    const dispatchMs = Math.round(performance.now() - start);
    let status;
    for (let i = 0; i < Math.ceil(timeout / 50) + 100; i++) {
      status = await runtime.call("status", { taskId: task.taskId });
      if (status.status === "blocked_on_input") {
        const q = status.question;
        const transcript = read(
          runtime.store.artifactPath(task.taskId, "transcript.jsonl"),
        )
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        const detail = transcript.findLast(
          (x) => x.type === "question" && x.questionId === q.questionId,
        )?.request;
        const cwd = runtime.store.state.sessions.worker.cwd;
        // Only the explicitly requested answer.js file edit is authorized for automation.
        const locations = detail?.toolCall?.locations ?? [];
        const safeEdit =
          stage === "coding" &&
          detail?.toolCall?.kind === "edit" &&
          locations.length > 0 &&
          locations.every(
            (x) => path.resolve(cwd, x.path) === path.join(cwd, "answer.js"),
          );
        const options = q.options ?? [];
        const chosen = options.find(
          (x) => x.kind === (safeEdit ? "allow_once" : "reject_once"),
        );
        result.permissions.push({
          stage,
          kind: q.kind,
          toolKind: detail?.toolCall?.kind,
          decision: safeEdit ? "scoped-file-edit" : "deny",
          questionId: q.questionId,
        });
        if (q.kind === "permission" && chosen)
          await runtime.call("reply", {
            taskId: task.taskId,
            questionId: q.questionId,
            optionId: chosen.optionId,
          });
        else {
          await runtime.call("cancel", { taskId: task.taskId });
          throw Error(
            "Unexpected question or permission requires manual handling",
          );
        }
      }
      if (
        ["completed", "failed", "cancelled", "timed_out"].includes(
          status.status,
        )
      )
        break;
      await pause(50);
    }
    const output = read(runtime.store.artifactPath(task.taskId, "output.txt"));
    const step = {
      stage,
      taskId: task.taskId,
      status: status.status,
      dispatchMs,
      elapsedMs: Math.round(performance.now() - start),
      summary: status.summary,
      modelId: status.modelId,
      usage: status.usage,
      stopReason: status.stopReason,
    };
    result.steps.push(step);
    save();
    console.log(`${name}: ${stage} ${step.status} (${step.elapsedMs}ms)`);
    if (status.status !== "completed")
      throw Error(status.summary || status.status);
    return output;
  }
  try {
    if (probeOnly) {
      let stderr = "";
      const config = loadConfig(file);
      const worker = new Worker(config, name, dir, {
        update: () => {},
        question: async (kind) =>
          kind === "input"
            ? { action: "decline" }
            : { outcome: { outcome: "cancelled" } },
        exit: () => {},
        log: (s) => {
          stderr = (stderr + s).slice(-2000);
        },
      });
      let timer;
      try {
        const response = await Promise.race([
          (async () => {
            const init = await worker.initialize();
            result.capabilities = init.agentCapabilities;
            return worker.session(dir);
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("ACP probe timed out")),
              20000,
            );
          }),
        ]);
        const models = discoverModels(response);
        result.models = models
          ? {
              currentModelId: models.currentModelId,
              count: models.availableModels.length,
              sample: models.availableModels.slice(0, 5),
            }
          : { discovery: "not reported" };
        result.outcome = "probe-passed";
        console.log(name + ": ACP discovery probe passed");
      } finally {
        clearTimeout(timer);
        worker.kill();
        if (stderr) result.stderr = runtime.sanitize(stderr);
      }
      continue;
    }
    await turn(
      "first",
      `Do not use any tools, read files, run commands, delegate or modify anything. Remember this exact label for this conversation: ${marker}. Reply only ACK.`,
    );
    const session = runtime.store.state.sessions.worker;
    result.capabilities = session.capabilities;
    result.models = {
      currentModelId: session.models?.currentModelId,
      count: session.models?.availableModels?.length,
    };
    result.nativeSessionId = session.nativeSessionId;
    const recalled = await turn(
      "continuity",
      "Do not use tools, read files, run commands, delegate or modify anything. What exact label did I ask you to remember? Reply only the label.",
    );
    if (recalled.trim() !== marker)
      throw Error("Continuity output did not exactly match remembered label");
    result.continuity = "passed";
    if (session.capabilities?.loadSession) {
      runtime.close();
      await pause(150);
      runtime = new Runtime(loadConfig(file));
      const output = await turn(
        "recovery",
        "Do not use tools, read files, run commands, delegate or modify anything. Recall the exact label from earlier in this conversation. Reply only the label.",
      );
      if (output.trim() !== marker)
        throw Error("Recovered output did not exactly match remembered label");
      if (
        runtime.store.state.sessions.worker.nativeSessionId !==
        result.nativeSessionId
      )
        throw Error("Native session ID changed");
      result.recovery = "passed";
    } else result.recovery = "unsupported (loadSession not advertised)";
    if (name === "pi") {
      const text = await turn(
        "review",
        "Use only your read tool to inspect answer.js and sum.test.mjs in this directory. Explain the defect and provide the corrected sum function. Do not edit files or run commands. Keep the answer under 100 words.",
      );
      if (!text.includes("sum") || !text.includes("+"))
        throw Error("Review did not propose addition");
      if (
        git(dir, [
          "status",
          "--porcelain",
          "--",
          "answer.js",
          "sum.test.mjs",
          "package.json",
        ]).trim()
      )
        throw Error("Read-only reviewer modified fixture files");
      result.review = "passed";
      result.coding = "not attempted: Pi is restricted to read-only tools";
    } else {
      await turn(
        "coding",
        "Edit only answer.js using your file edit/write tool. Replace the throwing stub with exactly: export function sum(a, b) { return a + b; } . Do not use shell/terminal, read secrets, make network requests, delegate, edit other files or run tests. Reply DONE.",
      );
      const cwd = runtime.store.state.sessions.worker.cwd;
      result.verificationOutput = execFileSync(
        process.execPath,
        ["--test", path.join(cwd, "sum.test.mjs")],
        {
          cwd,
          encoding: "utf8",
          timeout: 10000,
          env: { PATH: process.env.PATH },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).slice(-2000);
      const changed = git(cwd, ["diff", "--name-only", "HEAD"])
        .trim()
        .split("\n")
        .filter(Boolean);
      if (changed.length !== 1 || changed[0] !== "answer.js")
        throw Error("Unexpected changed file scope");
      result.coding = "passed: independent node --test";
    }
    result.outcome = "passed";
  } catch (e) {
    result.outcome = "blocked";
    result.error = runtime
      .sanitize(e instanceof Error ? e.message : String(e))
      .slice(0, 1500);
    const session = runtime.store.state.sessions.worker;
    if (session) {
      result.capabilities = session.capabilities;
      result.models = {
        currentModelId: session.models?.currentModelId,
        count: session.models?.availableModels?.length,
      };
    }
    console.log(`${name}: BLOCKED ${result.error.split("\n")[0]}`);
  } finally {
    runtime.close();
    save();
  }
}
console.log("Evidence: " + path.relative(root, evidenceFile));
console.log(
  Object.fromEntries(
    Object.entries(report.providers).map(([k, v]) => [
      k,
      {
        outcome: v.outcome,
        continuity: v.continuity,
        recovery: v.recovery,
        coding: v.coding,
        review: v.review,
        error: v.error,
      },
    ]),
  ),
);
if (
  names.some(
    (x) =>
      report.providers[x].outcome !== "passed" &&
      report.providers[x].outcome !== "probe-passed",
  )
)
  process.exitCode = 1;
