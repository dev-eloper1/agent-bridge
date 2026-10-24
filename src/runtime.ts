import {
  snapshotVerifyInputs,
  changedVerifyInputs,
} from "./lab-verify-inputs.js";
import { verifySpec, verifyCommand } from "./lab-verify-verdict.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { agentConcurrency, type Config } from "./config.js";
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
import {
  templateDefinition,
  createTemplate,
  templateRef,
  templateRoots,
  resolveTemplate,
  listTemplates,
  templateMetadata,
  validateTemplateBinding,
} from "./templates.js";
import {
  specialistRef,
  specialistSpecDefinition,
  catalogRoots,
  resolveSpecialist,
  inlineSpecialist,
  listSpecialists,
  specialistMetadata,
  validateSpecialistBinding,
} from "./specialists.js";
import { startDashboard } from "./dashboard.js";
import { TriggerRegistry } from "./lab-triggers.js";
import { buildId } from "./build-id.js";
import { buildHandoffPrompt } from "./handoff.js";
const taskId = z.string().regex(/^task_[a-f0-9-]{36}$/);
// lab(lineage-labels): bounded, safe-charset group labels.
const WAIT_LABEL_CAP = 10;
const countTerminal = (byStatus: Record<string, number>) =>
  Object.entries(byStatus).reduce(
    (n, [k, v]) => n + (terminal(k as Status) ? v : 0),
    0,
  );
const label = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,47}$/, "label must match [a-z0-9][a-z0-9._:-]{0,47}");
const message = z.string().min(1).max(16000);
export const inputs = {
  list: z.object({}).strict(),
  dashboard: z.object({}).strict(),
  doctor: z.object({}).strict(),
  define: z
    .object({
      scope: z.enum(["project", "global"]).default("project"),
      definition: templateDefinition,
    })
    .strict(),
  templates: z
    .object({
      reference: templateRef.optional(),
      agentSessionId: z
        .string()
        .regex(/^conversation_[a-f0-9-]{36}$/)
        .optional(),
      agentId: z.string().max(64).optional(),
    })
    .strict(),
  specialists_schema: z.object({}).strict(),
  specialists_validate: z
    .object({
      specialistSpec: specialistSpecDefinition,
      agentId: z.string().max(64).optional(),
    })
    .strict(),
  specialists_catalog: z
    .object({
      query: z.string().trim().min(1).max(200).optional(),
      reference: specialistRef.optional(),
      agentId: z.string().max(64).optional(),
    })
    .strict(),
  spawn: z
    .object({
      agentId: z.string().max(64),
      prompt: message,
      specialistRef: specialistRef.optional(),
      specialistSpec: specialistSpecDefinition.optional(),
      template: templateRef.optional(),
      taskKey: z.string().min(1).max(100).optional(),
      dependsOn: z
        .array(taskId)
        .max(100)
        .optional()
        .describe(
          "Existing task IDs that must all complete before this task runs; any unsuccessful dependency fails this task",
        ),
      budgetLabel: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,64}$/)
        .describe(
          "Optional configured runtime.taskBudgets label. Counts accepted tasks across agents in retained runtime state, including terminal tasks; retries with the same taskKey do not spend again.",
        )
        .optional(),
      acceptanceCriteria: z.array(z.string().max(500)).max(20).default([]),
      verify: verifySpec.optional(),
      workspace: workspaceInput.optional(),
      agentSessionId: z
        .string()
        .regex(/^conversation_[a-f0-9-]{36}$/)
        .optional(),
      description: z.string().min(1).max(120).optional(),
      execution: z.enum(["foreground", "background"]).default("background"),
      inputsFrom: z
        .array(
          z
            .object({
              taskId,
              maxChars: z.number().int().min(1).max(12000).default(4000),
            })
            .strict(),
        )
        .max(4)
        .optional(),
      labels: z.array(label).max(8).optional(),
      parentTaskId: taskId.optional(),
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
      label: label.optional(),
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
      taskIds: z.array(taskId).min(1).max(10).optional(),
      label: label.optional(),
      timeoutMs: z.number().int().min(0).max(8000).default(4000),
    })
    .strict(),
};
type Method = keyof typeof inputs;
interface Active {
  verificationAbort?: AbortController;
  streaming: boolean;
  outputPrefix: string;
  task: Task;
  worker?: Worker;
  timer?: NodeJS.Timeout;
  remainingMs: number;
  resumedAt?: number;
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
  // Keyed by agentSessionId: each conversation owns one ACP process, so fresh
  // conversations on the same profile run in parallel and cancel independently.
  workers = new Map<string, Worker>();
  // agentId -> most recently started conversation, for list().
  workerSessions = new Map<string, string>();
  active = new Map<string, Active>();
  questions = new Map<string, Question>();
  closed = false;
  readonly startedAt = now();
  dashboardServer?: Awaited<ReturnType<typeof startDashboard>>;
  dashboardStarting?: Promise<Awaited<ReturnType<typeof startDashboard>>>;
  readonly triggers: TriggerRegistry;
  private triggerTimer?: NodeJS.Timeout;
  constructor(
    readonly config: Config,
    clock: () => number = Date.now,
  ) {
    this.store = new Store(config.stateDir, config.runtime.maxArtifactBytes);
    this.triggers = new TriggerRegistry(
      this.store,
      config,
      (args, triggerId) => this.call("spawn", args, triggerId),
      clock,
      () => this.closed,
    );
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
        this.triggers.taskFinished(t);
        this.store.event(t, "task.failed", t.summary);
      }
    this.store.save();
  }
  start() {
    if (this.closed) throw Error("Runtime closed");
    if (!this.triggerTimer) {
      const tick = () => {
        void this.triggers.tick();
      };
      tick();
      this.triggerTimer = setInterval(tick, 250);
      this.triggerTimer.unref();
    }
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
  dependencyReady(id: string) {
    const dependency = this.store.state.tasks[id];
    return (
      dependency?.status === "completed" &&
      (!dependency.verify || dependency.verification === "passed")
    );
  }
  queue(t: Task) {
    const queued = Object.values(this.store.state.tasks).filter(
      (x) => x.status === "queued",
    );
    const suppressed =
      t.status === "queued" &&
      [...this.active.values()].some(
        (r) =>
          r.task.agentId === t.agentId &&
          r.task.status === "blocked_on_input" &&
          r.task.question?.kind === "permission",
      );
    const waitingOnDependency =
      t.status === "queued" &&
      (t.dependsOn ?? []).some((id) => !this.dependencyReady(id));
    const index = queued.findIndex((x) => x.taskId === t.taskId);
    return {
      queuePosition: index >= 0 ? index + 1 : undefined,
      queuedTasks: queued.length,
      activeTasks: this.active.size,
      concurrencyLimit: this.config.runtime.maxConcurrentTasks,
      queueReason: waitingOnDependency
        ? ("waiting_on_dependency" as const)
        : suppressed
          ? ("agent_waiting_for_permission" as const)
          : undefined,
    };
  }
  // lab(lineage-labels): one pass over tasks; returns at most WAIT_LABEL_CAP
  // tasks (still-open first, then blocked, then finished) plus group counts.
  labelGroup(label: string) {
    const open: Task[] = [];
    const blocked: Task[] = [];
    const done: Task[] = [];
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const t of Object.values(this.store.state.tasks)) {
      if (!t.labels?.includes(label)) continue;
      total++;
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      const bucket = terminal(t.status)
        ? done
        : t.status === "blocked_on_input"
          ? blocked
          : open;
      if (bucket.length < WAIT_LABEL_CAP) bucket.push(t);
    }
    return {
      total,
      open:
        total - (byStatus.blocked_on_input ?? 0) - countTerminal(byStatus),
      byStatus,
      tasks: [...open, ...blocked, ...done].slice(0, WAIT_LABEL_CAP),
    };
  }
  compact(t: Task) {
    const { acceptanceCriteria, ...rest } = t;
    return {
      ...rest,
      agentConcurrency: agentConcurrency(this.config, t.agentId),
      acceptanceCriteriaCount: acceptanceCriteria.length,
      followups: t.followups.length,
      ...this.queue(t),
    };
  }
  lean(t: Task) {
    return {
      taskId: t.taskId,
      agentId: t.agentId,
      agentSessionId: t.agentSessionId,
      workerName: t.workerName,
      description: t.description,
      execution: t.execution,
      ...(t.labels ? { labels: t.labels } : {}),
      ...(t.parentTaskId ? { parentTaskId: t.parentTaskId } : {}),
      status: t.status,
      question: t.question,
      activity: t.activity,
      ...this.queue(t),
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
  async call(
    method: string,
    raw: unknown,
    triggerId?: string,
  ): Promise<unknown> {
    if (!(method in inputs) || !Object.hasOwn(inputs, method))
      throw Error("Unknown method");
    const a: any = inputs[method as Method].parse(raw);
    switch (method) {
      case "dashboard": {
        if (!this.dashboardServer) {
          this.dashboardStarting ??= startDashboard(
            this.config,
            async (method, args) => {
              try {
                return await this.call(method, args);
              } catch (error) {
                throw Error(
                  this.sanitize(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
              }
            },
          );
          try {
            this.dashboardServer = await this.dashboardStarting;
          } finally {
            this.dashboardStarting = undefined;
          }
        }
        return {
          url: this.dashboardServer.url,
          scope: "This project's runtime; loopback only",
          capabilities: [
            "inspect definitions",
            "create definitions",
            "read task reports",
          ],
          limitations: [
            "no workflow runner",
            "no worker launch or permissions controls",
          ],
        };
      }
      case "doctor": {
        const bound = (x: unknown, max = 500) =>
          this.sanitize(String(x)).slice(0, max);
        return {
          configFile: bound(this.config.sourceFile),
          workspace: bound(this.config.root),
          stateDir: bound(this.config.stateDir),
          socket: bound(this.config.socket),
          daemon: {
            pid: process.pid,
            buildId,
            configDigest: this.config.configDigest,
            startedAt: this.startedAt,
            activeTaskIds: Object.values(this.store.state.tasks)
              .filter((t) => !terminal(t.status))
              .slice(-100)
              .map((t) => t.taskId),
          },
          runtime: {
            maxConcurrentTasks: this.config.runtime.maxConcurrentTasks,
            maxRuntimeMs: this.config.runtime.maxRuntimeMs,
            maxInlineChars: this.config.runtime.maxInlineChars,
            maxArtifactBytes: this.config.runtime.maxArtifactBytes,
          },
          providers: Object.fromEntries(
            Object.entries(this.config.providers).map(([id, p]) => [
              id,
              {
                command: bound(p.command),
                args: p.args.slice(0, 50).map((x) => bound(x)),
                configuredEnv: Object.keys(p.env)
                  .slice(0, 100)
                  .map((name) => bound(name, 200)),
                inheritedEnv: Object.fromEntries(
                  p.envNames
                    .slice(0, 100)
                    .map((name) => [
                      bound(name, 200),
                      process.env[name] !== undefined ? "set" : "unset",
                    ]),
                ),
                envPaths: p.envPaths
                  .slice(0, 100)
                  .map((name) => bound(name, 200)),
              },
            ]),
          ),
          agents: Object.fromEntries(
            Object.entries(this.config.agents).map(([id, a]) => [
              id,
              {
                provider: a.provider,
                agentConcurrency: agentConcurrency(this.config, id),
                workspace: a.workspace,
                sessionConfig: a.sessionConfig,
              },
            ]),
          ),
        };
      }
      case "define":
        return createTemplate(
          templateRoots(this.config.root),
          a.scope,
          a.definition,
        );
      case "templates": {
        const roots = templateRoots(this.config.root);
        if (a.agentSessionId) {
          if (a.reference || a.agentId)
            throw Error(
              "Inspect either a saved reference or a pinned conversation, not both",
            );
          const session = Object.values(this.store.state.sessions).find(
            (s) => s.agentSessionId === a.agentSessionId,
          );
          if (!session?.template)
            throw Error("Conversation has no saved agent definition");
          return {
            ...session.template,
            pinned: true,
            binding: validateTemplateBinding(
              session.template,
              this.config,
              session.agentId,
            ),
          };
        }
        if (!a.reference) {
          if (a.agentId)
            throw Error("Inspect a specific definition to preview its binding");
          return listTemplates(roots);
        }
        const definition = resolveTemplate(roots, a.reference);
        return {
          ...definition,
          binding: a.agentId
            ? validateTemplateBinding(definition, this.config, a.agentId)
            : undefined,
        };
      }
      case "specialists_schema":
        return {
          specialistSpec: {
            description:
              "Declarative data describing a specialization; it can restrict but never grant capabilities",
            required: {
              format: "literal 1",
              namespace:
                "lowercase letters, digits and hyphens; must match the <namespace>/<id> directory for persisted specialists",
              id: "lowercase letters, digits and hyphens; must match the directory name for persisted specialists",
              name: "display name, up to 80 characters",
              version: "semantic version such as 1.0.0",
              description: "up to 400 characters; used for catalog matching",
              instructions:
                "the specialist's behavior text, up to 12000 characters",
              delivery: "one of: task-instructions, system-append",
            },
            optional: {
              providers:
                "allowlist of provider names this specialist supports; incompatible bindings fail before launch",
              requiresReadOnly:
                "true requires a worker profile with provider-enforced read-only tools; instructions alone never satisfy this",
              acceptanceCriteria:
                "up to 20 output-contract checks merged before task criteria",
            },
            prohibited:
              "no commands, environment variables, credentials, executable tools, hooks, MCP servers, permission approvals, model or reasoning settings; those belong to worker profiles",
          },
          locations: {
            project: "<project>/.specialists/<namespace>/<id>/specialist.yaml",
            global: "~/.specialists/<namespace>/<id>/specialist.yaml",
            configured:
              "specialistCatalogs: { <name>: { path: <.specialists root> } } in agents.yaml; catalog.yaml is optional metadata only",
            inline:
              "a specialistSpec passed directly to specialists_validate or agents_run/agents_spawn for one-off use; nothing is written",
            reservedNames: ["project", "global", "inline"],
          },
          availableCatalogs: Object.fromEntries(
            Object.entries(catalogRoots(this.config)).slice(0, 50),
          ),
          execution:
            "agents_run and agents_spawn accept exactly one of template (legacy saved definition), specialistRef (persisted specialist) or specialistSpec (inline); conversations pin the resolved specialist digest",
        };
      case "specialists_validate": {
        if (a.agentId && !this.config.agents[a.agentId])
          throw Error("Unknown agent");
        const snapshot = inlineSpecialist(a.specialistSpec);
        const result: any = specialistMetadata(snapshot);
        if (a.agentId) {
          try {
            result.binding = validateSpecialistBinding(
              snapshot,
              this.config,
              a.agentId,
            );
          } catch (error) {
            result.bindingError =
              error instanceof Error ? error.message : String(error);
          }
        }
        return result;
      }
      case "specialists_catalog": {
        if (a.agentId && !this.config.agents[a.agentId])
          throw Error("Unknown agent");
        const binding = (snapshot: any) => {
          if (!a.agentId) return undefined;
          try {
            return {
              binding: validateSpecialistBinding(
                snapshot,
                this.config,
                a.agentId,
              ),
            };
          } catch (error) {
            return {
              bindingError:
                error instanceof Error ? error.message : String(error),
            };
          }
        };
        if (a.reference) {
          const snapshot = resolveSpecialist(this.config, a.reference);
          return { ...snapshot, ...binding(snapshot) };
        }
        let entries = listSpecialists(this.config) as any[];
        if (a.query) {
          const query = a.query.toLowerCase();
          entries = entries.filter(
            (entry) =>
              !entry.error &&
              [
                entry.reference,
                entry.namespace,
                entry.id,
                entry.name,
                entry.description,
              ].some((value) => String(value).toLowerCase().includes(query)),
          );
        }
        if (a.agentId)
          entries = entries.map((entry) =>
            entry.error ? entry : { ...entry, ...binding(entry) },
          );
        return entries;
      }
      case "list":
        return Object.entries(this.config.agents)
          .filter(([, agent]) => !agent.internal)
          .map(([agentId, agent]) => {
            const sessions = Object.values(this.store.state.sessions).filter(
              (s) => s.agentId === agentId,
            );
            const running = [...this.active.values()].filter(
              (r) => r.task.agentId === agentId,
            );
            const current =
              running.at(-1)?.task.agentSessionId ??
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
              configuredSession: agent.sessionConfig,
              available,
              executable: executable ?? null,
              missingDependencies,
              status: running.length
                ? "busy"
                : this.workerKeys(agentId).length
                  ? "ready"
                  : "registered",
              runningTasks: running.length,
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
                sessionConfig: s.sessionConfig,
                template: s.template ? templateMetadata(s.template) : undefined,
                specialist: s.specialistSnapshot
                  ? specialistMetadata(s.specialistSnapshot)
                  : undefined,
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
        if (a.verify && process.env.AGENT_BRIDGE_WORKER === "1")
          throw Error("Only the coordinator may supply verify");
        const agent = this.config.agents[a.agentId];
        if (!agent) throw Error("Unknown agent");
        if (
          [a.specialistRef, a.specialistSpec, a.template].filter(Boolean)
            .length > 1
        )
          throw Error(
            "Use exactly one of specialistRef (persisted specialist), specialistSpec (inline) or template (legacy saved definition)",
          );
        // Lab spike X4: resolve handoff inputs before any session/task state is created.
        const handoffPrompt = a.inputsFrom?.length
          ? buildHandoffPrompt(
              a.prompt,
              a.inputsFrom.map((i: { taskId: string; maxChars: number }) => {
                const src = this.store.state.tasks[i.taskId];
                if (!src) throw Error(`inputsFrom: unknown task ${i.taskId}`);
                if (src.status !== "completed")
                  throw Error(
                    `inputsFrom: task ${i.taskId} is ${src.status}, not completed`,
                  );
                return {
                  taskId: i.taskId,
                  status: src.status,
                  text: this.store.readArtifactText(i.taskId, "output.txt"),
                  maxChars: i.maxChars,
                };
              }),
            )
          : undefined;
        if (a.taskKey) {
          const previous = Object.values(this.store.state.tasks).find(
            (t) => t.agentId === a.agentId && t.taskKey === a.taskKey,
          );
          if (previous) return this.compact(previous);
        }
        for (const dependencyId of a.dependsOn ?? [])
          if (!Object.hasOwn(this.store.state.tasks, dependencyId))
            throw Error(`Unknown dependency: ${dependencyId}`);
        if (a.budgetLabel) {
          const budget = this.config.runtime.taskBudgets?.[a.budgetLabel];
          if (!budget)
            throw Error(`Unknown task budget label: ${a.budgetLabel}`);
          const used = Object.values(this.store.state.tasks).filter(
            (t) => t.budgetLabel === a.budgetLabel,
          ).length;
          if (used >= budget.maxTasks)
            throw Error(
              `Task budget ${a.budgetLabel} exhausted: maxTasks=${budget.maxTasks}`,
            );
        }
        if (
          Object.values(this.store.state.tasks).filter(
            (t) => !terminal(t.status),
          ).length >= 100
        )
          throw Error("Queue limit reached");
        if (a.parentTaskId) this.store.task(a.parentTaskId);
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
        // Quota policy changes scheduling, not the durable provider session.
        const { maxConcurrent: _maxConcurrent, ...sessionAgent } = agent;
        const fingerprintFor = (sessionAgent: unknown) =>
          createHash("sha256")
            .update(
              JSON.stringify({
                agent: sessionAgent,
                provider: this.config.providers[agent.provider],
              }),
            )
            .digest("hex");
        const fingerprint = fingerprintFor(sessionAgent);
        const savedFingerprint = s?.fingerprint;
        // The spike stored caps in fingerprints. Recognize only those legacy
        // hashes with identical session/provider settings and a valid old cap.
        if (
          s &&
          s.fingerprint !== fingerprint &&
          Array.from({ length: 16 }, (_, i) => i + 1).some(
            (maxConcurrent) =>
              savedFingerprint ===
              fingerprintFor({ ...sessionAgent, maxConcurrent }),
          )
        )
          s.fingerprint = fingerprint;
        if (s && s.fingerprint !== fingerprint)
          throw Error(
            "Provider/workspace configuration changed for durable conversation; start a fresh conversation",
          );
        if (
          s &&
          a.template &&
          (!s.template ||
            resolveTemplate(templateRoots(this.config.root), a.template)
              .digest !== s.template.digest)
        )
          throw Error(
            "Definition differs from the pinned conversation; omit template to continue it or start a fresh conversation",
          );
        if (
          s &&
          a.specialistRef &&
          (!s.specialistSnapshot ||
            resolveSpecialist(this.config, a.specialistRef).digest !==
              s.specialistSnapshot.digest)
        )
          throw Error(
            "Specialist differs from the pinned conversation; omit specialistRef to continue it or start a fresh conversation",
          );
        if (
          s &&
          a.specialistSpec &&
          (!s.specialistSnapshot ||
            inlineSpecialist(a.specialistSpec).digest !==
              s.specialistSnapshot.digest)
        )
          throw Error(
            "Specialist differs from the pinned conversation; omit specialistSpec to continue it or start a fresh conversation",
          );
        const definition =
          s?.template ??
          (a.template
            ? resolveTemplate(templateRoots(this.config.root), a.template)
            : undefined);
        const specialist =
          s?.specialistSnapshot ??
          (a.specialistRef
            ? resolveSpecialist(this.config, a.specialistRef)
            : a.specialistSpec
              ? inlineSpecialist(a.specialistSpec)
              : undefined);
        if (definition)
          validateTemplateBinding(definition, this.config, a.agentId);
        if (specialist)
          validateSpecialistBinding(specialist, this.config, a.agentId);
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
            template: definition,
            specialistSnapshot: specialist,
            workspace: selected,
            workspaceIdentity: identity,
            cwd: identity?.canonicalPath,
            sessionConfig: {
              requested: { ...agent.sessionConfig },
              effective: {},
            },
          };
        }
        const verifyInputs = a.verify
          ? snapshotVerifyInputs(await this.workspace(s))
          : undefined;
        const t: Task = {
          triggerId,
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
          dependsOn: a.dependsOn,
          labels: a.labels?.length ? [...new Set<string>(a.labels)] : undefined,
          parentTaskId: a.parentTaskId,
          budgetLabel: a.budgetLabel,
          description: this.sanitize(
            a.description ?? a.prompt.split("\n")[0],
          ).slice(0, 120),
          execution: a.execution,
          acceptanceCriteria: [
            ...(definition?.acceptanceCriteria ??
              specialist?.acceptanceCriteria ??
              []),
            ...a.acceptanceCriteria,
          ],
          provider: agent.provider,
          template: definition
            ? {
                id: definition.id,
                name: definition.name,
                version: definition.version,
                digest: definition.digest,
                scope: definition.scope,
                delivery: definition.delivery,
              }
            : undefined,
          specialist: specialist
            ? {
                reference: specialist.reference,
                namespace: specialist.namespace,
                id: specialist.id,
                name: specialist.name,
                version: specialist.version,
                digest: specialist.digest,
                catalog: specialist.catalog,
                delivery: specialist.delivery,
              }
            : undefined,
          verification: "pending",
          verify: a.verify,
          verifyInputs,
          followups: [],
          steeringCount: 0,
          sessionConfig: {
            requested: { ...agent.sessionConfig },
            effective: {},
          },
        };
        this.append(t, "prompt.txt", handoffPrompt ?? a.prompt);
        this.store.state.tasks[t.taskId] = t;
        this.store.event(t, "task.queued", "Queued");
        setImmediate(() => this.schedule());
        return this.compact(t);
      }
      case "wait": {
        const deadline = Date.now() + a.timeoutMs;
        if (!a.taskIds === !a.label)
          throw Error("Use exactly one of taskIds or label");
        while (true) {
          if (a.label) {
            const group = this.labelGroup(a.label);
            if (!group.total) throw Error("No tasks with this label");
            const timedOut = Date.now() >= deadline;
            if (group.open === 0 || timedOut)
              return {
                tasks: group.tasks.map((t) => this.lean(t)),
                timedOut,
                group: {
                  label: a.label,
                  total: group.total,
                  returned: group.tasks.length,
                  truncated: group.total > group.tasks.length,
                  byStatus: group.byStatus,
                },
              };
          } else {
            const tasks = a.taskIds.map((id: string) => this.store.task(id));
            if (
              tasks.some(
                (t: Task) =>
                  terminal(t.status) || t.status === "blocked_on_input",
              ) ||
              Date.now() >= deadline
            )
              return {
                tasks: tasks.map((t: Task) => this.lean(t)),
                timedOut: Date.now() >= deadline,
              };
          }
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
        const tasks = this.store.state.tasks;
        const events = this.store.state.events
          .filter((e) => e.cursor > a.afterCursor)
          .filter((e) => !a.label || tasks[e.taskId]?.labels?.includes(a.label))
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
            "verification.txt",
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
        const r = this.active.get(t.agentSessionId);
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
    const active = this.active.get(t.agentSessionId);
    if (!active) throw Error("Task is no longer active");
    if (active.remainingMs <= 0) {
      this.finish(t, "timed_out", "Runtime budget exceeded");
      this.interrupt(active);
      throw Error("Runtime budget exceeded");
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
    this.resume(active);
    this.store.event(t, "task.replied", "Reply accepted");
    q.resolve(result);
    return { accepted: true };
  }
  schedule() {
    if (this.closed) return;
    // Spawn only accepts existing tasks, so insertion order is topological.
    // Sweep failures even when every concurrency slot is occupied.
    for (const t of Object.values(this.store.state.tasks)) {
      if (t.status !== "queued") continue;
      const failed = t.dependsOn?.find((id) => {
        const dependency = this.store.state.tasks[id];
        return (
          !dependency ||
          (terminal(dependency.status) && dependency.status !== "completed") ||
          (dependency.verify && dependency.verification === "failed")
        );
      });
      if (failed) {
        const dependency = this.store.state.tasks[failed];
        const verification = dependency?.verify
          ? `; verification ${dependency.verification}: ${dependency.verificationResult?.reason ?? "pending"}`
          : "";
        this.finish(
          t,
          "failed",
          `Dependency ${failed} did not complete successfully (${dependency?.status ?? "missing"}${verification})`,
        );
      }
    }
    const waitingPermission = new Set(
      [...this.active.values()]
        .filter(
          (r) =>
            r.task.status === "blocked_on_input" &&
            r.task.question?.kind === "permission",
        )
        .map((r) => r.task.agentId),
    );
    for (const t of Object.values(this.store.state.tasks)) {
      if (this.active.size >= this.config.runtime.maxConcurrentTasks) break;
      const agentLimit = agentConcurrency(
        this.config,
        t.agentId,
      ).effectiveMaxConcurrent;
      const agentActive = [...this.active.values()].filter(
        (r) => r.task.agentId === t.agentId,
      ).length;
      // Unattended work may never consume the final slot reserved for interactive work.
      // With a concurrency limit of one, trigger tasks remain queued.
      if (
        t.triggerId &&
        this.active.size >= this.config.runtime.maxConcurrentTasks - 1
      )
        continue;
      // Only turns within one conversation serialize; they share a native session.
      if (
        t.status === "queued" &&
        (t.dependsOn ?? []).every((id) => this.dependencyReady(id)) &&
        agentActive < agentLimit &&
        !this.active.has(t.agentSessionId) &&
        !waitingPermission.has(t.agentId)
      )
        void this.run(t);
    }
  }
  pause(r?: Active) {
    if (!r?.timer || r.resumedAt === undefined) return;
    clearTimeout(r.timer);
    r.timer = undefined;
    r.remainingMs -= Date.now() - r.resumedAt;
    r.resumedAt = undefined;
  }
  resume(r?: Active) {
    if (!r || r.timer || terminal(r.task.status)) return;
    r.resumedAt = Date.now();
    if (r.remainingMs <= 0) {
      this.finish(r.task, "timed_out", "Runtime budget exceeded");
      this.interrupt(r);
      return;
    }
    r.timer = setTimeout(() => {
      this.finish(r.task, "timed_out", "Runtime budget exceeded");
      this.interrupt(r);
    }, r.remainingMs);
  }
  workerKeys(agentId: string) {
    return [...this.workers.keys()].filter(
      (key) =>
        Object.values(this.store.state.sessions).find(
          (s) => s.agentSessionId === key,
        )?.agentId === agentId,
    );
  }
  // Keep at most one idle process per profile, matching the former reuse footprint.
  evictIdle(agentId: string, keep: string) {
    for (const key of this.workerKeys(agentId)) {
      if (key === keep || this.active.has(key)) continue;
      this.workers.get(key)?.kill();
      this.workers.delete(key);
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
    this.triggers.taskFinished(t);
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
    setImmediate(() => this.schedule());
  }
  interrupt(r: Active) {
    r.verificationAbort?.abort();
    const s = this.session(r.task);
    if (r.worker && s.nativeSessionId) void r.worker.cancel(s.nativeSessionId);
    // Terminate immediately after sending best-effort cancel; do not reuse a possibly busy process.
    (r.worker ?? this.workers.get(r.task.agentSessionId))?.kill();
    this.workers.delete(r.task.agentSessionId);
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
      remainingMs: this.config.runtime.maxRuntimeMs,
      resumedAt: Date.now(),
      timer: setTimeout(() => {
        this.finish(t, "timed_out", "Runtime budget exceeded");
        this.interrupt(r);
      }, this.config.runtime.maxRuntimeMs),
    };
    this.active.set(t.agentSessionId, r);
    this.workerSessions.set(t.agentId, t.agentSessionId);
    t.status = "running";
    t.summary = "";
    t.startedAt = now();
    this.store.event(t, "task.started", "Starting worker");
    try {
      await Promise.race([this.execute(r), interrupted]);
    } catch (e) {
      // Worker completion precedes verification. An exception after completion
      // must settle the verdict so queued dependents cannot wait forever.
      if (
        this.store.task(t.taskId).status === "completed" &&
        t.verify &&
        t.verification === "pending"
      ) {
        t.verification = "failed";
        t.verificationResult = {
          exitCode: null,
          signal: null,
          reason: "error",
          outputRef: `artifact://${t.taskId}/output.txt`,
          outputTail: this.sanitize(String(e)).slice(
            -this.config.runtime.maxInlineChars,
          ),
        };
        this.store.event(
          t,
          "verification.failed",
          `Verification failed: error (${t.verificationResult.outputTail})`,
        );
      }
      this.finish(t, "failed", e instanceof Error ? e.message : String(e));
      (r.worker ?? this.workers.get(t.agentSessionId))?.kill();
      this.workers.delete(t.agentSessionId);
    } finally {
      clearTimeout(r.timer);
      this.active.delete(t.agentSessionId);
      this.evictIdle(t.agentId, t.agentSessionId);
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
    const key = s.agentSessionId;
    let w = this.workers.get(key);
    if (!w || w.dead) {
      this.evictIdle(t.agentId, key);
      // Late callbacks from a killed process must not reach a newer run of this conversation.
      const owner = () => {
        const active = this.active.get(key);
        return active && !worker.dead && active.worker === worker
          ? active
          : undefined;
      };
      const worker: Worker = new Worker(this.config, a.provider, cwd, {
        log: (text) => {
          const active = owner();
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
        update: (value) => {
          if (owner()) this.update(key, value);
        },
        question: async (kind, value) =>
          owner()
            ? this.question(key, kind, value)
            : kind === "input"
              ? { action: "decline" }
              : { outcome: { outcome: "cancelled" } },
        exit: () => {
          if (this.workers.get(key) !== r.worker) return;
          this.workers.delete(key);
          const active = this.active.get(key);
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
      w = worker;
      r.worker = w;
      this.workers.set(key, w);
      const init = await w.initialize();
      s.capabilities =
        (init.agentCapabilities as Record<string, unknown>) ?? {};
      verifyWorkspace(cwd, s.workspaceIdentity);
      const response = await w.session(
        cwd,
        s.nativeSessionId,
        (s.template ?? s.specialistSnapshot)?.delivery === "system-append"
          ? (s.template ?? s.specialistSnapshot)!.instructions
          : undefined,
      );
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
      const applied = await w.applySessionConfig(
        s.nativeSessionId!,
        a.sessionConfig,
        response,
      );
      s.sessionConfig ??= { requested: { ...a.sessionConfig }, effective: {} };
      s.sessionConfig.requested = { ...a.sessionConfig };
      s.sessionConfig.effective = applied.effective;
      if (response)
        s.models =
          discoverModels({
            ...response,
            configOptions: applied.configOptions,
          }) ?? s.models;
      this.store.save();
    }
    t.sessionConfig = {
      requested: { ...a.sessionConfig },
      effective: { ...(s.sessionConfig?.effective ?? {}) },
    };
    r.worker = w;
    t.modelId = (
      s.models as { currentModelId?: string } | undefined
    )?.currentModelId;
    let prompt = this.store.readArtifactText(t.taskId, "prompt.txt");
    const pinned = s.template ?? s.specialistSnapshot;
    const pinnedId = s.template
      ? s.template.id
      : s.specialistSnapshot
        ? `${s.specialistSnapshot.namespace}/${s.specialistSnapshot.id}`
        : undefined;
    if (pinned?.delivery === "task-instructions")
      prompt = `Saved agent instructions (${pinnedId}@${pinned.version}; user-task context, not a system prompt):\n${pinned.instructions}\n\nCurrent assignment:\n${prompt}`;
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
    if (t.verify) {
      clearTimeout(r.timer); // Verification has its own timeout, separate from worker runtime.
      r.verificationAbort = new AbortController();
      verifyWorkspace(cwd, s.workspaceIdentity);
      let inputsChanged = changedVerifyInputs(t.verifyInputs ?? {}, cwd);
      const result =
        inputsChanged.length && !t.verify.allowInputsChanged
          ? {
              passed: false,
              output: Buffer.from(
                "Verification inputs changed: " + inputsChanged.join(", "),
              ),
              exitCode: null,
              signal: null,
              reason: "tampered" as const,
            }
          : await verifyCommand(
              t.verify,
              cwd,
              Math.min(8192, this.config.runtime.maxArtifactBytes),
              r.verificationAbort.signal,
            );
      inputsChanged = [
        ...new Set([
          ...inputsChanged,
          ...changedVerifyInputs(t.verifyInputs ?? {}, cwd),
        ]),
      ];
      if (inputsChanged.length && !t.verify.allowInputsChanged) {
        result.passed = false;
        result.reason = "tampered";
      }
      const text = Buffer.from(
        this.sanitize(result.output.toString("utf8")),
      ).subarray(-Math.min(8192, this.config.runtime.maxArtifactBytes));
      // Store accepts strings; decode without expanding malformed UTF-8 past the budget.
      const output = text.toString("utf8").replace(/\uFFFD/g, "?");
      this.append(t, "verification.txt", output);
      t.verification = result.passed ? "passed" : "failed";
      t.verificationResult = {
        inputsChanged,
        exitCode: result.exitCode,
        signal: result.signal,
        reason: result.reason,
        outputRef: `artifact://${t.taskId}/verification.txt`,
        outputTail: output.slice(-this.config.runtime.maxInlineChars),
      };
      this.store.event(
        t,
        `verification.${t.verification}`,
        `Verification ${t.verification}: ${result.reason}`,
      );
    }
  }
  update(key: string, value: any) {
    const r = this.active.get(key);
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
    key: string,
    kind: "input" | "permission",
    request: any,
  ): Promise<any> {
    const t = this.active.get(key)?.task;
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
      this.config.agents[t.agentId].workspace === "read-only"
    )
      return declined;
    const questionId = uid("question");
    this.append(
      t,
      "transcript.jsonl",
      JSON.stringify({ type: "question", questionId, kind, request }) + "\n",
    );
    t.status = "blocked_on_input";
    const tool = request.toolCall;
    const toolInput = tool
      ? (tool.rawInput ??
        tool.input ??
        tool.command ??
        tool.arguments ??
        tool.content)
      : undefined;
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
      toolCall: tool
        ? {
            toolCallId:
              tool.toolCallId == null
                ? undefined
                : String(tool.toolCallId).slice(0, 200),
            title:
              tool.title == null
                ? undefined
                : this.sanitize(String(tool.title))
                    .replace(/[\x00-\x1f\x7f]/g, " ")
                    .slice(0, 240),
            kind:
              tool.kind == null ? undefined : String(tool.kind).slice(0, 40),
            input:
              toolInput == null
                ? undefined
                : this.sanitize(
                    typeof toolInput === "string"
                      ? toolInput
                      : JSON.stringify(toolInput),
                  )
                    .replace(/[\x00-\x1f\x7f]/g, " ")
                    .slice(0, 2000),
          }
        : undefined,
    };
    this.pause(this.active.get(key));
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
    clearInterval(this.triggerTimer);
    this.dashboardServer?.server.close();
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
