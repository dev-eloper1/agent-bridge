#!/usr/bin/env node
// pi-acp accepts an executable override, not arbitrary CLI flags. Reuse Pi RPC,
// constrain its tools, and fail closed when pi-acp would swallow a model error.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const child = spawn(
  "pi",
  [
    "--tools",
    "read,grep,find,ls",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    ...(process.env.BRIDGE_PI_MODEL
      ? ["--model", process.env.BRIDGE_PI_MODEL]
      : []),
    ...process.argv.slice(2),
  ],
  { stdio: ["pipe", "pipe", "pipe"], shell: false },
);
let failed = false;
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
createInterface({ input: child.stdout }).on("line", (line) => {
  if (failed) return;
  try {
    const event = JSON.parse(line);
    const m = event.message;
    if (
      event.type === "message_end" &&
      m?.role === "assistant" &&
      m.stopReason === "error"
    ) {
      failed = true;
      console.error(
        "Pi model error: " +
          String(m.errorMessage ?? "unspecified error").slice(0, 1000),
      );
      child.kill("SIGTERM");
      process.stdin.destroy();
      setTimeout(() => {
        child.kill("SIGKILL");
        process.exit(1);
      }, 100).unref();
      return;
    }
  } catch {}
  process.stdout.write(line + "\n");
});
child.once("error", () => {
  console.error("Installed pi executable unavailable");
  process.exitCode = 1;
  process.stdin.destroy();
});
child.once("exit", (code) => {
  process.exitCode = failed ? 1 : (code ?? 1);
  process.stdin.destroy();
});
process.stdin.once("end", () => child.kill("SIGTERM"));
