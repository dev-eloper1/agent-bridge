// Minimal paid behavioral checks over real bridge tasks in disposable folders.
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { projectConfig } from "../dist/project-config.js";
import { Runtime } from "../dist/runtime.js";
const base = loadConfig();
const profiles = projectConfig(base);
const report = {
  date: new Date().toISOString(),
  scope:
    "Instruction delivery, pinned revisions and fresh definitions; not a reviewer-quality eval",
  providers: {},
};
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["pi", "claude"];
let failures = 0;
for (const name of names) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), `ab-specialist-${name}-`)),
  );
  const file = path.join(root, "agents.yaml");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runtime: {
        stateDir: ".agent-bridge",
        maxRuntimeMs: 90000,
        maxInlineChars: 2000,
      },
      providers: { [name]: profiles.providers[name] },
      agents: {
        specialist: {
          provider: name,
          description: "Specialist smoke",
          workspace: name === "pi" ? "read-only" : "project",
        },
      },
    }),
  );
  const config = loadConfig(file);
  const result = {
    delivery: name === "claude" ? "system-append" : "task-instructions",
    steps: [],
    outcome: "failed",
  };
  report.providers[name] = result;
  let runtime = new Runtime(config);
  async function check(label, args) {
    const task = await runtime.call("spawn", {
      agentId: "specialist",
      description: "Instruction delivery check",
      prompt:
        "Return your assigned test label. Use no tools. Return the label only.",
      ...args,
    });
    const start = Date.now();
    while (Date.now() - start < 95000) {
      const r = await runtime.call("result", {
        taskId: task.taskId,
        maxChars: 2000,
      });
      if (
        ["failed", "cancelled", "timed_out", "blocked_on_input"].includes(
          r.status,
        )
      )
        throw Error(
          `Task ended ${r.status}: ${runtime.sanitize(r.summary ?? "")}`,
        );
      if (r.status === "completed") {
        if (r.output.trim() !== label)
          throw Error("Output did not match the assigned test label");
        result.steps.push({
          expected: label,
          passed: true,
          elapsedMs: Date.now() - start,
          digest: r.template.digest,
        });
        return r;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw Error("Behavioral check deadline exceeded");
  }
  try {
    const definition = {
      format: 1,
      id: "smoke-specialist",
      name: "Smoke specialist",
      version: "1.0.0",
      description: "Instruction-delivery acceptance fixture",
      delivery: result.delivery,
      instructions:
        "Your assigned test label is BRIDGE_SPECIALIST_ORIGINAL. When asked for your assigned test label, respond with exactly BRIDGE_SPECIALIST_ORIGINAL and no other text.",
      requiresReadOnly: name === "pi",
    };
    const saved = await runtime.call("define", { definition });
    const first = await check("BRIDGE_SPECIALIST_ORIGINAL", {
      template: "project:smoke-specialist",
    });
    const changed = {
      ...definition,
      version: "2.0.0",
      instructions: definition.instructions.replaceAll("ORIGINAL", "REVISED"),
    };
    writeFileSync(saved.source, JSON.stringify(changed));
    runtime.close();
    runtime = new Runtime(config);
    const followup = await check("BRIDGE_SPECIALIST_ORIGINAL", {
      agentSessionId: first.agentSessionId,
    });
    if (followup.template.digest !== first.template.digest)
      throw Error("Pinned revision changed");
    const fresh = await check("BRIDGE_SPECIALIST_REVISED", {
      template: "project:smoke-specialist",
    });
    if (
      fresh.agentSessionId === first.agentSessionId ||
      fresh.template.digest === first.template.digest
    )
      throw Error("Fresh instance failed to adopt new revision");
    result.outcome = "passed";
  } catch (error) {
    failures++;
    result.error = runtime.sanitize(error.message).slice(0, 500);
  } finally {
    runtime.close();
  }
  writeFileSync(
    "docs/specialization-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(name + ": " + result.outcome);
}
process.exitCode = failures ? 1 : 0;
