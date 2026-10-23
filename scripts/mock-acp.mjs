// Deterministic protocol fixture. No model endpoints and no workspace writes.
import { agent, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { Readable, Writable } from "node:stream";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
const file = process.env.MOCK_STATE;
if (process.env.MOCK_PID_FILE)
  writeFileSync(process.env.MOCK_PID_FILE, String(process.pid));
const sessions = {};
const directories = {};
const systems = {};
const configs = {};
const legacyModes = process.argv.includes("--legacy-modes");
const ignoreConfigUpdate = process.argv.includes("--ignore-config-update");
let clientBooleanConfig = false;
const sessionFile = (id) => `${file}-${id}.json`;
const configFile = (id) => `${sessionFile(id)}.config`;
const save = (sessionId) => {
  if (file)
    writeFileSync(sessionFile(sessionId), JSON.stringify(sessions[sessionId]));
  if (file && configs[sessionId])
    writeFileSync(configFile(sessionId), JSON.stringify(configs[sessionId]));
};
const defaults = () => ({
  applied: [],
  modeId: "ask",
  options: [
    {
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: "ask",
      options: [
        { value: "ask", name: "Ask" },
        { value: "bypass", name: "Bypass" },
      ],
    },
    {
      id: "review",
      name: "Review",
      type: "select",
      currentValue: "off",
      options: [
        {
          group: "g1",
          name: "Levels",
          options: [
            { value: "off", name: "Off" },
            { value: "strict", name: "Strict" },
          ],
        },
      ],
    },
    ...(clientBooleanConfig
      ? [
          {
            id: "telemetry",
            name: "Telemetry",
            type: "boolean",
            currentValue: false,
          },
        ]
      : []),
  ],
});
const configFor = (sessionId) => {
  if (!configs[sessionId]) {
    configs[sessionId] =
      file && existsSync(configFile(sessionId))
        ? JSON.parse(readFileSync(configFile(sessionId), "utf8"))
        : defaults();
    if (!clientBooleanConfig)
      configs[sessionId].options = configs[sessionId].options.filter(
        (o) => o.type !== "boolean",
      );
  }
  return configs[sessionId];
};
const modeOf = (sessionId) =>
  configFor(sessionId).options.find((o) => o.id === "mode")?.currentValue ??
  configFor(sessionId).modeId;
const configState = (sessionId) => {
  const c = configFor(sessionId);
  return legacyModes
    ? {
        modes: {
          currentModeId: c.modeId,
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "bypass", name: "Bypass" },
          ],
        },
      }
    : { configOptions: c.options };
};
const cancelled = new Set();
const app = agent({ name: "bridge-mock", version: "1" });
app.onRequest("initialize", ({ params }) => {
  clientBooleanConfig = Boolean(
    params?.clientCapabilities?.session?.configOptions?.boolean,
  );
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: !process.argv.includes("--no-load"),
      ...(process.argv.includes("--system-prompt")
        ? { sessionCapabilities: { systemPrompt: {} } }
        : {}),
    },
    authMethods: [],
    agentInfo: { name: "mock", version: "1" },
  };
});
app.onRequest("session/new", ({ params: { cwd, systemPrompt } }) => {
  const sessionId = randomUUID();
  sessions[sessionId] = [];
  directories[sessionId] = cwd;
  systems[sessionId] = systemPrompt;
  if (file && systemPrompt)
    writeFileSync(
      sessionFile(sessionId) + ".system",
      JSON.stringify(systemPrompt),
    );
  save(sessionId);
  return {
    sessionId,
    ...configState(sessionId),
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
  async ({ params: { sessionId, cwd, systemPrompt }, client }) => {
    systems[sessionId] = systemPrompt;
    if (file && systemPrompt)
      writeFileSync(
        sessionFile(sessionId) + ".system",
        JSON.stringify(systemPrompt),
      );
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
    return { ...configState(sessionId) };
  },
);
app.onRequest("session/set_config_option", ({ params }) => {
  const { sessionId, configId, value } = params;
  const c = configFor(sessionId);
  const option = c.options.find((o) => o.id === configId);
  if (!option) throw Error(`Unknown config option: ${configId}`);
  const advertised = (option.options ?? []).flatMap((x) =>
    Array.isArray(x.options) ? x.options.map((y) => y.value) : [x.value],
  );
  if (option.type === "boolean") {
    if (typeof value !== "boolean")
      throw Error(`Config option ${configId} expects a boolean`);
  } else if (!advertised.includes(value))
    throw Error(`Config option ${configId} rejects value: ${value}`);
  if (!ignoreConfigUpdate) {
    option.currentValue = value;
    c.applied.push({ configId, value });
    save(sessionId);
  }
  return { configOptions: c.options };
});
app.onRequest("session/set_mode", ({ params }) => {
  const { sessionId, modeId } = params;
  const c = configFor(sessionId);
  if (!["ask", "bypass"].includes(modeId))
    throw Error(`Unknown mode: ${modeId}`);
  c.modeId = modeId;
  c.applied.push({ modeId });
  const mode = c.options.find((o) => o.id === "mode");
  if (mode) mode.currentValue = modeId;
  save(sessionId);
  return {};
});
app.onNotification("session/cancel", ({ params: { sessionId } }) => {
  cancelled.add(sessionId);
});
app.onRequest(
  "session/prompt",
  async ({ params: { sessionId, prompt }, client: ctx }) => {
    if (file)
      writeFileSync(
        `${file}-prompt-count`,
        String(
          (existsSync(`${file}-prompt-count`)
            ? Number(readFileSync(`${file}-prompt-count`, "utf8"))
            : 0) + 1,
        ),
      );
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
    if (text.includes("CHECKSYSTEM"))
      await update(JSON.stringify({ systemPrompt: systems[sessionId] }));
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
    if (text.includes("PERMISSION") && modeOf(sessionId) !== "bypass")
      reply = await ctx.request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "write-1",
          title: "Write a file",
          kind: "edit",
          status: "pending",
          rawInput: {
            command: "write",
            path: process.cwd() + "/out.txt",
            secret: process.env.MOCK_TOOL_SECRET,
            padding: "P".repeat(3200),
          },
        },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          {
            optionId: "session",
            name: "Allow session",
            kind: "allow_always",
          },
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
