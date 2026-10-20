// End-to-end: actual Claude Code loads this plugin/skill, delegates over MCP to
// the installed Pi ACP worker, waits, and reads its result. No manual daemon/config.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { resolveExecutable } from "../dist/executables.js";
const root = process.cwd();
const installed = process.argv.includes("--installed");
const continuity = process.argv.includes("--session-continuity");
const codexReview = process.argv.includes("--codex-review");
const worker = codexReview ? "codex-worker" : "pi-reviewer";
const dir = mkdtempSync(path.join(tmpdir(), "ab-claude-plugin-"));
const marker = "PLUGIN-" + Math.random().toString(16).slice(2, 12);
writeFileSync(path.join(dir, "fixture.txt"), marker + "\n");
const reviewSource = "export function sum(a, b) { return a - b; }\n";
if (codexReview) writeFileSync(path.join(dir, "review.js"), reviewSource);
if (!codexReview) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "fixture.txt"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Plugin Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
}
const prompt = continuity
  ? "Use Pi through Agent Bridge to read fixture.txt from this project and report its exact label. Then ask Pi in the same session to repeat the exact label from its previous context without reading files or using any tools; do not supply the label in your follow-up prompt. Finally start a fresh Pi session and ask it to reply SESSION-FRESH without tools. Return the three answers concisely. Do not change files or use shell commands, native Claude subagents or another worker."
  : codexReview
    ? "Use Codex to review this project in the current folder. Do not edit files or initialize Git. Identify the concrete bug in review.js and report the exact label in fixture.txt. Use the Agent Bridge plugin. Do not use shell commands, native Claude subagents or another worker."
    : "Use Pi through Agent Bridge to read fixture.txt from this project and report its exact label. Do not change files or use shell commands, native Claude subagents or another worker.";

const child = spawn(
  resolveExecutable("claude", root),
  [
    "-p",
    prompt,
    ...(!installed ? ["--plugin-dir", root] : []),
    "--setting-sources",
    installed ? "user" : "",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    continuity ? "18" : "12",
    "--tools",
    "Skill,ToolSearch",
    "--allowedTools",
    "Skill,ToolSearch,mcp__plugin_agent-bridge_workers__*",
  ],
  {
    cwd: dir,
    env: { ...process.env, CMUX_CLAUDE_HOOKS_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stdout = "",
  stderr = "";
child.stdout.on("data", (b) => (stdout += b));
child.stderr.on("data", (b) => (stderr += b));
const timeout = setTimeout(
  () => child.kill("SIGTERM"),
  continuity ? 180000 : 120000,
);
const exitCode = await new Promise((r) => child.once("close", r));
clearTimeout(timeout);
writeFileSync(path.join(dir, "claude-session.jsonl"), stdout, { mode: 0o600 });
writeFileSync(path.join(dir, "claude-stderr.txt"), stderr, { mode: 0o600 });
let evidence = {
  date: new Date().toISOString(),
  artifacts: dir,
  exitCode,
  mode: installed ? "installed-plugin" : "plugin-dir",
};
try {
  const messages = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  const calls = messages
    .flatMap((x) => (x.type === "assistant" ? (x.message?.content ?? []) : []))
    .filter((x) => x.type === "tool_use");
  evidence.tools = calls.map((x) => ({
    name: x.name,
    ...(x.name === "Skill" ? { skill: x.input.skill } : {}),
    ...(x.name.endsWith("__agents_spawn") || x.name.endsWith("__agents_run")
      ? { agentId: x.input.agentId, workspace: x.input.workspace }
      : {}),
  }));
  const final = messages.findLast((x) => x.type === "result");
  evidence.result = final?.result?.slice(0, 1000);
  evidence.modStatusObserved = [
    ...new Set(
      messages
        .filter((x) => x.subtype === "ui_status" && x.plugin === "agent-bridge")
        .map((x) => x.text),
    ),
  ];
  const state = JSON.parse(
    readFileSync(path.join(dir, ".agent-bridge/state.json"), "utf8"),
  );
  evidence.tasks = Object.values(state.tasks).map((t) => ({
    taskId: t.taskId,
    agentId: t.agentId,
    agentSessionId: t.agentSessionId,
    workerName: t.workerName,
    status: t.status,
    summary: t.summary.slice(0, 400),
    workspace: t.workspace,
    cwd: t.cwd,
    recentActivity: t.recentActivity,
    execution: t.execution,
    description: t.description,
  }));
  if (exitCode !== 0) throw Error("Claude CLI exited unsuccessfully");
  if (
    !calls.some(
      (x) => x.name === "Skill" && x.input.skill === "agent-bridge:delegate",
    )
  )
    throw Error("Claude did not load delegation skill");
  if (
    !calls.some(
      (x) =>
        (x.name.endsWith("__agents_spawn") ||
          x.name.endsWith("__agents_run")) &&
        x.input.agentId === worker,
    )
  )
    throw Error(
      "Claude did not delegate to the selected worker through plugin MCP",
    );
  if (
    !evidence.tasks.some(
      (t) => t.agentId === worker && t.status === "completed",
    )
  )
    throw Error("Worker task did not complete");
  if (!final?.result?.includes(marker))
    throw Error("Claude did not return the label read by Pi");
  if (codexReview) {
    if (!final?.result?.includes("review.js"))
      throw Error("Codex review did not identify the fixture file");
    if (existsSync(path.join(dir, ".git")))
      throw Error("Review unexpectedly initialized Git");
    if (existsSync(path.join(dir, ".agent-bridge/worktrees")))
      throw Error("Review unexpectedly created a worktree");
    if (readFileSync(path.join(dir, "review.js"), "utf8") !== reviewSource)
      throw Error("Review modified the source file");
    if (
      !evidence.tasks.some(
        (t) => t.agentId === worker && t.workspace?.mode === "project",
      )
    )
      throw Error("Review did not select project mode");
    if (
      !evidence.tasks.some(
        (t) => t.agentId === worker && t.recentActivity?.length,
      )
    )
      throw Error("Review did not expose provider tool activity");
  }
  if (!calls.some((x) => x.name.endsWith("__agents_run")))
    throw Error("Ordinary request did not use foreground delegation");
  if (calls.some((x) => x.name.endsWith("__agents_spawn")))
    throw Error("Ordinary request incorrectly dispatched background work");
  if (
    /task_[a-f0-9-]{36}|conversation_[a-f0-9-]{36}|artifact:\/\//.test(
      final?.result ?? "",
    )
  )
    throw Error(
      "Final response exposed internal task/session/artifact identifiers",
    );
  if (continuity) {
    const turns = evidence.tasks.filter((t) => t.agentId === worker);
    if (turns.length !== 3 || turns.some((t) => t.status !== "completed"))
      throw Error("Expected three completed Pi tasks");
    if (
      !turns[0].workerName ||
      turns[0].workerName !== turns[1].workerName ||
      turns[2].workerName === turns[0].workerName
    )
      throw Error(
        "Conversation names did not distinguish follow-up from fresh session",
      );
    if (turns[0].agentSessionId !== turns[1].agentSessionId)
      throw Error("Same-session follow-up created a new conversation");
    if (turns[2].agentSessionId === turns[1].agentSessionId)
      throw Error("Fresh-session request reused the prior conversation");
    if (!turns[1].summary.includes(marker))
      throw Error("Same-session Pi did not recall the previous label");
    if (turns[1].recentActivity?.length || turns[2].recentActivity?.length)
      throw Error("No-tools follow-up unexpectedly used tools");
    if (!turns[2].summary.includes("SESSION-FRESH"))
      throw Error("Fresh-session Pi did not answer");
    const prompts = Object.values(state.tasks)
      .filter((t) => t.agentId === worker)
      .map((t) =>
        readFileSync(
          path.join(dir, ".agent-bridge/artifacts", t.taskId, "prompt.txt"),
          "utf8",
        ),
      );
    if (prompts[1].includes(marker))
      throw Error(
        "Coordinator supplied the label instead of testing context recall",
      );
  }
  evidence.outcome = "passed";
} catch (e) {
  evidence.outcome = "failed";
  evidence.error = e.message;
  process.exitCode = 1;
} finally {
  const pidFile = path.join(dir, ".agent-bridge/lock/pid");
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    } catch {}
  }
  writeFileSync(
    path.join(
      root,
      continuity
        ? "docs/claude-session-smoke.json"
        : codexReview
          ? "docs/claude-codex-review-smoke.json"
          : "docs/claude-plugin-smoke.json",
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
}
