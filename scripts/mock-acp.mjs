// Deterministic protocol fixture. No model endpoints and no workspace writes.
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
const file = process.env.MOCK_STATE;
if (process.env.MOCK_PID_FILE)
  writeFileSync(process.env.MOCK_PID_FILE, String(process.pid));
const sessions = {};
const directories = {};
const sessionFile = (id) => `${file}-${id}.json`;
const save = (sessionId) => {
  if (file)
    writeFileSync(sessionFile(sessionId), JSON.stringify(sessions[sessionId]));
};
const cancelled = new Set();
const app = agent({ name: "bridge-mock", version: "1" });
app.onRequest("initialize", () => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: !process.argv.includes("--no-load") },
  authMethods: [],
  agentInfo: { name: "mock", version: "1" },
}));
app.onRequest("session/new", ({ params: { cwd } }) => {
  const sessionId = randomUUID();
  sessions[sessionId] = [];
  directories[sessionId] = cwd;
  save(sessionId);
  return {
    sessionId,
    models: {
      currentModelId: "deterministic",
      availableModels: [
        { modelId: "deterministic", name: "Deterministic fixture" },
      ],
    },
  };
});
app.onRequest(
  "session/load",
  async ({ params: { sessionId, cwd }, client }) => {
    directories[sessionId] = cwd;
    if (file && existsSync(sessionFile(sessionId)))
      sessions[sessionId] = JSON.parse(
        readFileSync(sessionFile(sessionId), "utf8"),
      );
    if (!sessions[sessionId]) throw Error("Unknown session");
    await client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "HISTORY REPLAY SHOULD NOT BE NEW OUTPUT",
        },
      },
    });
    return {};
  },
);
app.onNotification("session/cancel", ({ params: { sessionId } }) => {
  cancelled.add(sessionId);
});
app.onRequest(
  "session/prompt",
  async ({ params: { sessionId, prompt }, client: ctx }) => {
    const text = prompt
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n");
    sessions[sessionId].push(text);
    save(sessionId);
    const update = (text) =>
      ctx.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    if (text.includes("ERROROUTPUT")) {
      await update("Error: Execution failed: 400 fixture error");
      return { stopReason: "end_turn" };
    }
    await update("Working…\n");
    if (text.includes("TOOLS")) {
      await ctx.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read-1",
          title: "Read src/runtime.ts",
          kind: "read",
          locations: [{ path: process.cwd() + "/src/runtime.ts" }],
          status: "in_progress",
        },
      });
      await ctx.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "read-1",
          status: "completed",
        },
      });
      await ctx.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "PRIVATE_FIXTURE_THOUGHT" },
        },
      });
    }
    if (text.includes("STDERRBURST")) process.stderr.write("e".repeat(5000));
    if (text.includes("WORKSPACE"))
      await update(
        JSON.stringify({
          processCwd: process.cwd(),
          sessionCwd: directories[sessionId],
        }) + "\n",
      );
    if (text.includes("CRASH")) process.exit(7);
    if (text.includes("REFUSE")) return { stopReason: "refusal" };
    let reply;
    if (text.includes("ASK"))
      reply = await ctx.request("elicitation/create", {
        sessionId,
        mode: "form",
        message: "Which label should I use?",
        requestedSchema: {
          type: "object",
          properties: { message: { type: "string", title: "Reply" } },
          required: ["message"],
        },
      });
    if (text.includes("PERMISSION"))
      reply = await ctx.request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "write-1",
          title: "Write a file",
          kind: "edit",
          status: "pending",
        },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Reject", kind: "reject_once" },
        ],
      });
    for (let i = 0; i < (text.includes("SLOW") ? 100 : 3); i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (cancelled.delete(sessionId)) return { stopReason: "cancelled" };
    }
    await update(
      JSON.stringify({ history: sessions[sessionId], reply }) +
        (text.includes("LARGE") ? "x".repeat(24000) : ""),
    );
    return { stopReason: "end_turn" };
  },
);
app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
