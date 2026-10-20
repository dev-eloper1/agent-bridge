import { z } from "zod";
import { inputs } from "./runtime.js";
import { terminal } from "./store.js";
import { remote } from "./server.js";
import type { Config } from "./config.js";

export const runInput = inputs.spawn
  .partial()
  .extend({
    taskId: z
      .string()
      .regex(/^task_[a-f0-9-]{36}$/)
      .optional(),
    waitMs: z.number().int().min(0).max(45000).default(45000),
  })
  .strict();

// A bounded foreground call over the existing daemon API, not another task owner.
export async function runTask(
  config: Config,
  raw: unknown,
  signal: AbortSignal,
  progress: (text: string) => Promise<void> = async () => {},
) {
  const { taskId, waitMs, ...spawn } = runInput.parse(raw);
  if (taskId && Object.keys(spawn).length)
    throw Error("Continue with taskId alone; do not supply new task fields");
  if (!taskId && (!spawn.agentId || !spawn.prompt))
    throw Error("A new task requires agentId and prompt");
  if (spawn.execution === "background")
    throw Error("Use agents_spawn for explicit background work");
  if (signal.aborted) throw Error("Delegation cancelled");
  let task = taskId
    ? await remote(config, "status", { taskId })
    : await remote(config, "spawn", {
        ...spawn,
        workspace:
          spawn.workspace ??
          (spawn.agentSessionId ? undefined : { mode: "project" }),
        execution: "foreground",
      });
  const cancel = () => {
    void remote(config, "cancel", { taskId: task.taskId }).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    const deadline = Date.now() + waitMs;
    while (
      !terminal(task.status) &&
      task.status !== "blocked_on_input" &&
      !signal.aborted
    ) {
      await progress(
        `${task.description ?? task.agentId} · ${task.activity?.text ?? task.status}`,
      );
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const waited = await remote(config, "wait", {
        taskIds: [task.taskId],
        timeoutMs: Math.min(8000, remaining),
      });
      task = waited.tasks[0];
    }
    if (signal.aborted) {
      await remote(config, "cancel", { taskId: task.taskId });
      throw Error("Delegation cancelled");
    }
    const result = await remote(config, "result", {
      taskId: task.taskId,
      maxChars: config.runtime.maxInlineChars,
    });
    return {
      ...result,
      waitExpired:
        !terminal(result.status) &&
        result.status !== "blocked_on_input" &&
        Date.now() >= deadline,
    };
  } catch (error) {
    if (!terminal(task.status))
      await remote(config, "cancel", { taskId: task.taskId }).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
