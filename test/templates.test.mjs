import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  templateRoots,
  createTemplate,
  resolveTemplate,
  listTemplates,
  validateTemplateBinding,
} from "../dist/templates.js";
import { loadConfig } from "../dist/config.js";
import { Runtime } from "../dist/runtime.js";
const baseDefinition = {
  format: 1,
  id: "reviewer",
  name: "Evidence reviewer",
  version: "1.0.0",
  description: "Find reproduced defects",
  instructions: "ORIGINAL_INSTRUCTIONS",
  delivery: "task-instructions",
};
function fixture(system = false) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "ab-definitions-")),
  );
  const roots = templateRoots(root, path.join(root, "personal", "agents"));
  const file = path.join(root, "agents.yaml");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runtime: {
        stateDir: ".agent-bridge",
        maxRuntimeMs: 5000,
        maxInlineChars: 6000,
      },
      providers: {
        mock: {
          command: process.execPath,
          args: [
            path.resolve("scripts/mock-acp.mjs"),
            ...(system ? ["--system-prompt"] : []),
          ],
          env: { MOCK_STATE: path.join(root, "mock") },
          readOnlyEnforced: true,
        },
      },
      agents: { reviewer: { provider: "mock", description: "Fixture" } },
    }),
  );
  return { root, roots, config: loadConfig(file) };
}
async function finish(runtime, args) {
  const task = await runtime.call("spawn", {
    agentId: "reviewer",
    prompt: "Review fixture",
    ...args,
  });
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = await runtime.call("result", {
      taskId: task.taskId,
      maxChars: 6000,
    });
    if (
      ["completed", "failed", "cancelled", "timed_out"].includes(result.status)
    )
      return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Task did not finish");
}
test("saved definitions refuse ambiguous project/global names and create never overwrites", () => {
  const f = fixture();
  createTemplate(f.roots, "global", baseDefinition);
  assert.equal(resolveTemplate(f.roots, "reviewer").scope, "global");
  createTemplate(f.roots, "project", {
    ...baseDefinition,
    instructions: "PROJECT",
  });
  // A repository definition must not silently shadow the user's global one.
  assert.throws(
    () => resolveTemplate(f.roots, "reviewer"),
    /both project and global scope/,
  );
  assert.equal(
    resolveTemplate(f.roots, "project:reviewer").instructions,
    "PROJECT",
  );
  assert.equal(
    resolveTemplate(f.roots, "global:reviewer").instructions,
    "ORIGINAL_INSTRUCTIONS",
  );
  assert.throws(
    () => createTemplate(f.roots, "project", baseDefinition),
    /EEXIST/,
  );
  assert.equal(listTemplates(f.roots).length, 2);
});
test("definition validation rejects executable fields, traversal and redirected files/directories", () => {
  const f = fixture();
  assert.throws(() =>
    createTemplate(f.roots, "project", { ...baseDefinition, tools: ["bash"] }),
  );
  assert.throws(() => resolveTemplate(f.roots, "../../escape"));
  const d = createTemplate(f.roots, "project", baseDefinition);
  unlinkSync(d.source);
  const outside = path.join(f.root, "outside.yaml");
  writeFileSync(outside, JSON.stringify(baseDefinition));
  symlinkSync(outside, d.source);
  assert.throws(() => resolveTemplate(f.roots, "reviewer"), /ELOOP/);
  assert.ok(listTemplates(f.roots)[0].error);
  assert.throws(
    () => createTemplate(f.roots, "project", baseDefinition),
    /EEXIST/,
  );
  const aliasRoots = { ...f.roots, global: path.join(f.root, "alias") };
  symlinkSync(f.roots.project, aliasRoots.global);
  assert.throws(() => resolveTemplate(aliasRoots, "global:reviewer"), /Unsafe/);
});
test("required provider/tool restrictions fail closed instead of degrading into instructions", () => {
  const f = fixture();
  const t = createTemplate(f.roots, "project", {
    ...baseDefinition,
    requiresReadOnly: true,
    providers: ["mock"],
  });
  assert.match(
    validateTemplateBinding(t, f.config, "reviewer").toolPolicy,
    /read-only/,
  );
  f.config.providers.mock.readOnlyEnforced = false;
  assert.throws(
    () => validateTemplateBinding(t, f.config, "reviewer"),
    /requires provider-enforced/,
  );
  f.config.agents.reviewer.provider = "other";
  assert.throws(
    () => validateTemplateBinding(t, f.config, "reviewer"),
    /does not support/,
  );
});
test("task-instruction definitions persist immutable context through edits, deletion and native reload", async () => {
  const f = fixture();
  let runtime = new Runtime(f.config);
  try {
    await runtime.call("define", {
      definition: {
        ...baseDefinition,
        acceptanceCriteria: ["Report concrete evidence"],
      },
    });
    const first = await finish(runtime, { template: "project:reviewer" });
    assert.equal(first.status, "completed");
    assert.match(first.output, /ORIGINAL_INSTRUCTIONS/);
    assert.equal(first.template.delivery, "task-instructions");
    assert.equal(first.acceptanceCriteriaCount, 1);
    const saved = resolveTemplate(f.roots, "reviewer");
    writeFileSync(
      saved.source,
      JSON.stringify({
        ...baseDefinition,
        version: "2.0.0",
        instructions: "CHANGED_INSTRUCTIONS",
      }),
    );
    await assert.rejects(
      runtime.call("spawn", {
        agentId: "reviewer",
        prompt: "Follow up",
        template: "reviewer",
        agentSessionId: first.agentSessionId,
      }),
      /pinned/,
    );
    unlinkSync(saved.source);
    runtime.close();
    runtime = new Runtime(f.config);
    const next = await finish(runtime, {
      agentSessionId: first.agentSessionId,
    });
    assert.equal(next.status, "completed");
    assert.equal(next.template.digest, first.template.digest);
    assert.match(next.output, /ORIGINAL_INSTRUCTIONS/);
    assert.doesNotMatch(next.output, /CHANGED_INSTRUCTIONS/);
    const pinned = await runtime.call("templates", {
      agentSessionId: first.agentSessionId,
    });
    assert.equal(pinned.pinned, true);
    assert.equal(pinned.instructions, "ORIGINAL_INSTRUCTIONS");
    assert.equal(pinned.version, "1.0.0");
  } finally {
    runtime.close();
  }
});
test("experimental native system append reaches new and load requests with no user-message substitution", async () => {
  const f = fixture(true);
  let runtime = new Runtime(f.config);
  try {
    createTemplate(f.roots, "project", {
      ...baseDefinition,
      delivery: "system-append",
    });
    const first = await finish(runtime, {
      template: "reviewer",
      prompt: "CHECKSYSTEM",
    });
    assert.equal(first.status, "completed");
    assert.match(first.output, /ORIGINAL_INSTRUCTIONS/);
    const session = Object.values(runtime.store.state.sessions)[0];
    const wire = JSON.parse(
      readFileSync(
        path.join(f.root, `mock-${session.nativeSessionId}.json.system`),
        "utf8",
      ),
    );
    assert.equal(wire.mode, "append");
    assert.equal(wire.content[0].text, "ORIGINAL_INSTRUCTIONS");
    const transcript = runtime.store.readArtifactText(
      first.taskId,
      "transcript.jsonl",
    );
    const prompt = transcript
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .find((x) => x.type === "coordinator.prompt");
    assert.equal(prompt.text, "CHECKSYSTEM");
    runtime.close();
    runtime = new Runtime(f.config);
    const next = await finish(runtime, {
      agentSessionId: first.agentSessionId,
      prompt: "CHECKSYSTEM",
    });
    assert.equal(next.status, "completed");
    assert.match(next.output, /ORIGINAL_INSTRUCTIONS/);
    assert.equal(
      Object.values(runtime.store.state.sessions)[0].recovery,
      "loaded",
    );
  } finally {
    runtime.close();
  }
});
test("a required system prompt fails before native session creation on an unsupported backend", async () => {
  const f = fixture();
  const runtime = new Runtime(f.config);
  try {
    createTemplate(f.roots, "project", {
      ...baseDefinition,
      delivery: "system-append",
    });
    const result = await finish(runtime, { template: "reviewer" });
    assert.equal(result.status, "failed");
    assert.match(result.summary, /does not advertise/);
    assert.equal(
      Object.values(runtime.store.state.sessions)[0].nativeSessionId,
      undefined,
    );
  } finally {
    runtime.close();
  }
});
