import { test, expect, mock } from "claude-code/testing";
function setup(on) {
  const submitted = [],
    opened = [],
    events = [],
    notices = [],
    focused = [],
    invalidated = [],
    statuses = [];
  const publicOutput = "PUBLIC_START\n" + "x".repeat(2100) + "\nPUBLIC_END";
  const task = {
    taskId: "task_123",
    agentId: "devin-worker",
    agentSessionId: "conversation_devin",
    workerName: "devin-review-repository",
    description: "Review repository",
    execution: "background",
    status: "queued",
    cwd: "/tmp/plugin-fixture",
    createdAt: new Date().toISOString(),
    summary: "REPORT_TAIL",
    activity: {
      text: "Read src/runtime.ts",
      timestamp: new Date().toISOString(),
    },
    recentActivity: [
      {
        toolCallId: "read-1",
        title: "Read src/runtime.ts",
        status: "in_progress",
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const allTasks = [task];
  const dispatches = [task];
  const outputs = new Map();
  const composer = { text: "", cursor: 0 };
  const gates = new Map();
  const requests = [];
  mock.store(on);
  mock.env(on, {});
  const clock = mock.clock(on);
  on("session.id", () => ({ value: "test-session" }));
  on("session.start", () => ({ cwd: "/tmp/plugin-fixture" }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("ui.status", (_, e) => {
    statuses.push(e);
    return { value: undefined };
  });
  on("prompt.read", () => ({ value: { ...composer } }));
  on("prompt.edit", (_, e) => {
    composer.text =
      e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end);
    composer.cursor = e.start + e.inputText.length;
    return { value: { ...composer } };
  });
  on("ui.open", (_, e) => {
    opened.push(e);
    return { value: undefined };
  });
  on("ui.close", () => ({ value: undefined }));
  on("ui.notice", (_, e) => {
    notices.push(e);
    return { value: undefined };
  });
  on("ui.invalidate", (_, e) => {
    invalidated.push(e);
    return { value: undefined };
  });
  on("ui.focus", (_, e) => {
    focused.push(e);
    return { value: undefined };
  });
  on("process.run", () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({ socket: "/tmp/test-bridge.sock" }),
      stderr: "",
    },
  }));
  on("http.fetch", async (_, e) => {
    const request = JSON.parse(e.body ?? e.init?.body);
    requests.push(request);
    let result;
    if (request.method === "list")
      result = [...new Set(allTasks.map((t) => t.agentId))].map((agentId) => ({
        agentId,
        available: true,
        status: "ready",
        activeTasks: allTasks.filter(
          (t) =>
            t.agentId === agentId &&
            !["completed", "cancelled", "failed", "timed_out"].includes(
              t.status,
            ),
        ),
      }));
    if (request.method === "events")
      result = {
        events: events.filter((x) => x.cursor > request.args.afterCursor),
        nextCursor: events.at(-1)?.cursor ?? 0,
      };
    if (request.method === "status")
      result = allTasks.find((t) => t.taskId === request.args.taskId);
    if (request.method === "artifact") {
      const gate = gates.get(request.args.ref);
      if (gate) {
        gate.started?.();
        await (gate.wait ?? gate);
      }
      const output = outputs.get(request.args.ref) ?? publicOutput;
      const offset = request.args.offset;
      const end = Math.min(offset + request.args.limit, output.length);
      result = {
        text: output.slice(offset, end),
        offset,
        nextOffset: end,
        totalBytes: output.length,
        eof: end >= output.length,
      };
    }
    if (request.method === "cancel") {
      result = allTasks.find((t) => t.taskId === request.args.taskId);
      result.status = "cancelled";
    }
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ result }),
      },
    };
  });
  on("prompt.submit", (_, e) => {
    submitted.push(e.text);
    return { text: e.text };
  });
  on("tool.check", () => ({ decision: "allow" }));
  for (const name of ["spawn", "result", "run"])
    on(
      "tool.call",
      { tool: `mcp__plugin_agent-bridge_workers__agents_${name}` },
      (_, e) => {
        if (name === "run") {
          task.execution = "foreground";
          task.status = "completed";
          task.taskKey = e.taskKey;
        }
        const selected = name === "spawn" ? (dispatches.shift() ?? task) : task;
        return { result: [{ type: "text", text: JSON.stringify(selected) }] };
      },
    );
  return {
    clock,
    submitted,
    opened,
    events,
    task,
    notices,
    allTasks,
    dispatches,
    outputs,
    focused,
    invalidated,
    statuses,
    composer,
    gates,
    requests,
  };
}
async function start($) {
  await $.session.start({
    cwd: "/tmp/plugin-fixture",
    surface: "terminal",
    isInteractive: true,
  });
}
async function paneText($) {
  const pane = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "Pane",
    requestId: "external-workers",
    props: {
      title: "Delegated tasks",
      isFocused: false,
      bodyColumns: 80,
      placement: "inline",
      scroll: {},
      view: {},
    },
  });
  const text =
    (await pane.findAll({ type: "Text" })).map((e) => e.text).join("\n") +
    "\n" +
    ((await pane.find({ type: "Markdown" }))?.props.text ?? "");
  await pane.unmount();
  return text;
}
function complete(env) {
  env.task.status = "completed";
  env.events.push({
    eventId: "evt_1",
    cursor: 1,
    taskId: "task_123",
    agentId: "devin-worker",
    type: "task.completed",
    summary: "CHOPPED_REPORT_FRAGMENT",
    requiresReply: false,
  });
}

test("background completion notifies once without reopening the worker pane or copying report fragments", async ($, on) => {
  const env = setup(on);
  await start($);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  expect(env.opened.length).toBe(1);
  complete(env);
  await env.clock.advance(2100);
  await env.clock.settle();
  expect(env.submitted.length).toBe(1);
  expect(env.submitted[0]).toContain("task_123");
  expect(env.submitted[0]).not.toContain("CHOPPED_REPORT_FRAGMENT");
  await env.clock.advance(2100);
  expect(env.submitted.length).toBe(1);
});
test("Mod does not wake this session for another session's task", async ($, on) => {
  const env = setup(on);
  await start($);
  env.events.push({
    eventId: "evt_other",
    cursor: 1,
    taskId: "other-task",
    agentId: "pi-reviewer",
    type: "task.completed",
    summary: "Other session",
  });
  await env.clock.advance(2100);
  expect(env.submitted.length).toBe(0);
});
test("foreground result returns through the tool with no pane or completion prompt", async ($, on) => {
  const env = setup(on);
  await start($);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_run",
    agentId: "devin-worker",
    prompt: "review",
    description: "Review repository",
  });
  expect(env.task.taskKey).toContain("claude-");
  complete(env);
  await env.clock.advance(2100);
  await env.clock.settle();
  expect(env.submitted.length).toBe(0);
  expect(env.opened.length).toBe(0);
});
test("retrieving a background result suppresses its later completion notification", async ($, on) => {
  const env = setup(on);
  await start($);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  complete(env);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_result",
    taskId: "task_123",
  });
  await env.clock.advance(2100);
  await env.clock.settle();
  expect(env.submitted.length).toBe(0);
});
test("numbered optional inspector reads public output from the start and supports next/previous pages", async ($, on) => {
  const env = setup(on);
  env.task.status = "completed";
  await start($);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const overview = await $.command.run({ command: "workers", args: "" });
  expect(overview.text).toContain(
    "devin-review-repository · Review repository",
  );
  expect(overview.text).not.toContain("task_123");
  await $.command.run({ command: "workers", args: "1" });
  const first = await paneText($);
  expect(first).toContain("PUBLIC_START");
  expect(first).toContain("Read src/runtime.ts");
  expect(first).not.toContain("REPORT_TAIL");
  await $.command.run({ command: "workers", args: "next" });
  expect(await paneText($)).toContain("PUBLIC_END");
  await $.command.run({ command: "workers", args: "prev" });
  expect(await paneText($)).toContain("PUBLIC_START");
  await $.command.run({ command: "workers", args: "cancel" });
  expect(env.task.status).toBe("cancelled");
  await $.command.run({ command: "workers", args: "close" });
});

test("interrupting the parent turn cancels foreground work between bounded waits", async ($, on) => {
  const env = setup(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));
  await start($);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_run",
    agentId: "devin-worker",
    prompt: "review",
  });
  env.task.status = "running";
  await env.clock.advance(2100);
  await env.clock.settle();
  await $.turn.complete({
    reason: "aborted",
    answer: "",
    durationMs: 1,
    isAborted: true,
    turnId: "cancel-test",
  });
  expect(env.task.status).toBe("cancelled");
  expect(env.submitted.length).toBe(0);
});

test("automatic inline activity shows actual tools and files, preserves other band content, and disappears on completion", async ($, on) => {
  const env = setup(on);
  on("ui.render", { component: "AbovePrompt" }, () => ({
    type: "Text",
    children: ["OTHER_BAND_CONTENT"],
  }));
  await start($);
  env.task.status = "running";
  env.task.recentActivity[0].title = "read";
  env.task.recentActivity[0].paths = ["src/store.ts"];
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const band = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "worker-live-band",
    props: {
      hasSurvey: false,
      isWorking: true,
      maxRows: 6,
      bodyColumns: 90,
      scroll: {},
      view: {},
    },
  });
  const text = (await band.find({ type: "Text", text: /read/ }))?.text ?? "";
  expect(text).toContain("read");
  expect(text).toContain("src/store.ts");
  expect(text).not.toContain("task_123");
  expect(
    (await band.find({ type: "Text", text: "OTHER_BAND_CONTENT" }))?.text,
  ).toBe("OTHER_BAND_CONTENT");
  expect(env.opened.length).toBe(1);
  complete(env);
  await env.clock.advance(2100);
  await env.clock.settle();
  await band.unmount();
  const finished = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "worker-finished-band",
    props: {
      hasSurvey: false,
      isWorking: true,
      maxRows: 6,
      bodyColumns: 90,
      scroll: {},
      view: {},
    },
  });
  expect(
    await finished.find({ type: "Text", text: /devin-review-repository/ }),
  ).toBeUndefined();
  await finished.unmount();
});
test("inline activity yields to a survey", async ($, on) => {
  const env = setup(on);
  on("ui.render", { component: "AbovePrompt" }, () => ({
    type: "Text",
    children: ["SURVEY"],
  }));
  await start($);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const band = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "survey-band",
    props: {
      hasSurvey: true,
      isWorking: true,
      maxRows: 6,
      bodyColumns: 90,
      scroll: {},
      view: {},
    },
  });
  expect((await band.find({ type: "Text" }))?.text).toBe("SURVEY");
  await band.unmount();
});

test("live pane uses native Markdown and controls, follows new output, and can pause for report paging", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "running";
  env.task.summary = "## Live findings\n- Reading **store.ts**";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await $.command.run({ command: "workers", args: "watch" });
  const target = {
    plugin: "agent-bridge",
    surface: "terminal",
    component: "Pane",
    requestId: "external-workers",
    props: {
      title: "Delegated tasks",
      isFocused: true,
      bodyColumns: 38,
      placement: "inline",
      scroll: {},
      view: {},
    },
  };
  const pane = await $.ui.mount(target);
  expect((await pane.find({ type: "Markdown" }))?.props.text).toContain(
    "## Live findings",
  );
  expect(
    (await pane.find({ type: "Text", text: /following live/ }))?.props.bold,
  ).toBe(true);
  expect(
    await pane.find({ type: "Button", key: "workers-pause" }),
  ).toBeDefined();
  expect(await pane.find({ type: "Text", text: /bytes/ })).toBeUndefined();
  expect(
    await pane.find({ type: "Text", text: /artifact:\/\// }),
  ).toBeUndefined();
  env.task.summary =
    "## New live update\n- Finished inspecting the artifact code.";
  await env.clock.advance(2100);
  await env.clock.settle();
  await pane.unmount();
  const updated = await $.ui.mount(target);
  expect((await updated.find({ type: "Markdown" }))?.props.text).toContain(
    "New live update",
  );
  await updated.press({ key: "workers-pause" });
  await updated.unmount();
  const paused = await $.ui.mount(target);
  expect((await paused.find({ type: "Markdown" }))?.props.text).toContain(
    "PUBLIC_START",
  );
  expect(
    await paused.find({ type: "Button", key: "workers-watch" }),
  ).toBeDefined();
  await paused.press({ key: "workers-next" });
  await paused.unmount();
  const next = await $.ui.mount(target);
  expect((await next.find({ type: "Markdown" }))?.props.text).toContain(
    "PUBLIC_END",
  );
  await next.unmount();
});

test("active workers open once without stealing focus, and a person can reopen output from the band", async ($, on) => {
  const env = setup(on);
  on("ui.render", { component: "AbovePrompt" }, () => ({
    type: "Text",
    children: ["ENGINE_BAND"],
  }));
  await start($);
  env.task.status = "running";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  expect(env.opened.length).toBe(1);
  expect(env.opened[0].focus).toBeUndefined();
  expect(await paneText($)).toContain("Read src/runtime.ts");
  await $.command.run({ command: "workers", args: "close" });
  await env.clock.advance(4100);
  await env.clock.settle();
  expect(env.opened.length).toBe(1);
  const band = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "open-worker-band",
    props: {
      hasSurvey: false,
      isWorking: true,
      maxRows: 2,
      bodyColumns: 38,
      scroll: {},
      view: {},
    },
  });
  expect(
    await band.find({ type: "Button", key: "worker-open-output" }),
  ).toBeDefined();
  await band.press({ key: "worker-open-output" });
  expect(env.opened.length).toBe(2);
  expect(env.opened[1].focus).toBe(true);
  await band.press({ key: "worker-open-devin-review-repository" });
  expect(await paneText($)).toContain("REPORT_TAIL");
  await band.unmount();
  complete(env);
  await env.clock.advance(2100);
  await env.clock.settle();
  expect(await paneText($)).toContain("PUBLIC_START");
  const finished = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "completed-output-band",
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 2,
      bodyColumns: 38,
      scroll: {},
      view: {},
    },
  });
  expect(
    await finished.find({ type: "Button", key: "worker-open-output" }),
  ).toBeUndefined();
  await $.command.run({ command: "workers", args: "devin-review-repository" });
  expect(await paneText($)).toContain("PUBLIC_START");
  await finished.unmount();
});

test("finished worker status does not claim test success and multiline commands stay compact", async ($, on) => {
  const env = setup(on);
  env.task.status = "completed";
  env.task.recentActivity = [
    {
      toolCallId: "test-failure",
      title: "node --test\nPRIVATE_LONG_COMMAND_BODY",
      status: "failed",
      timestamp: new Date().toISOString(),
    },
  ];
  await start($);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await $.command.run({ command: "workers", args: "1" });
  const text = await paneText($);
  expect(text).toContain("Worker finished");
  expect(text).toContain("Completion does not confirm tests passed.");
  expect(text).toContain("Recent activity includes a failed tool call.");
  expect(text).toContain("node --test…");
  expect(text).not.toContain("PRIVATE_LONG_COMMAND_BODY");
});

test("two workers can be selected independently and cancelling one preserves the other", async ($, on) => {
  const env = setup(on);
  on("ui.render", { component: "AbovePrompt" }, () => ({
    type: "Text",
    children: ["ENGINE_BAND"],
  }));
  await start($);
  env.task.status = "running";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await $.command.run({ command: "workers", args: "pause" });
  const second = {
    ...env.task,
    taskId: "task_456",
    agentId: "pi-reviewer",
    agentSessionId: "conversation_pi",
    workerName: "pi-check-documentation",
    description: "Check documentation",
    createdAt: new Date(Date.now() + 1000).toISOString(),
  };
  env.allTasks.push(second);
  env.dispatches.push(second);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const band = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "two-worker-band",
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 3,
      bodyColumns: 65,
      scroll: {},
      view: {},
    },
  });
  const headings = (await band.findAll({ type: "Button" }))
    .map((e) => e.props.label)
    .join("\n");
  expect(headings).toContain("devin-review-repository");
  expect(headings).toContain("pi-check-documentation");
  expect(
    (await band.find({ type: "Button", key: "worker-open-output" }))?.props
      .label,
  ).toBe("All workers (2) · 2 active");
  // A new task must not replace the report the person paused to read.
  expect(await paneText($)).toContain("devin · Review repository");
  await band.press({ key: "worker-open-output" });
  await band.unmount();
  const choices = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "Pane",
    requestId: "external-workers",
    props: {
      title: "Workers",
      isFocused: true,
      bodyColumns: 65,
      placement: "inline",
      scroll: {},
      view: {},
    },
  });
  expect(
    await choices.find({
      type: "Button",
      key: "workers-pi-check-documentation",
    }),
  ).toBeDefined();
  expect(
    await choices.find({
      type: "Button",
      key: "workers-devin-review-repository",
    }),
  ).toBeDefined();
  await choices.unmount();
  const overview = await $.command.run({ command: "workers", args: "" });
  expect(overview.text).toContain(
    "pi-check-documentation · Check documentation",
  );
  expect(overview.text).toContain(
    "devin-review-repository · Review repository",
  );
  await $.command.run({ command: "workers", args: "pi-check-documentation" });
  expect(await paneText($)).toContain("pi · Check documentation");
  await $.command.run({ command: "workers", args: "cancel" });
  expect(second.status).toBe("cancelled");
  expect(env.task.status).toBe("running");
  await $.command.run({ command: "workers", args: "watch" });
  expect(await paneText($)).toContain("devin · Review repository");
});

test("conversation names stay stable across follow-ups and history opens the correct earlier report", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  env.outputs.set("artifact://task_123/output.txt", "ORIGINAL_REVIEW_REPORT");
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const followup = {
    ...env.task,
    taskId: "task_followup",
    description: "Explain finding two",
    summary: "FOLLOWUP_REPORT",
  };
  env.allTasks.push(followup);
  env.dispatches.push(followup);
  env.outputs.set("artifact://task_followup/output.txt", "FOLLOWUP_REPORT");
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const overview = await $.command.run({ command: "workers", args: "" });
  expect(overview.text).toContain(
    "devin-review-repository · Explain finding two · finished · 2 tasks",
  );
  await $.command.run({ command: "workers", args: "devin-review-repository" });
  expect(await paneText($)).toContain("FOLLOWUP_REPORT");
  await $.command.run({ command: "workers", args: "history" });
  const history = await $.ui.mount({
    plugin: "agent-bridge",
    surface: "terminal",
    component: "Pane",
    requestId: "external-workers",
    props: {
      title: "Worker history",
      isFocused: true,
      bodyColumns: 60,
      placement: "inline",
      scroll: {},
      view: {},
    },
  });
  expect(
    await history.find({
      type: "Button",
      key: "workers-devin-review-repository/1",
    }),
  ).toBeDefined();
  expect(
    await history.find({
      type: "Button",
      key: "workers-devin-review-repository/2",
    }),
  ).toBeDefined();
  await history.press({ key: "workers-devin-review-repository/1" });
  await history.unmount();
  const original = await paneText($);
  expect(original).toContain("ORIGINAL_REVIEW_REPORT");
  expect(original).not.toContain("FOLLOWUP_REPORT");
  expect(original).toContain("Task 1 of 2");
});

test("completed conversations survive more than five workers and same-session UI reload", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  env.outputs.set("artifact://task_123/output.txt", "OLDEST_REPORT");
  for (let i = 2; i <= 8; i++) {
    const task = {
      ...env.task,
      taskId: "task_" + i,
      agentSessionId: "conversation_" + i,
      workerName: "devin-review-repository-" + i,
      description: "Other review " + i,
    };
    env.allTasks.push(task);
    env.dispatches.push(task);
    await $.tool.call({
      tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
      input: {},
    });
  }
  await start($); // Same persisted Claude session, module's task cache reset.
  const overview = await $.command.run({ command: "workers", args: "" });
  expect(overview.text).toContain(
    "devin-review-repository · Review repository",
  );
  expect(overview.text).toContain("devin-review-repository-8 · Other review 8");
  await $.command.run({ command: "workers", args: "devin-review-repository" });
  expect(await paneText($)).toContain("OLDEST_REPORT");
  await $.command.run({ command: "workers", args: "1" });
  expect(await paneText($)).toContain("OLDEST_REPORT");
});

async function mountInspector($, width = 65, surface = "terminal") {
  return $.ui.mount({
    plugin: "agent-bridge",
    surface,
    component: "Pane",
    requestId: "external-workers",
    props: {
      title: "Workers",
      isFocused: true,
      bodyColumns: width,
      placement: "inline",
      scroll: {},
      view: {},
    },
  });
}
async function dispatch($, env, task) {
  env.allTasks.push(task);
  env.dispatches.push(task);
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
}

test("persistent worker picker switches directly and restores each report page across overview and reload", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const second = {
    ...env.task,
    taskId: "task_second",
    agentId: "pi-reviewer",
    agentSessionId: "conversation_second",
    workerName: "pi-documentation",
    description: "Check documentation",
  };
  await dispatch($, env, second);
  await $.command.run({ command: "workers", args: "devin-review-repository" });
  await $.command.run({ command: "workers", args: "next" });
  expect(await paneText($)).toContain("PUBLIC_END");
  const devin = await mountInspector($, 38);
  expect(
    (await devin.find({ type: "Select", key: "worker-switch" }))?.props.options
      .length,
  ).toBe(3);
  await devin.select({ key: "worker-switch", value: "pi-documentation" });
  await devin.unmount();
  expect(await paneText($)).toContain("PUBLIC_START");
  const pi = await mountInspector($, 38);
  await pi.select({ key: "worker-switch", value: "devin-review-repository" });
  await pi.unmount();
  expect(await paneText($)).toContain("PUBLIC_END");
  await $.command.run({ command: "workers", args: "" });
  const board = await mountInspector($);
  expect(
    await board.find({ type: "Input", key: "worker-filter" }),
  ).toBeDefined();
  await board.select({
    key: "worker-switch",
    value: "devin-review-repository",
  });
  await board.unmount();
  expect(await paneText($)).toContain("PUBLIC_END");
  await start($);
  expect(await paneText($)).toContain("PUBLIC_END");
});

test("task picker preserves older report position and new follow-ups never replace it", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await $.command.run({ command: "workers", args: "devin-review-repository" });
  await $.command.run({ command: "workers", args: "next" });
  const next = {
    ...env.task,
    taskId: "task_new_turn",
    status: "running",
    description: "Follow-up investigation",
    summary: "NEW_TURN_LIVE",
  };
  await dispatch($, env, next);
  expect(await paneText($)).toContain("PUBLIC_END");
  const first = await mountInspector($);
  expect(
    (await first.find({ type: "Select", key: "task-switch" }))?.props.options
      .length,
  ).toBe(2);
  await first.select({ key: "task-switch", value: "task_new_turn" });
  await first.unmount();
  expect(await paneText($)).toContain("NEW_TURN_LIVE");
  const followup = await mountInspector($);
  await followup.select({ key: "task-switch", value: "task_123" });
  await followup.unmount();
  expect(await paneText($)).toContain("PUBLIC_END");
  expect(await paneText($)).not.toContain("NEW_TURN_LIVE");
});

test("overview exposes work previews and attention counts; search never hides workers from the persistent picker", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  env.task.summary = "Finished reviewing retry cleanup";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await dispatch($, env, {
    ...env.task,
    taskId: "task_permission",
    agentSessionId: "conversation_permission",
    workerName: "devin-authentication",
    status: "blocked_on_input",
    description: "Authentication fix",
    question: { summary: "Allow reading a fixture?" },
  });
  await $.command.run({ command: "workers", args: "" });
  const board = await mountInspector($);
  const text = (await board.findAll({ type: "Text" }))
    .map((e) => e.text)
    .join("\n");
  expect(text.replace(/ +/g, " ")).toContain(
    "2 workers · 0 active · 1 needs input · 1 finished",
  );
  expect(text).toContain("Finished reviewing retry cleanup");
  expect(text).toContain("Allow reading a fixture?");
  expect(
    await board.find({ type: "Button", key: "workers-attention" }),
  ).toBeDefined();
  await board.input({
    key: "worker-filter",
    text: "authentication",
    kind: "change",
  });
  await board.unmount();
  const filtered = await mountInspector($);
  expect(
    await filtered.find({
      type: "Button",
      key: "workers-devin-authentication",
    }),
  ).toBeDefined();
  expect(
    await filtered.find({
      type: "Button",
      key: "workers-devin-review-repository",
    }),
  ).toBeUndefined();
  expect(
    (await filtered.find({ type: "Select", key: "worker-switch" }))?.props
      .options.length,
  ).toBe(3);
  await filtered.select({
    key: "worker-switch",
    value: "devin-review-repository",
  });
  await filtered.unmount();
  expect(await paneText($)).toContain("PUBLIC_START");
  const detail = await mountInspector($);
  await detail.press({ key: "workers-next-worker" });
  await detail.unmount();
  expect(await paneText($)).toContain("Authentication fix");
  expect(env.task.status).toBe("completed");
});

test("mobile retains worker/history buttons when native selectors are unavailable", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await $.command.run({ command: "workers", args: "" });
  const board = await mountInspector($, 38, "mobile");
  expect(await board.find({ type: "Input" })).toBeUndefined();
  expect(await board.find({ type: "Select" })).toBeUndefined();
  await board.press({ key: "workers-devin-review-repository" });
  await board.unmount();
  const report = await mountInspector($, 38, "mobile");
  expect(await report.find({ type: "Markdown" })).toBeDefined();
  expect(
    await report.find({ type: "Button", key: "workers-history" }),
  ).toBeDefined();
  await report.unmount();
});

test("navigation frames, status colors and spaced report headings remain native and actionable at narrow widths", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await dispatch($, env, {
    ...env.task,
    taskId: "task_failed",
    agentSessionId: "conversation_failed",
    workerName: "devin-failure",
    status: "failed",
    description: "Failure investigation",
  });
  await dispatch($, env, {
    ...env.task,
    taskId: "task_waiting",
    agentSessionId: "conversation_waiting",
    workerName: "devin-waiting",
    status: "blocked_on_input",
    description: "Pending approval",
    question: { summary: "Allow fixture inspection?" },
  });
  await $.command.run({ command: "workers", args: "" });
  const board = await mountInspector($, 38);
  expect(
    (await board.find({ type: "Box", key: "worker-navigation" }))?.props
      .borderColor,
  ).toBe("cyan");
  expect(
    (await board.find({ type: "Box", key: "worker-card-devin-failure" }))?.props
      .borderColor,
  ).toBe("red");
  expect(
    (await board.find({ type: "Text", text: "× failed" }))?.props.color,
  ).toBe("red");
  expect(
    (await board.find({ type: "Text", text: "◆ needs input" }))?.props.color,
  ).toBe("yellow");
  expect(
    (await board.find({ type: "Text", text: "✓ finished" }))?.props.color,
  ).toBeUndefined();
  const options = (await board.find({ type: "Select", key: "worker-switch" }))
    ?.props.options;
  expect(
    options.find((option) => option.value === "devin-failure").label,
  ).toContain("×");
  await board.select({
    key: "worker-switch",
    value: "devin-review-repository",
  });
  await board.unmount();
  const report = await mountInspector($, 38);
  expect(
    (await report.find({ type: "Box", key: "worker-actions" }))?.props
      .borderStyle,
  ).toBe("single");
  expect(
    (await report.find({ type: "Text", text: /RECENT ACTIVITY/ }))?.props.color,
  ).toBe("cyan");
  expect(
    (await report.find({ type: "Text", text: /Report · page 1/ }))?.props.bold,
  ).toBe(true);
  expect(await report.find({ type: "Markdown" })).toBeDefined();
  await report.press({ key: "workers-next" });
  await report.unmount();
  expect(await paneText($)).toContain("PUBLIC_END");
});

test("report navigation focuses reading controls and Back preserves page state", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await $.command.run({ command: "workers", args: "1" });
  const report = await mountInspector($);
  expect(
    (await report.find({ type: "Select", key: "worker-switch" }))?.props
      .autoFocus,
  ).not.toBe(true);
  expect(
    (await report.find({ type: "Button", key: "workers-back" }))?.props
      .autoFocus,
  ).toBe(true);
  expect(
    await report.find({ type: "Box", key: "report-controls" }),
  ).toBeDefined();
  await report.press({ key: "workers-next" });
  await report.unmount();
  expect(await paneText($)).toContain("PUBLIC_END");
  await $.command.run({ command: "workers", args: "history" });
  await $.command.run({ command: "workers", args: "back" });
  expect(await paneText($)).toContain("PUBLIC_END");
  await $.command.run({ command: "workers", args: "back" });
  expect(await paneText($)).toContain("Select a worker");
  await $.command.run({ command: "workers", args: "1" });
  expect(await paneText($)).toContain("PUBLIC_END");
  expect(env.opened.at(-1)?.closeOnEscape).toBeUndefined();
});

test("stale mounted report buttons cannot page another worker", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await dispatch($, env, {
    ...env.task,
    taskId: "task_other",
    agentSessionId: "conversation_other",
    workerName: "pi-other",
    agentId: "pi-reviewer",
  });
  await $.command.run({ command: "workers", args: "1" });
  const old = await mountInspector($);
  await $.command.run({ command: "workers", args: "pi-other" });
  await old.press({ key: "workers-next" });
  await old.unmount();
  expect(await paneText($)).toContain("PUBLIC_START");
  expect(await paneText($)).not.toContain("PUBLIC_END");
});

test("idle workers leave the composer quiet and active controls yield to slash drafts", async ($, on) => {
  const env = setup(on);
  on("ui.render", { component: "AbovePrompt" }, () => ({
    type: "Text",
    children: ["OTHER_BAND_CONTENT"],
  }));
  await start($);
  env.task.status = "running";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const mountBand = () =>
    $.ui.mount({
      plugin: "agent-bridge",
      surface: "terminal",
      component: "AbovePrompt",
      requestId: "worker-live-band",
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 6,
        bodyColumns: 90,
        scroll: {},
        view: {},
      },
    });
  let band = await mountBand();
  expect(
    await band.find({ type: "Button", key: "worker-open-output" }),
  ).toBeDefined();
  await band.unmount();
  env.composer.text = "/relo";
  env.composer.cursor = 5;
  band = await mountBand();
  expect(
    await band.find({ type: "Button", key: "worker-open-output" }),
  ).toBeUndefined();
  expect(env.composer.text).toBe("/relo");
  await band.unmount();
  env.composer.text = "";
  env.composer.cursor = 0;
  env.task.status = "completed";
  await env.clock.advance(2100);
  await env.clock.settle();
  band = await mountBand();
  expect(
    await band.find({ type: "Button", key: "worker-open-output" }),
  ).toBeUndefined();
  expect(env.statuses.at(-1)?.text).toBeUndefined();
  await band.unmount();
  await $.command.run({ command: "workers", args: "1" });
  expect(await paneText($)).toContain("PUBLIC_START");
});

test("closing during a slow report read does not reopen the pane", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  await $.command.run({ command: "workers", args: "1" });
  let release, began;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    began = resolve;
  });
  env.gates.set("artifact://task_123/output.txt", { wait, started: began });
  const opening = $.command.run({ command: "workers", args: "1" });
  await started;
  await $.command.run({ command: "workers", args: "close" });
  const count = env.opened.length;
  release();
  await opening;
  expect(env.opened.length).toBe(count);
});

test("a delayed poll cannot replace the newly selected worker report", async ($, on) => {
  const env = setup(on);
  await start($);
  env.task.status = "completed";
  await $.tool.call({
    tool: "mcp__plugin_agent-bridge_workers__agents_spawn",
    input: {},
  });
  const other = {
    ...env.task,
    taskId: "task_other",
    agentSessionId: "conversation_other",
    workerName: "pi-other",
    agentId: "pi-reviewer",
  };
  await dispatch($, env, other);
  env.outputs.set("artifact://task_other/output.txt", "OTHER_WORKER_REPORT");
  await $.command.run({ command: "workers", args: "1" });
  let release, began;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    began = resolve;
  });
  env.gates.set("artifact://task_123/output.txt", { wait, started: began });
  await env.clock.advance(2100);
  await started;
  await $.command.run({ command: "workers", args: "pi-other" });
  expect(await paneText($)).toContain("OTHER_WORKER_REPORT");
  release();
  await env.clock.settle();
  expect(await paneText($)).toContain("OTHER_WORKER_REPORT");
  expect(await paneText($)).not.toContain("PUBLIC_START");
});
