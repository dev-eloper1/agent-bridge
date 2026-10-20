import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Config } from "./config.js";
import {
  Store,
  uid,
  now,
  terminal,
  type Task,
  type Session,
  type Status,
} from "./store.js";
import { Worker } from "./acp.js";
import { resolveExecutable } from "./executables.js";
import { discoverModels } from "./models.js";
import { workerName } from "./worker-names.js";
import {
  workspaceInput,
  resolveWorkspace,
  type Workspace,
  identifyWorkspace,
  verifyWorkspace,
} from "./workspaces.js";
const taskId = z.string().regex(/^task_[a-f0-9-]{36}$/);
const message = z.string().min(1).max(16000);
export const inputs = {
  list: z.object({}).strict(),
  spawn: z
    .object({
      agentId: z.string().max(64),
      prompt: message,
      taskKey: z.string().min(1).max(100).optional(),
      acceptanceCriteria: z.array(z.string().max(500)).max(20).default([]),
      workspace: workspaceInput.optional(),
      agentSessionId: z
        .string()
        .regex(/^conversation_[a-f0-9-]{36}$/)
        .optional(),
      description: z.string().min(1).max(120).optional(),
      execution: z.enum(["foreground", "background"]).default("background"),
    })
    .strict(),
  status: z.object({ taskId }).strict(),
  steer: z.object({ taskId, message }).strict(),
  reply: z
    .object({
      taskId,
      questionId: z.string(),
      message: message.optional(),
      content: z
        .record(
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        )
        .optional(),
      optionId: z.string().optional(),
    })
    .strict(),
  events: z
    .object({
      afterCursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  result: z
    .object({
      taskId,
      maxChars: z.number().int().min(0).max(6000).default(2000),
    })
    .strict(),
  artifact: z
    .object({
      ref: z.string().max(200),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(6000).default(2000),
    })
    .strict(),
  cancel: z.object({ taskId }).strict(),
  wait: z
    .object({
      taskIds: z.array(taskId).min(1).max(10),
      timeoutMs: z.number().int().min(0).max(8000).default(4000),
    })
    .strict(),
};
type Method = keyof typeof inputs;
interface Active {
  streaming: boolean;
  outputPrefix: string;
  task: Task;
  worker?: Worker;
  timer: NodeJS.Timeout;
  interrupted: Promise<never>;
  reject: (e: Error) => void;
}
interface Question {
  taskId: string;
  request: any;
  kind: "input" | "permission";
  resolve: (v: any) => void;
}
export class Runtime {
  store: Store;
  workers = new Map<string, Worker>();
  workerSessions = new Map<string, string>();
  active = new Map<string, Active>();
  questions = new Map<string, Question>();
  closed = false;
  constructor(readonly config: Config) {
    this.store = new Store(config.stateDir, config.runtime.maxArtifactBytes);
    const sessions = Object.values(this.store.state.sessions);
    const reserved = new Set(
      sessions.flatMap((s) => (s.workerName ? [s.workerName] : [])),
    );
    for (const session of sessions) {
      const history = Object.values(this.store.state.tasks).filter(
        (t) => t.agentSessionId === session.agentSessionId,
      );
      if (!session.workerName) {
        session.workerName = workerName(
          session.agentId,
          this.sanitize(history[0]?.description ?? "task"),
          reserved,
        );
        reserved.add(session.workerName);
      }
      for (const task of history) task.workerName = session.workerName;
    }
    for (const t of Object.values(this.store.state.tasks))
      if (!terminal(t.status) && t.status !== "queued") {
        t.status = "failed";
        t.finishedAt = now();
        t.summary = "Runtime restarted during execution; not replayed";
        delete t.question;
        this.store.event(t, "task.failed", t.summary);
      }
    this.store.save();
  }
  start() {
    this.schedule();
  }
  sanitize(s: string) {
    for (const p of Object.values(this.config.providers))
      for (const name of p.envNames) {
        const v = process.env[name];
        if (v && v.length >= 6) s = s.split(v).join("[REDACTED]");
      }
    for (const p of Object.values(this.config.providers))
      for (const [name, v] of Object.entries(p.env))
        if (/TOKEN|SECRET|PASSWORD|API_KEY/i.test(name) && v.length >= 6)
          s = s.split(v).join("[REDACTED]");
    return s.replace(
      /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g,
      "[REDACTED]",
    );
  }
  append(t: Task, name: string, value: string) {
    this.store.append(t.taskId, name, this.sanitize(value));
  }
  compact(t: Task) {
    const { acceptanceCriteria, ...rest } = t;
    return {
      ...rest,
      acceptanceCriteriaCount: acceptanceCriteria.length,
      followups: t.followups.length,
    };
  }
  session(t: Task): Session {
    const s = Object.values(this.store.state.sessions).find(
      (s) => s.agentId === t.agentId && s.agentSessionId === t.agentSessionId,
    );
    if (!s) throw Error("Task conversation missing");
    return s;
  }
  defaultWorkspace(agentId: string): Workspace {
    return {
      mode:
        this.config.agents[agentId].workspace === "isolated-worktree"
          ? "isolated-worktree"
          : "project",
    };
  }
  async call(method: string, raw: unknown): Promise<unknown> {
    if (!(method in inputs) || !Object.hasOwn(inputs, method))
      throw Error("Unknown method");
    const a: any = inputs[method as Method].parse(raw);
    switch (method) {
      case "list":
        return Object.entries(this.config.agents).map(([agentId, agent]) => {
          const sessions = Object.values(this.store.state.sessions).filter(
            (s) => s.agentId === agentId,
          );
          const current =
            this.active.get(agentId)?.task.agentSessionId ??
            this.workerSessions.get(agentId);
          const s =
            sessions.find((s) => s.agentSessionId === current) ??
            this.store.state.sessions[agentId];
          const p = this.config.providers[agent.provider];
          const executable = resolveExecutable(p.command, this.config.root);
          const missingDependencies = p.requires.filter(
            (x) => !resolveExecutable(x, this.config.root),
          );
          const available =
            Boolean(executable) && missingDependencies.length === 0;
          return {
            agentId,
            ...agent,
            available,
            executable: executable ?? null,
            missingDependencies,
            status: this.active.has(agentId)
              ? "busy"
              : this.workers.has(agentId)
                ? "ready"
                : "registered",
            agentSessionId: s?.agentSessionId,
            workerName: s?.workerName,
            activeTasks: Object.values(this.store.state.tasks)
              .filter((t) => t.agentId === agentId && !terminal(t.status))
              .slice(-10)
              .map((t) => ({
                taskId: t.taskId,
                agentSessionId: t.agentSessionId,
                workerName: t.workerName,
                taskKey: t.taskKey,
                description: t.description,
                execution: t.execution,
                status: t.status,
              })),
            defaultWorkspace: this.defaultWorkspace(agentId),
            sessions: sessions.slice(-10).map((s) => ({
              agentSessionId: s.agentSessionId,
              workerName: s.workerName,
              workspace: s.workspace ?? this.defaultWorkspace(agentId),
              cwd: s.cwd,
              lastTask: Object.values(this.store.state.tasks)
                .filter((t) => t.agentSessionId === s.agentSessionId)
                .slice(-1)
                .map((t) => ({
                  taskId: t.taskId,
                  description: t.description,
                  status: t.status,
                  createdAt: t.createdAt,
                }))[0],
            })),
            totalSessions: sessions.length,
            capabilities: s?.capabilities ?? "not negotiated",
            models: s?.models
              ? {
                  currentModelId: (s.models as any).currentModelId,
                  availableModels: (s.models as any).availableModels
                    ?.slice(0, 10)
                    .map((m: any) => ({ modelId: m.modelId, name: m.name })),
                  total: (s.models as any).availableModels?.length,
                }
              : "not discovered",
            recovery: s?.recovery ?? "not tested",
            cost: "unknown; provider metadata is not invoice cost",
          };
        });
      case "spawn": {
        const agent = this.config.agents[a.agentId];
        if (!agent) throw Error("Unknown agent");
        if (a.taskKey) {
          const previous = Object.values(this.store.state.tasks).find(
            (t) => t.agentId === a.agentId && t.taskKey === a.taskKey,
          );
          if (previous) return this.compact(previous);
        }
        if (
          Object.values(this.store.state.tasks).filter(
            (t) => !terminal(t.status),
          ).length >= 100
        )
          throw Error("Queue limit reached");
        if (a.agentSessionId && a.workspace)
          throw Error(
            "Use agentSessionId to continue a conversation, or workspace to select one; not both",
          );
        const selected = resolveWorkspace(
          a.workspace ?? this.defaultWorkspace(a.agentId),
          this.config.root,
        );
        // A new task gets fresh context. Only an explicit conversation ID resumes.
        // Keep the first legacy key for compatibility with saved state/tools.
        const key = this.store.state.sessions[a.agentId]
          ? uid("conversation")
          : a.agentId;
        let s = a.agentSessionId
          ? Object.values(this.store.state.sessions).find(
              (s) =>
                s.agentId === a.agentId &&
                s.agentSessionId === a.agentSessionId,
            )
          : undefined;
        if (a.agentSessionId && !s)
          throw Error("Unknown conversation for this worker");
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              agent,
              provider: this.config.providers[agent.provider],
            }),
          )
          .digest("hex");
        if (s && s.fingerprint !== fingerprint)
          throw Error(
            "Provider/workspace configuration changed for durable conversation; start a fresh conversation",
          );
        if (!s) {
          const identity =
            selected.mode === "project" || selected.mode === "directory"
              ? identifyWorkspace(
                  selected.mode === "project"
                    ? this.config.root
                    : selected.path,
                )
              : undefined;
          s = this.store.state.sessions[key] = {
            agentId: a.agentId,
            agentSessionId: uid("conversation"),
            workerName: workerName(
              a.agentId,
              this.sanitize(a.description ?? a.prompt.split("\n")[0]),
              Object.values(this.store.state.sessions).flatMap((s) =>
                s.workerName ? [s.workerName] : [],
              ),
            ),
            fingerprint,
            workspace: selected,
            workspaceIdentity: identity,
            cwd: identity?.canonicalPath,
          };
        }
        const t: Task = {
          taskId: uid("task"),
          agentId: a.agentId,
          agentSessionId: s.agentSessionId,
          workerName: s.workerName,
          workspace: s.workspace ?? this.defaultWorkspace(a.agentId),
          cwd: s.cwd,
          status: "queued",
          createdAt: now(),
          summary: "Queued",
          taskKey: a.taskKey,
          description: this.sanitize(
            a.description ?? a.prompt.split("\n")[0],
          ).slice(0, 120),
          execution: a.execution,
          acceptanceCriteria: a.acceptanceCriteria,
          provider: agent.provider,
          verification: "pending",
          followups: [],
          steeringCount: 0,
        };
        this.append(t, "prompt.txt", a.prompt);
        this.store.state.tasks[t.taskId] = t;
        this.store.event(t, "task.queued", "Queued");
        setImmediate(() => this.schedule());
        return this.compact(t);
      }
      case "wait": {
        const deadline = Date.now() + a.timeoutMs;
        while (true) {
          const tasks = a.taskIds.map((id: string) => this.store.task(id));
          if (
            tasks.some(
              (t: Task) =>
                terminal(t.status) || t.status === "blocked_on_input",
            ) ||
            Date.now() >= deadline
          )
            return {
              tasks: tasks.map((t: Task) => this.compact(t)),
              timedOut: Date.now() >= deadline,
            };
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      case "status":
        return this.compact(this.store.task(a.taskId));
      case "steer": {
        const t = this.store.task(a.taskId);
        if (terminal(t.status) || t.status === "blocked_on_input")
          throw Error(
            "Cannot steer terminal or blocked task; use reply for questions",
          );
        if (t.steeringCount >= 2) throw Error("Steering limit reached");
        t.steeringCount++;
        t.followups.push(a.message);
        this.store.event(
          t,
          "task.steered",
          "Follow-up queued for next ACP turn",
        );
        return { queued: true, semantics: "next-turn", messageId: uid("msg") };
      }
      case "reply":
        return this.reply(a);
      case "events": {
        const events = this.store.state.events
          .filter((e) => e.cursor > a.afterCursor)
          .slice(0, a.limit);
        return {
          events,
          nextCursor: events.at(-1)?.cursor ?? a.afterCursor,
          delivery: "replayable; cursor is caller-owned",
        };
      }
      case "result": {
        const t = this.store.task(a.taskId);
        const max = Math.min(a.maxChars, this.config.runtime.maxInlineChars);
        const outputRef = `artifact://${t.taskId}/output.txt`;
        const outputSize = this.store.artifactSize(t.taskId, "output.txt");
        const output =
          outputSize === undefined
            ? undefined
            : this.store.readArtifact(t.taskId, "output.txt", 0, max);
        return {
          ...this.compact(t),
          summary: t.summary.slice(0, max),
          summaryKind: "bounded-output-tail",
          output: output?.text,
          outputComplete: output?.eof ?? false,
          nextOutputOffset: output?.nextOffset ?? 0,
          fullOutputRef: outputSize === undefined ? undefined : outputRef,
          outputBytes: outputSize ?? 0,
          artifactRefs: [
            "output.txt",
            "transcript.jsonl",
            "prompt.txt",
            "stderr.txt",
            "diff.patch",
            "recovery.jsonl",
          ]
            .filter((n) => this.store.artifactSize(t.taskId, n) !== undefined)
            .map((n) => `artifact://${t.taskId}/${n}`),
        };
      }
      case "artifact": {
        const match =
          /^artifact:\/\/(task_[a-f0-9-]{36})\/([a-z-]+\.(?:txt|jsonl|patch))$/.exec(
            a.ref,
          );
        if (!match) throw Error("Invalid artifact reference");
        this.store.task(match[1]);
        return this.store.readArtifact(
          match[1],
          match[2],
          a.offset,
          Math.min(a.limit, this.config.runtime.maxInlineChars),
        );
      }
      case "cancel": {
        const t = this.store.task(a.taskId);
        if (terminal(t.status)) return this.compact(t);
        this.finish(t, "cancelled", "Cancelled by coordinator");
        const r = this.active.get(t.agentId);
        if (r?.task.taskId === t.taskId) this.interrupt(r);
        return this.compact(t);
      }
    }
  }
  reply(a: any) {
    const t = this.store.task(a.taskId);
    const q = this.questions.get(a.questionId);
    if (!q || q.taskId !== t.taskId || t.question?.questionId !== a.questionId)
      throw Error("Question is no longer pending");
    let result: any;
    if (q.kind === "permission") {
      const option = q.request.options.find(
        (o: any) => o.optionId === a.optionId,
      );
      if (!option || !["allow_once", "reject_once"].includes(option.kind))
        throw Error("Select an explicit allow_once or reject_once option");
      result = { outcome: { outcome: "selected", optionId: option.optionId } };
    } else {
      const content =
        a.content ?? (a.message ? { message: a.message } : undefined);
      if (!content) throw Error("Reply content required");
      const validation = new AjvJsonSchemaValidator().getValidator({
        ...q.request.requestedSchema,
        additionalProperties: false,
      })(content);
      if (!validation.valid)
        throw Error(
          "Answer does not match requested schema: " + validation.errorMessage,
        );
      result = { action: "accept", content };
    }
    this.append(
      t,
      "transcript.jsonl",
      JSON.stringify({
        type: "coordinator.reply",
        questionId: a.questionId,
        result,
      }) + "\n",
    );
    this.questions.delete(a.questionId);
    delete t.question;
    t.status = "running";
    this.store.event(t, "task.replied", "Reply accepted");
    q.resolve(result);
    return { accepted: true };
  }
  schedule() {
    if (this.closed) return;
    for (const t of Object.values(this.store.state.tasks)) {
      if (this.active.size >= this.config.runtime.maxConcurrentTasks) break;
      if (t.status === "queued" && !this.active.has(t.agentId))
        void this.run(t);
    }
  }
  finish(t: Task, status: Status, summary: string) {
    if (terminal(t.status)) return;
    t.status = status;
    t.summary = this.sanitize(summary).slice(
      0,
      this.config.runtime.maxInlineChars,
    );
    t.finishedAt = now();
    if (t.question) {
      const q = this.questions.get(t.question.questionId);
      q?.resolve(
        q.kind === "input"
          ? { action: "cancel" }
          : { outcome: { outcome: "cancelled" } },
      );
      this.questions.delete(t.question.questionId);
      delete t.question;
    }
    this.store.event(
      t,
      `task.${status}`,
      status === "completed"
        ? "Worker finished; independent verification pending"
        : t.summary,
    );
  }
  interrupt(r: Active) {
    const s = this.session(r.task);
    if (r.worker && s.nativeSessionId) void r.worker.cancel(s.nativeSessionId);
    // Terminate immediately after sending best-effort cancel; do not reuse a possibly busy process.
    (r.worker ?? this.workers.get(r.task.agentId))?.kill();
    this.workers.delete(r.task.agentId);
    r.reject(Error("Task interrupted"));
  }
  async workspace(s: Session) {
    if (s.cwd) {
      const identity = verifyWorkspace(s.cwd, s.workspaceIdentity);
      if (!s.workspaceIdentity) {
        s.workspaceIdentity = identity;
        this.store.save();
      }
      return s.cwd;
    }
    const selected = s.workspace ?? this.defaultWorkspace(s.agentId);
    if (selected.mode === "project" || selected.mode === "directory") {
      s.workspaceIdentity = identifyWorkspace(
        selected.mode === "project" ? this.config.root : selected.path,
      );
      s.cwd = s.workspaceIdentity.canonicalPath;
      this.store.save();
      return s.cwd;
    }
    if (selected.mode === "temporary") {
      const dir = path.join(this.config.stateDir, "scratch", s.agentSessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      s.workspaceIdentity = identifyWorkspace(dir);
      s.cwd = s.workspaceIdentity.canonicalPath;
      this.store.save();
      return s.cwd;
    }
    const dir = path.join(this.config.stateDir, "worktrees", s.agentSessionId);
    execFileSync(
      "git",
      ["-C", this.config.root, "worktree", "add", "--detach", dir, "HEAD"],
      { stdio: "pipe" },
    );
    s.workspaceIdentity = identifyWorkspace(dir);
    s.cwd = s.workspaceIdentity.canonicalPath;
    this.store.save();
    return s.cwd;
  }
  async run(t: Task) {
    let reject!: (e: Error) => void;
    const interrupted = new Promise<never>((_, r) => {
      reject = r;
    });
    void interrupted.catch(() => {});
    const r: Active = {
      streaming: false,
      outputPrefix: "",
      task: t,
      interrupted,
      reject,
      timer: setTimeout(() => {
        this.finish(t, "timed_out", "Runtime budget exceeded");
        this.interrupt(r);
      }, this.config.runtime.maxRuntimeMs),
    };
    this.active.set(t.agentId, r);
    t.status = "running";
    t.summary = "";
    t.startedAt = now();
    this.store.event(t, "task.started", "Starting worker");
    try {
      await Promise.race([this.execute(r), interrupted]);
    } catch (e) {
      this.finish(t, "failed", e instanceof Error ? e.message : String(e));
      (r.worker ?? this.workers.get(t.agentId))?.kill();
      this.workers.delete(t.agentId);
    } finally {
      clearTimeout(r.timer);
      this.active.delete(t.agentId);
      this.schedule();
    }
  }
  async execute(r: Active) {
    const t = r.task;
    const s = this.session(t);
    const a = this.config.agents[t.agentId];
    const cwd = await this.workspace(s);
    t.cwd = cwd;
    this.store.save();
    if (terminal(t.status)) return;
    let w = this.workers.get(t.agentId);
    if (w && this.workerSessions.get(t.agentId) !== s.agentSessionId) {
      this.workers.delete(t.agentId);
      w.kill();
      w = undefined;
    }
    if (!w || w.dead) {
      w = new Worker(this.config, a.provider, cwd, {
        log: (text) => {
          const active = this.active.get(t.agentId);
          const task = active?.task;
          if (task && !terminal(task.status)) {
            try {
              this.append(task, "stderr.txt", text);
            } catch (e) {
              this.finish(task, "failed", String(e));
              this.interrupt(active!);
            }
          }
        },
        update: (value) => this.update(t.agentId, value),
        question: (kind, value) => this.question(t.agentId, kind, value),
        exit: () => {
          if (this.workers.get(t.agentId) !== r.worker) return;
          this.workers.delete(t.agentId);
          const active = this.active.get(t.agentId);
          if (
            active &&
            active.worker === r.worker &&
            !terminal(active.task.status)
          ) {
            this.store.event(
              active.task,
              "agent.disconnected",
              "Backend process disconnected",
            );
            active.reject(Error("Backend disconnected"));
          }
        },
      });
      r.worker = w;
      this.workers.set(t.agentId, w);
      this.workerSessions.set(t.agentId, s.agentSessionId);
      const init = await w.initialize();
      s.capabilities =
        (init.agentCapabilities as Record<string, unknown>) ?? {};
      verifyWorkspace(cwd, s.workspaceIdentity);
      const response = await w.session(cwd, s.nativeSessionId);
      if (!s.nativeSessionId) {
        if (!response || !("sessionId" in response))
          throw Error("Missing native session ID");
        s.nativeSessionId = response.sessionId;
        s.recovery = "new";
      } else {
        s.recovery = "loaded";
        this.store.event(
          t,
          "agent.recovered",
          "Existing native conversation loaded",
        );
      }
      if (response) s.models = discoverModels(response) ?? s.models;
      this.store.save();
    }
    r.worker = w;
    t.modelId = (
      s.models as { currentModelId?: string } | undefined
    )?.currentModelId;
    let prompt = this.store.readArtifactText(t.taskId, "prompt.txt");
    if (t.acceptanceCriteria.length)
      prompt +=
        "\nAcceptance criteria (coordinator verifies independently):\n" +
        t.acceptanceCriteria.join("\n");
    do {
      verifyWorkspace(cwd, s.workspaceIdentity);
      r.streaming = true;
      r.outputPrefix = "";
      this.append(
        t,
        "transcript.jsonl",
        JSON.stringify({ type: "coordinator.prompt", text: prompt }) + "\n",
      );
      const response = await w.prompt(s.nativeSessionId!, prompt);
      r.streaming = false;
      if (terminal(t.status)) return;
      t.stopReason = response.stopReason;
      this.append(
        t,
        "transcript.jsonl",
        JSON.stringify({ type: "prompt.result", ...response }) + "\n",
      );
      if (response.stopReason === "cancelled") {
        this.finish(t, "cancelled", "Backend cancelled");
        return;
      }
      if (response.stopReason !== "end_turn")
        throw Error(`Backend did not finish normally: ${response.stopReason}`);
      const failurePrefixes =
        this.config.providers[a.provider].errorOutputPrefixes;
      if (
        failurePrefixes.some((prefix) =>
          r.outputPrefix.trimStart().startsWith(prefix),
        )
      )
        throw Error(
          "Backend reported an execution error: " +
            r.outputPrefix.slice(0, 500),
        );
      prompt = t.followups.shift() ?? "";
      this.store.save();
    } while (prompt);
    if (
      (s.workspace ?? this.defaultWorkspace(t.agentId)).mode ===
      "isolated-worktree"
    ) {
      const diff = execFileSync("git", ["-C", cwd, "diff", "HEAD"], {
        maxBuffer: this.config.runtime.maxArtifactBytes,
        encoding: "utf8",
      });
      this.append(t, "diff.patch", diff); // untracked files are listed separately, not silently included in patch
      this.append(
        t,
        "transcript.jsonl",
        JSON.stringify({
          type: "workspace.status",
          status: execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
            encoding: "utf8",
          }),
        }) + "\n",
      );
    }
    this.finish(t, "completed", t.summary || "Completed; inspect artifacts");
  }
  update(agentId: string, value: any) {
    const r = this.active.get(agentId);
    if (!r || terminal(r.task.status)) return;
    const t = r.task;
    const s = this.session(t);
    if (value.sessionId !== s.nativeSessionId) return;
    try {
      if (!r.streaming) {
        this.append(t, "recovery.jsonl", JSON.stringify(value) + "\n");
        return;
      }
      this.append(t, "transcript.jsonl", JSON.stringify(value) + "\n");
      const u = value.update;
      if (
        u.sessionUpdate === "tool_call" ||
        u.sessionUpdate === "tool_call_update"
      ) {
        const recent = (t.recentActivity ??= []);
        const previous = recent.find((x) => x.toolCallId === u.toolCallId);
        const entry = previous ?? {
          toolCallId: String(u.toolCallId).slice(0, 200),
          title: "Tool call",
          status: "pending",
          timestamp: now(),
        };
        if (typeof u.title === "string")
          entry.title = this.sanitize(u.title)
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .slice(0, 240);
        if (typeof u.kind === "string") entry.kind = u.kind.slice(0, 40);
        const locations = (u.locations ?? [])
          .map((l: { path?: unknown }) => l.path)
          .filter((p: unknown): p is string => typeof p === "string");
        const inputPath = u.rawInput?.path ?? u.rawInput?.filePath;
        if (!locations.length && typeof inputPath === "string")
          locations.push(inputPath);
        if (locations.length)
          (entry as NonNullable<Task["recentActivity"]>[number]).paths =
            locations.slice(0, 3).map((p: string) => {
              const relative =
                t.cwd && path.isAbsolute(p) ? path.relative(t.cwd, p) : p;
              return this.sanitize(relative || ".")
                .replace(/[\x00-\x1f\x7f]/g, " ")
                .slice(0, 240);
            });
        if (typeof u.status === "string") entry.status = u.status.slice(0, 40);
        entry.timestamp = now();
        if (!previous) recent.push(entry);
        t.recentActivity = recent.slice(-8);
        t.activity = {
          text: `${entry.status}: ${entry.title}`,
          timestamp: entry.timestamp,
        };
      }
      if (u.sessionUpdate === "config_option_update") {
        s.models = discoverModels(u) ?? s.models;
        t.modelId = (
          s.models as { currentModelId?: string } | undefined
        )?.currentModelId;
      }
      if (u.sessionUpdate === "usage_update")
        t.usage = {
          used: u.used,
          size: u.size,
          cost: u.cost,
          attribution:
            "provider-reported cumulative session metadata, not task invoice cost",
        };
      if (
        u.sessionUpdate === "agent_message_chunk" &&
        u.content?.type === "text"
      ) {
        r.outputPrefix = (r.outputPrefix + u.content.text).slice(0, 1024);
        this.append(t, "output.txt", u.content.text);
        t.summary = (t.summary + this.sanitize(u.content.text)).slice(
          -this.config.runtime.maxInlineChars,
        );
        t.activity = { text: "Writing public response", timestamp: now() };
      }
      const last = this.store.state.events.findLast(
        (e) => e.taskId === t.taskId && e.type === "task.progress",
      );
      if (!last || Date.now() - Date.parse(last.timestamp) > 30000)
        this.store.event(
          t,
          "task.progress",
          t.activity?.text ?? "Worker update; full content in artifact",
        );
    } catch (e) {
      this.finish(t, "failed", String(e));
      this.interrupt(r);
    }
  }
  async question(
    agentId: string,
    kind: "input" | "permission",
    request: any,
  ): Promise<any> {
    const t = this.active.get(agentId)?.task;
    const declined =
      kind === "input"
        ? { action: "decline" }
        : { outcome: { outcome: "cancelled" } };
    if (
      !t ||
      terminal(t.status) ||
      t.question ||
      this.questions.size >= 10 ||
      request.sessionId !== this.session(t).nativeSessionId
    )
      return declined;
    if (
      kind === "permission" &&
      this.config.agents[agentId].workspace === "read-only"
    )
      return declined;
    const questionId = uid("question");
    this.append(
      t,
      "transcript.jsonl",
      JSON.stringify({ type: "question", questionId, kind, request }) + "\n",
    );
    t.status = "blocked_on_input";
    t.question = {
      artifactRef: `artifact://${t.taskId}/transcript.jsonl`,
      questionId,
      kind,
      summary: this.sanitize(
        String(
          request.message ?? request.toolCall?.title ?? "Permission required",
        ),
      ).slice(0, 240),
      options: request.options?.slice(0, 20).map((o: any) => ({
        optionId: String(o.optionId).slice(0, 100),
        kind: String(o.kind).slice(0, 50),
        name: this.sanitize(String(o.name)).slice(0, 120),
      })),
    };
    return new Promise((resolve) => {
      this.questions.set(questionId, {
        taskId: t.taskId,
        request,
        kind,
        resolve,
      });
      this.store.event(
        t,
        kind === "input" ? "task.question" : "task.blocked",
        t.question!.summary,
        true,
      );
    });
  }
  close() {
    this.closed = true;
    for (const r of this.active.values()) {
      this.finish(
        r.task,
        "failed",
        "Runtime stopped during execution; not replayed",
      );
      this.interrupt(r);
      clearTimeout(r.timer);
    }
    for (const w of this.workers.values()) w.kill();
    this.workers.clear();
    this.store.save();
  }
}
