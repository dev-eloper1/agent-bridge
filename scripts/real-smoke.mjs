// Three tiny no-tools prompts: same-process continuity, then native load after runtime restart.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Runtime } from "../dist/runtime.js";
import { loadConfig } from "../dist/config.js";
import { resolveExecutable } from "../dist/executables.js";
import assert from "node:assert/strict";
const root = process.cwd();
const dir = mkdtempSync(path.join(tmpdir(), "ab-real-"));
execFileSync("git", ["init", "-q", dir]);
writeFileSync(path.join(dir, "README"), "ACP smoke workspace\n");
execFileSync("git", ["-C", dir, "add", "README"]);
execFileSync("git", [
  "-C",
  dir,
  "-c",
  "user.name=Smoke",
  "-c",
  "user.email=smoke@example.invalid",
  "commit",
  "-qm",
  "fixture",
]);
const file = path.join(dir, "agents.yaml");
writeFileSync(
  file,
  JSON.stringify({
    version: 1,
    runtime: { stateDir: path.join(dir, "state"), maxRuntimeMs: 90000 },
    providers: {
      codex: {
        command: path.join(root, "node_modules/.bin/codex-acp"),
        args: [],
        env: {
          CODEX_PATH: resolveExecutable("codex", root),
        },
      },
    },
    agents: {
      smoke: {
        provider: "codex",
        description: "Tiny local authenticated smoke",
        workspace: "isolated-worktree",
      },
    },
  }),
);
const config = loadConfig(file);
let runtime = new Runtime(config);
let evidence = {
  date: new Date().toISOString(),
  adapter: "2.2.2",
  artifacts: dir,
  steps: [],
};
let conversation;
async function run(prompt) {
  const t = await runtime.call("spawn", {
    agentId: "smoke",
    prompt,
    agentSessionId: conversation,
  });
  conversation = t.agentSessionId;
  let state;
  for (let i = 0; i < 1000; i++) {
    state = await runtime.call("status", { taskId: t.taskId });
    if (["completed", "failed", "timed_out"].includes(state.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  evidence.steps.push(state);
  console.log(JSON.stringify(state));
  assert.equal(state.status, "completed", state.summary);
  return readFileSync(
    runtime.store.artifactPath(t.taskId, "output.txt"),
    "utf8",
  );
}
try {
  const marker = "cobalt-" + Math.random().toString(16).slice(2, 10);
  await run(
    `Do not call tools, run commands, delegate, read files or change anything. Remember this exact label for our conversation: ${marker}. Reply only ACK.`,
  );
  const second = await run(
    "Do not call tools, run commands, delegate, read files or change anything. What exact label did I ask you to remember? Reply only the label.",
  );
  assert.ok(second.includes(marker), "Same-process continuity failed");
  const session = runtime.store.state.sessions.smoke;
  const native = session.nativeSessionId;
  evidence.capabilities = session.capabilities;
  evidence.models = session.models;
  runtime.close();
  runtime = new Runtime(config);
  const third = await run(
    "Do not call tools, run commands, delegate, read files or change anything. Recall the exact remembered label from earlier in this conversation. Reply only the label.",
  );
  assert.ok(third.includes(marker), "Native recovery continuity failed");
  assert.equal(runtime.store.state.sessions.smoke.nativeSessionId, native);
  evidence.nativeLoad = "passed";
  evidence.continuity = "passed";
} catch (e) {
  evidence.error = e.message;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  runtime.close();
  writeFileSync(
    path.join(root, "docs/real-smoke.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("Evidence: docs/real-smoke.json");
}
