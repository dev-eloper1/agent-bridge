import {
  mkdirSync,
  existsSync,
  readFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  lstatSync,
  realpathSync,
  constants,
  fstatSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createStorage, JsonStorage, type StoragePort } from "./storage.js";
import type { VerifySpec, VerificationResult } from "./verify-verdict.js";
import type { Workspace, WorkspaceIdentity } from "./workspaces.js";
import { z } from "zod";
import { storedTrigger, type Trigger } from "./triggers.js";
import { templateSnapshot, type TemplateSnapshot } from "./templates.js";
import { specialistSnapshot, type SpecialistSnapshot } from "./specialists.js";
export const uid = (prefix: string) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export type Status =
  | "queued"
  | "running"
  | "blocked_on_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";
export const terminal = (s: Status) =>
  ["completed", "failed", "cancelled", "timed_out"].includes(s);
export interface SessionConfigState {
  requested: Record<string, string | boolean>;
  effective: Record<string, string | boolean>;
}
export interface Session {
  agentSessionId: string;
  workerName?: string;
  agentId: string;
  nativeSessionId?: string;
  cwd?: string;
  workspace?: Workspace;
  workspaceIdentity?: WorkspaceIdentity;
  capabilities?: Record<string, unknown>;
  models?: unknown;
  recovery?: string;
  fingerprint: string;
  template?: TemplateSnapshot;
  specialistSnapshot?: SpecialistSnapshot;
  sessionConfig?: SessionConfigState;
}
export interface Task {
  triggerId?: string;
  taskId: string;
  agentId: string;
  agentSessionId: string;
  workerName?: string;
  workspace?: Workspace;
  cwd?: string;
  status: Status;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary: string;
  taskKey?: string;
  dependsOn?: string[];
  labels?: string[];
  parentTaskId?: string;
  budgetLabel?: string;
  description?: string;
  execution?: "foreground" | "background";
  acceptanceCriteria: string[];
  verification: "pending" | "passed" | "failed";
  verify?: VerifySpec;
  verifyInputs?: Record<string, string>;
  verificationResult?: VerificationResult;
  template?: {
    id: string;
    name: string;
    version: string;
    digest: string;
    scope: string;
    delivery: string;
  };
  specialist?: {
    reference: string;
    namespace: string;
    id: string;
    name: string;
    version: string;
    digest: string;
    catalog: string;
    delivery: string;
  };
  provider?: string;
  modelId?: string;
  usage?: { used?: number; size?: number; cost?: unknown; attribution: string };
  question?: {
    artifactRef: string;
    questionId: string;
    kind: "input" | "permission";
    summary: string;
    options?: { optionId: string; kind: string; name: string }[];
    toolCall?: {
      toolCallId?: string;
      title?: string;
      kind?: string;
      input?: string;
    };
  };
  sessionConfig?: SessionConfigState;
  followups: string[];
  steeringCount: number;
  stopReason?: string;
  activity?: { text: string; timestamp: string };
  recentActivity?: {
    toolCallId: string;
    title: string;
    kind?: string;
    status: string;
    timestamp: string;
    paths?: string[];
  }[];
}
export interface Event {
  eventId: string;
  cursor: number;
  taskId: string;
  agentId: string;
  type: string;
  timestamp: string;
  summary: string;
  requiresReply: boolean;
  artifactRefs: string[];
}
export interface State {
  triggerBudget?: { fires: number[] };
  triggers?: Record<string, Trigger>;
  version: 1;
  tasks: Record<string, Task>;
  sessions: Record<string, Session>;
  events: Event[];
}
const storedTask = z
  .object({
    taskId: z.string(),
    agentId: z.string(),
    agentSessionId: z.string(),
    workerName: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    status: z.enum([
      "queued",
      "running",
      "blocked_on_input",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
    ]),
    dependsOn: z
      .array(z.string().regex(/^task_[a-f0-9-]{36}$/))
      .max(100)
      .optional(),
    createdAt: z.string(),
    summary: z.string(),
    acceptanceCriteria: z.array(z.string()),
    verification: z.enum(["pending", "passed", "failed"]),
    followups: z.array(z.string()),
    steeringCount: z.number().int().nonnegative(),
    // persisted lineage fields must match the API shape.
    labels: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,47}$/))
      .max(8)
      .optional(),
    parentTaskId: z
      .string()
      .regex(/^task_[a-f0-9-]{36}$/)
      .optional(),
  })
  .passthrough()
  .refine((t) => t.parentTaskId !== t.taskId, "task cannot be its own parent");
const storedState = z
  .object({
    version: z.literal(1),
    triggers: z.record(storedTrigger).optional(),
    triggerBudget: z.object({ fires: z.array(z.number().finite()) }).optional(),
    tasks: z.record(storedTask),
    sessions: z.record(
      z
        .object({
          agentSessionId: z.string(),
          workerName: z
            .string()
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
            .optional(),
          agentId: z.string(),
          fingerprint: z.string(),
          template: templateSnapshot.optional(),
          specialistSnapshot: specialistSnapshot.optional(),
          workspaceIdentity: z
            .object({
              canonicalPath: z.string(),
              device: z.string(),
              inode: z.string(),
            })
            .optional(),
        })
        .passthrough(),
    ),
    events: z.array(
      z
        .object({
          eventId: z.string(),
          cursor: z.number().int().positive(),
          taskId: z.string(),
          agentId: z.string(),
          type: z.string(),
          timestamp: z.string(),
          summary: z.string(),
          requiresReply: z.boolean(),
          artifactRefs: z.array(z.string()),
        })
        .passthrough(),
    ),
  })
  .passthrough()
  .superRefine((s, ctx) => {
    for (const [key, task] of Object.entries(s.tasks))
      if (
        key !== task.taskId ||
        !Object.values(s.sessions).some(
          (session) =>
            session.agentSessionId === task.agentSessionId &&
            session.agentId === task.agentId,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid task/conversation mapping",
        });
    if (
      s.events.some(
        (event, i) => event.cursor !== i + 1 || !s.tasks[event.taskId],
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid event sequence or task reference",
      });
  });
export class Store {
  state: State;
  readonly artifactRoot: string;
  private readonly storage: StoragePort;
  constructor(
    readonly dir: string,
    readonly maxBytes: number,
  ) {
    mkdirSync(path.join(dir, "artifacts"), { recursive: true, mode: 0o700 });
    if (lstatSync(path.join(dir, "artifacts")).isSymbolicLink())
      throw Error("Unsafe artifact directory: symlink");
    this.artifactRoot = realpathSync(path.join(dir, "artifacts"));
    this.storage = createStorage(dir);
    try {
      let loaded = this.storage.load();
      const legacy = new JsonStorage(dir);
      if (
        loaded === undefined &&
        this.storage.file !== legacy.file &&
        existsSync(legacy.file)
      ) {
        const imported = storedState.parse(legacy.load()) as State;
        this.storage.persist(imported);
        loaded = imported;
      }
      this.state =
        loaded === undefined
          ? { version: 1, tasks: {}, sessions: {}, events: [] }
          : (storedState.parse(loaded) as State);
      // A committed database is authoritative after an interrupted migration.
      if (this.storage.file !== legacy.file && existsSync(legacy.file)) {
        const backup = legacy.file + ".bak";
        renameSync(
          legacy.file,
          existsSync(backup) ? backup + "." + randomUUID() : backup,
        );
        const fd = openSync(dir, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } catch (error) {
      this.storage.close();
      throw Error(
        `Invalid Agent Bridge state: ${this.storage.file}. Original file preserved; restore a valid backup or inspect it before restarting.`,
        { cause: error },
      );
    }
  }
  get file() {
    return this.storage.file;
  }
  save() {
    this.storage.persist(this.state);
  }
  readEventsSince(sequence: number) {
    return this.storage.readEventsSince(sequence);
  }
  close() {
    this.storage.close();
  }
  artifactPath(taskId: string, name: string) {
    if (
      !/^task_[a-f0-9-]{36}$/.test(taskId) ||
      !/^[a-z-]+\.(txt|jsonl|patch)$/.test(name)
    )
      throw Error("Invalid artifact reference");
    this.checkArtifactDirectory(this.artifactRoot);
    const dir = path.join(this.artifactRoot, taskId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.checkArtifactDirectory(dir);
    const file = path.join(dir, name);
    try {
      if (lstatSync(file).isSymbolicLink())
        throw Error("Unsafe artifact file: symlink");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return file;
  }
  private checkArtifactDirectory(directory: string) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(directory) !== directory
    )
      throw Error("Unsafe artifact directory: symlink or replacement");
  }
  private openArtifact(taskId: string, name: string, append = false) {
    const file = this.artifactPath(taskId, name);
    const fd = openSync(
      file,
      constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (append
          ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
          : constants.O_RDONLY),
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw Error("Unsafe artifact file: not a private regular file");
      this.checkArtifactDirectory(this.artifactRoot);
      this.checkArtifactDirectory(path.dirname(file));
      return { fd, size: stat.size };
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }
  artifactSize(taskId: string, name: string): number | undefined {
    try {
      const { fd, size } = this.openArtifact(taskId, name);
      closeSync(fd);
      return size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  readArtifact(taskId: string, name: string, offset: number, limit: number) {
    const { fd, size } = this.openArtifact(taskId, name);
    try {
      const length = Math.max(0, Math.min(limit, size - offset));
      const bytes = Buffer.alloc(length);
      const read = readSync(fd, bytes, 0, length, offset);
      return {
        text: bytes.subarray(0, read).toString("utf8"),
        offset,
        nextOffset: offset + read,
        totalBytes: size,
        eof: offset + read >= size,
        unit: "bytes; UTF-8 chunks may split code points",
      };
    } finally {
      closeSync(fd);
    }
  }
  readArtifactText(taskId: string, name: string) {
    const { fd, size } = this.openArtifact(taskId, name);
    try {
      if (size > this.maxBytes) throw Error("Artifact byte budget exceeded");
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  append(taskId: string, name: string, text: string) {
    const { fd, size } = this.openArtifact(taskId, name, true);
    try {
      if (size + Buffer.byteLength(text) > this.maxBytes)
        throw Error("Artifact byte budget exceeded");
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
  }
  event(t: Task, type: string, summary: string, requiresReply = false) {
    this.state.events.push({
      eventId: uid("evt"),
      cursor: this.state.events.length + 1,
      taskId: t.taskId,
      agentId: t.agentId,
      type,
      timestamp: now(),
      summary: summary.slice(0, 240),
      requiresReply,
      artifactRefs: [`artifact://${t.taskId}/transcript.jsonl`],
    });
    this.save();
  }
  task(taskId: string) {
    const t = this.state.tasks[taskId];
    if (!t) throw Error("Unknown task");
    return t;
  }
}
