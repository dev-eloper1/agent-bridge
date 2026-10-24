import { z } from "zod";
import type { Config } from "./config.js";
import { terminal, uid, type Store, type Task } from "./store.js";
import { workspaceInput, resolveWorkspace } from "./workspaces.js";

export const MIN_INTERVAL_MS = 1000;
export const MAX_TRIGGERS = 32;
export const GLOBAL_MAX_FIRES = 20;
export const GLOBAL_WINDOW_MS = 3600000;
export const triggerInput = z
  .object({
    kind: z.enum(["timer", "event"]),
    intervalMs: z
      .number()
      .int()
      .min(MIN_INTERVAL_MS)
      .max(365 * 86400000)
      .optional(),
    agentId: z.string().min(1).max(64),
    prompt: z.string().trim().min(1).max(16000),
    workspace: workspaceInput,
    overlap: z.literal("skip").default("skip"),
    maxFires: z.number().int().min(1).max(1000).default(6),
    windowMs: z.number().int().min(1000).max(86400000).default(3600000),
    maxConsecutiveFailures: z.number().int().min(1).max(10).default(3),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.kind === "timer") !== (v.intervalMs !== undefined))
      ctx.addIssue({
        code: "custom",
        message: "Only timer triggers require intervalMs",
      });
  });
export const storedTrigger = z.object({
  id: z.string(),
  definition: triggerInput,
  enabled: z.boolean(),
  nextAt: z.number().finite().optional(),
  lastTaskId: z.string().optional(),
  seen: z.array(z.string()),
  skipped: z.number().int().nonnegative(),
  lastOutcome: z.enum(["spawned", "skipped", "error"]).optional(),
  lastError: z.string().optional(),
  fires: z.array(z.number().finite()).default([]),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  lastSettledTaskId: z.string().optional(),
  disabledReason: z.string().optional(),
  lastSkipReason: z
    .enum(["overlap", "trigger_fire_cap", "global_fire_cap"])
    .optional(),
});
export type Trigger = z.infer<typeof storedTrigger>;

// Runtime-owned registry; state shares the existing atomic Store snapshot.
export class TriggerRegistry {
  private pending = new Set<string>();
  constructor(
    private store: Store,
    private config: Config,
    private spawn: (args: unknown, triggerId: string) => Promise<unknown>,
    private clock: () => number,
    private closed: () => boolean,
  ) {
    this.store.state.triggers ??= {};
    this.store.state.triggerBudget ??= { fires: [] };
    // Migrate queued tasks from the original spike before scheduling resumes.
    for (const t of Object.values(this.records)) {
      const task = t.lastTaskId && this.store.state.tasks[t.lastTaskId];
      if (task) task.triggerId ??= t.id;
    }
  }
  private get records() {
    return this.store.state.triggers!;
  }
  private get(id: string) {
    if (!Object.hasOwn(this.records, id)) throw Error("Unknown trigger");
    const t = this.records[id];
    return t;
  }
  list() {
    return structuredClone(Object.values(this.records));
  }
  create(raw: unknown) {
    if (this.closed()) throw Error("Runtime closed");
    const definition = triggerInput.parse(raw);
    if (!Object.hasOwn(this.config.agents, definition.agentId))
      throw Error("Unknown agent");
    definition.workspace = resolveWorkspace(
      definition.workspace,
      this.config.root,
    );
    if (Object.keys(this.records).length >= MAX_TRIGGERS)
      throw Error("Trigger limit reached");
    const t: Trigger = {
      id: uid("trigger"),
      definition,
      enabled: true,
      seen: [],
      skipped: 0,
      fires: [],
      consecutiveFailures: 0,
      nextAt:
        definition.kind === "timer"
          ? this.clock() + definition.intervalMs!
          : undefined,
    };
    this.records[t.id] = t;
    this.store.save();
    return structuredClone(t);
  }
  disable(id: string) {
    this.get(id).enabled = false;
    this.store.save();
  }
  delete(id: string) {
    this.get(id);
    delete this.records[id];
    this.store.save();
  }
  async fireEvent(id: string, eventId: string) {
    const t = this.get(id);
    if (t.definition.kind !== "event") throw Error("Not an event trigger");
    z.string().min(1).max(200).parse(eventId);
    if (!t.enabled || this.closed()) return { outcome: "disabled" };
    if (t.seen.includes(eventId)) return { outcome: "duplicate" };
    // Fail closed at a bounded dedupe budget; never evict IDs and permit replay.
    if (t.seen.length >= 10000) throw Error("Event dedupe limit reached");
    t.seen.push(eventId);
    this.store.save();
    return this.fire(t);
  }
  async tick() {
    if (this.closed()) return;
    const now = this.clock();
    for (const t of Object.values(this.records)) {
      if (this.closed()) return;
      if (!t.enabled || t.definition.kind !== "timer" || t.nextAt! > now)
        continue;
      // Consume all missed intervals with at most one fire, including on reload.
      t.nextAt = now + t.definition.intervalMs!;
      this.store.save();
      await this.fire(t);
    }
  }
  taskFinished(task: Task) {
    if (
      !task.triggerId ||
      !Object.hasOwn(this.records, task.triggerId) ||
      !terminal(task.status)
    )
      return;
    const t = this.records[task.triggerId];
    if (t.lastSettledTaskId === task.taskId) return;
    t.lastSettledTaskId = task.taskId;
    if (task.status === "completed") t.consecutiveFailures = 0;
    else this.failed(t);
    this.store.save();
  }
  private failed(t: Trigger) {
    t.consecutiveFailures++;
    if (t.consecutiveFailures >= t.definition.maxConsecutiveFailures) {
      t.enabled = false;
      t.disabledReason = `consecutive_failures:${t.consecutiveFailures}`;
    }
  }
  private skip(t: Trigger, reason: NonNullable<Trigger["lastSkipReason"]>) {
    t.skipped++;
    t.lastOutcome = "skipped";
    t.lastSkipReason = reason;
    this.store.save();
    return { outcome: "skipped", reason };
  }
  private async fire(t: Trigger) {
    const previous = t.lastTaskId && this.store.state.tasks[t.lastTaskId];
    if (this.pending.has(t.id) || (previous && !terminal(previous.status))) {
      return this.skip(t, "overlap");
    }
    const now = this.clock();
    // Keep future timestamps on backward clock changes: fail conservatively.
    t.fires = t.fires.filter((at) => at > now - t.definition.windowMs);
    const budget = this.store.state.triggerBudget!;
    budget.fires = budget.fires.filter((at) => at > now - GLOBAL_WINDOW_MS);
    if (t.fires.length >= t.definition.maxFires)
      return this.skip(t, "trigger_fire_cap");
    if (budget.fires.length >= GLOBAL_MAX_FIRES)
      return this.skip(t, "global_fire_cap");
    // Reserve synchronously, before awaiting spawn, so concurrent fires cannot exceed caps.
    t.fires.push(now);
    budget.fires.push(now);
    this.store.save();
    this.pending.add(t.id);
    try {
      const task = (await this.spawn(
        {
          agentId: t.definition.agentId,
          prompt: t.definition.prompt,
          workspace: t.definition.workspace,
        },
        t.id,
      )) as { taskId: string };
      t.lastTaskId = task.taskId;
      t.lastOutcome = "spawned";
      delete t.lastError;
      delete t.lastSkipReason;
      this.store.save();
      return { outcome: "spawned", taskId: task.taskId };
    } catch (error) {
      this.failed(t);
      t.lastOutcome = "error";
      t.lastError = String(error).slice(0, 500);
      this.store.save();
      return { outcome: "error" };
    } finally {
      this.pending.delete(t.id);
    }
  }
}
