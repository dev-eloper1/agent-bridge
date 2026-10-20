// Capability discovery only: no model prompt, no edits to native CLI configuration.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { Worker } from "../dist/acp.js";
import { resolveExecutable } from "../dist/executables.js";
const config = loadConfig();
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["pi", "codex", "claude", "opencode", "cursor", "devin", "copilot"];
const report = {
  date: new Date().toISOString(),
  sdk: "2.0.0/v1-unstable",
  modelPrompts: 0,
  providers: {},
};
for (const name of names) {
  const provider = config.providers[name];
  if (!provider) throw Error("Unknown provider: " + name);
  const cwd = realpathSync(
    mkdtempSync(path.join(tmpdir(), "ab-specialization-probe-")),
  );
  let worker, timer;
  try {
    worker = new Worker(config, name, cwd, {
      update() {},
      log() {},
      exit() {},
      question: async (kind) =>
        kind === "input"
          ? { action: "decline" }
          : { outcome: { outcome: "cancelled" } },
    });
    const initialized = await Promise.race([
      worker.initialize(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Initialization deadline exceeded")),
          20000,
        );
      }),
    ]);
    const caps = initialized.agentCapabilities ?? {};
    const cli = name === "cursor" ? "agent" : name;
    let version = "unknown";
    try {
      version =
        execFileSync(resolveExecutable(cli, config.root), ["--version"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, CMUX_CLAUDE_HOOKS_DISABLED: "1" },
        })
          .trim()
          .split("\n")
          .find((line) => /\d/.test(line)) ?? "unknown";
    } catch {}
    report.providers[name] = {
      version,
      initialized: true,
      loadSession: Boolean(caps.loadSession),
      experimentalSystemPrompt: caps.sessionCapabilities?.systemPrompt ?? null,
      mcpCapabilities: caps.mcpCapabilities ?? null,
      readOnlyProfile: provider.readOnlyEnforced,
      interpretation:
        "Advertised initialization capabilities only; not a behavioral test or authentication/entitlement guarantee",
    };
  } catch {
    report.providers[name] = {
      initialized: false,
      error:
        "Initialization failed or timed out; no specialization capability claim",
    };
  } finally {
    clearTimeout(timer);
    worker?.kill();
  }
  console.log(name + ": " + JSON.stringify(report.providers[name]));
  writeFileSync(
    "docs/specialization-probes.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
