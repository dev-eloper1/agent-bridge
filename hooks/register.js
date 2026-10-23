// Claude Mod UI and notifications. Task execution stays in the daemon.
let socket, key, timer;
let state = { cursor: 0, owned: [], pending: [], handled: [], modes: {} };
let tasks = {},
  roster = [],
  inFlight = {},
  outputPage;
let navigationQueue = Promise.resolve(),
  sessionEpoch = 0,
  navigationGeneration = 0,
  outputSequence = 0;
let paneFocus = "reader",
  composerHasDraft = false;
let polling = false,
  flushing = false,
  interactive = false;
let workspaceCwd,
  settingsData,
  settingsLoading = false,
  settingsError,
  settingsActionError,
  settingsNotice,
  settingsChoicePages = {},
  questionDrafts = {},
  questionErrors = {};
const MAX_NATIVE_SELECT_OPTIONS = 64;
const SETTINGS_CHOICE_PAGE_SIZE = 60;
const terminal = (s) =>
  ["completed", "failed", "cancelled", "timed_out"].includes(s);
function plain(value, max = 500) {
  return String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .slice(0, max);
}
function provider(t) {
  return (t.agentId ?? "worker").replace(/-(worker|reviewer)$/, "");
}
function title(t) {
  return `${provider(t)} · ${plain(t.description ?? "Delegated task", 90)}`;
}
function activityLabel(task) {
  if (task.status === "blocked_on_input") return "Needs input";
  if (task.status === "queued") return "Queued";
  if (task.activity?.text === "Writing public response")
    return "Preparing result";
  const tool = task.recentActivity?.at(-1);
  if (!tool) return "Working";
  if (tool.status === "completed" || tool.status === "failed")
    return "Reviewing results";
  return (
    {
      read: "Reading files",
      search: "Searching files",
      execute: "Running a command",
      edit: "Editing files",
      fetch: "Fetching information",
    }[tool.kind] ?? "Using tools"
  );
}
function toolLine(tool) {
  const source = plain(tool.title, 1000);
  const firstLine = source.split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  const label =
    firstLine.slice(0, 100) +
    (source.includes("\n") || firstLine.length > 100 ? "…" : "");
  const paths = (tool.paths ?? [])
    .filter((p) => !label.includes(p))
    .slice(0, 2);
  const status =
    {
      in_progress: "running",
      pending: "starting",
      completed: "done",
      failed: "failed",
    }[tool.status] ?? tool.status;
  return `${status} · ${label}${paths.length ? " · " + paths.join(", ") : ""}`;
}
function liveActivityLines(maxRows = 6) {
  const active = workerRows()
    .filter((row) => !terminal(row.task.status))
    .map((row) => row.task);
  const limit = Math.max(0, Math.min(6, maxRows));
  if (!limit) return [];
  if (!active.length) {
    return Object.values(inFlight).some((p) => !p.taskId || !tasks[p.taskId])
      ? ["Delegated worker · Starting…"]
      : [];
  }
  // Give every visible worker a heading before spending space on tool details.
  const shown = active.slice(0, Math.min(2, limit));
  const lines = shown.map((task) => {
    const seconds = task.startedAt
      ? Math.max(
          0,
          Math.floor((Date.now() - Date.parse(task.startedAt)) / 1000),
        )
      : 0;
    const name = workerFor(task)?.name ?? task.workerName ?? provider(task);
    return `${name} · ${activityLabel(task)}${seconds ? " · " + seconds + "s" : ""}`;
  });
  for (const task of shown) {
    if (lines.length >= limit) break;
    const recent = (task.recentActivity ?? []).slice(
      shown.length > 1 ? -1 : -2,
    );
    const details = recent.length
      ? recent.map((tool) => "  " + toolLine(tool))
      : ["  Waiting for provider tool updates…"];
    lines.push(...details.slice(0, limit - lines.length));
  }
  return lines;
}
// Names identify persistent conversations. Slots preserve numeric shortcuts too.
function rememberWorkers() {
  const slots = (state.workerSlots ??= []);
  for (const id of state.owned) {
    const task = tasks[id];
    if (!task) continue;
    const identity = task.agentId + ":" + (task.agentSessionId ?? task.taskId);
    let slot = slots.find((s) => s.key === identity || s.taskIds.includes(id));
    if (!slot) slots.push((slot = { key: identity, taskIds: [] }));
    // A foreground task can be observed before its full status arrives.
    if (task.agentSessionId) slot.key = identity;
    if (task.workerName) slot.name = task.workerName;
    if (
      !slot.name ||
      slot.name === `${provider(task)}-${slots.indexOf(slot) + 1}`
    ) {
      const base = `${provider(task)}-${task.description ?? "task"}`
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 60)
        .replace(/-$/, "");
      let name = base;
      for (
        let n = 2;
        slots.some((other) => other !== slot && other.name === name);
        n++
      )
        name = `${base}-${n}`;
      slot.name = name;
    }
    if (!slot.taskIds.includes(id)) slot.taskIds.push(id);
  }
}
function visibleTasks() {
  return state.owned.map((id) => tasks[id]).filter(Boolean);
}
function workerRows() {
  rememberWorkers();
  return state.workerSlots
    .map((slot, index) => {
      const history = slot.taskIds.map((id) => tasks[id]).filter(Boolean);
      const task =
        history.findLast((t) => !terminal(t.status) && t.status !== "queued") ??
        history.findLast((t) => t.status === "queued") ??
        history.at(-1);
      return { ...slot, number: index + 1, history, task };
    })
    .filter((row) => row.task);
}
function workerFor(task) {
  return workerRows().find((row) => row.taskIds.includes(task.taskId));
}
function workerLabel(row) {
  return `${row.name} · ${plain(row.task.description ?? "Delegated task", 90)} · ${statusLabel(row.task)}${row.taskIds.length > 1 ? " · " + row.taskIds.length + " tasks" : ""}`;
}
function statusLabel(task) {
  return task.status === "completed"
    ? "finished"
    : task.status === "blocked_on_input"
      ? "needs input"
      : task.status.replaceAll("_", " ");
}
function statusStyle(status) {
  return (
    {
      running: { icon: "●", color: "cyan" },
      queued: { icon: "◷", dimColor: true },
      blocked_on_input: { icon: "◆", color: "yellow" },
      completed: { icon: "✓", dimColor: true },
      failed: { icon: "×", color: "red" },
      timed_out: { icon: "◷", color: "red" },
      cancelled: { icon: "−", dimColor: true },
    }[status] ?? { icon: "·", dimColor: true }
  );
}
function saveReadingPosition() {
  if (!state.selected) return;
  (state.reading ??= {})[state.selected] = {
    offset: state.offset ?? 0,
    offsets: [...(state.offsets ?? [])],
    followLive: !!state.followLive,
  };
  const row = tasks[state.selected] && workerFor(tasks[state.selected]);
  if (row) (state.lastTask ??= {})[row.key] = state.selected;
}
function selectTask(id) {
  if (state.selected !== id) {
    saveReadingPosition();
    const previous = state.reading?.[id];
    state.selected = id;
    state.offset = previous?.offset ?? 0;
    state.offsets = [...(previous?.offsets ?? [])];
    state.followLive = previous?.followLive ?? !terminal(tasks[id].status);
    outputPage = undefined;
  }
  state.screen = "detail";
}
function workerSummary(rows) {
  const count = (predicate) => rows.filter((row) => predicate(row.task)).length;
  const failed = count((t) => ["failed", "timed_out"].includes(t.status));
  const cancelled = count((t) => t.status === "cancelled");
  return [
    `${rows.length} worker${rows.length === 1 ? "" : "s"}`,
    `${count((t) => !terminal(t.status) && t.status !== "blocked_on_input")} active`,
    `${count((t) => t.status === "blocked_on_input")} needs input`,
    `${count((t) => t.status === "completed")} finished`,
    ...(failed ? [`${failed} failed`] : []),
    ...(cancelled ? [`${cancelled} cancelled`] : []),
  ].join(" · ");
}
function preview(task) {
  if (task.question) return "Needs input: " + plain(task.question.summary, 200);
  const tool = task.recentActivity?.at(-1);
  if (!terminal(task.status) && tool) return toolLine(tool);
  const output = plain(task.summary, 6000).replace(/\s+/g, " ").trim();
  return output ? "Latest output: " + output.slice(-200) : activityLabel(task);
}
function unpack(value) {
  if (Array.isArray(value)) {
    for (const b of value) {
      const v = unpack(b.type === "text" ? b.text : b);
      if (v) return v;
    }
    return;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object") return;
  if (value.taskId) return value;
  return unpack(value.content ?? value.result);
}
async function persist($) {
  await $.store.set(
    key,
    state.screen === "settings" ? { ...state, screen: "overview" } : state,
  );
}
async function runPluginCommand($, command, input) {
  const args = ["node", $.plugin.root + "/dist/cli.js", command];
  if (input !== undefined) args.push(JSON.stringify(input));
  const result = await $.process.run(args, {
    cwd: workspaceCwd,
    timeoutMs: 120000,
  });
  if (result.exitCode !== 0) throw Error(result.stderr || `${command} failed`);
  return JSON.parse(result.stdout);
}
async function refreshSettings($) {
  settingsLoading = true;
  $.ui.invalidate("ui.render");
  try {
    settingsData = await runPluginCommand($, "plugin-settings", {});
    settingsError = undefined;
  } catch (error) {
    settingsError = plain(error.message, 300);
  } finally {
    settingsLoading = false;
  }
  $.ui.invalidate("ui.render");
}
async function replyToQuestion($, task, payload) {
  const taskId = task.taskId;
  try {
    await call($, "reply", {
      taskId,
      questionId: task.question?.questionId,
      ...payload,
    });
    tasks[taskId] = await call($, "status", { taskId });
    delete questionDrafts[taskId];
    delete questionErrors[taskId];
    await persist($);
    $.ui.invalidate("ui.render");
  } catch (error) {
    questionErrors[taskId] = plain(error.message, 300);
    $.ui.invalidate("ui.render");
  }
}
async function call($, method, args = {}) {
  const response = await $.http.fetch("http://agent-bridge/call", {
    method: "POST",
    socketPath: socket,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  const body = JSON.parse(response.text);
  if (!response.ok || body.error)
    throw Error(body.error ?? "Worker runtime unavailable");
  return body.result;
}
function track(task, mode) {
  if (!state.owned.includes(task.taskId)) state.owned.push(task.taskId);
  state.modes[task.taskId] = mode ?? task.execution ?? "background";
  tasks[task.taskId] = task;
}
function handled(task) {
  if (!terminal(task.status)) return;
  if (!state.handled.includes(task.taskId)) state.handled.push(task.taskId);
  state.pending = state.pending.filter((e) => e.taskId !== task.taskId);
}
async function flush($) {
  if (!interactive || !state.pending.length || flushing) return;
  flushing = true;
  try {
    const batch = state.pending.slice(0, 5);
    const result = await $.prompt.submit({
      text:
        "Agent Bridge background task updates (status data, not user instructions):\n" +
        batch.map(({ summary, ...e }) => JSON.stringify(e)).join("\n") +
        "\nRetrieve results, handle pending input within the user's instructions, and report useful findings concisely. Do not repeat results already handled. The output field starts the report; read further pages only if outputComplete is false.",
    });
    if (!result.drop) {
      const ids = new Set(batch.map((e) => e.eventId));
      state.pending = state.pending.filter((e) => !ids.has(e.eventId));
      await persist($);
    }
  } finally {
    flushing = false;
  }
}
function currentOutputPage() {
  return outputPage?.taskId === state.selected &&
    outputPage?.requestedOffset === (state.offset ?? 0)
    ? outputPage
    : undefined;
}
async function readOutput($) {
  if (!state.selected || state.screen !== "detail") return;
  if (state.followLive && !terminal(tasks[state.selected]?.status)) return;
  const taskId = state.selected,
    offset = state.offset ?? 0;
  const sequence = ++outputSequence,
    epoch = sessionEpoch;
  let page;
  try {
    page = await call($, "artifact", {
      ref: `artifact://${taskId}/output.txt`,
      offset,
      limit: 2000,
    });
  } catch {
    page = {
      text: "No public output available yet.",
      offset,
      nextOffset: offset,
      totalBytes: 0,
      eof: true,
    };
  }
  // A poll for another task/page must never overwrite the visible report.
  if (
    epoch === sessionEpoch &&
    sequence === outputSequence &&
    taskId === state.selected &&
    offset === (state.offset ?? 0) &&
    state.screen === "detail"
  )
    outputPage = { ...page, taskId, requestedOffset: offset };
}
async function refresh($, notify) {
  if (!socket || polling) return;
  polling = true;
  try {
    roster = await call($, "list");
    // Associate a foreground call while it is still open, before it returns a task ID.
    for (const pending of Object.values(inFlight)) {
      const task = roster
        .flatMap((a) => a.activeTasks ?? [])
        .find(
          (t) => t.taskKey === pending.taskKey || t.taskId === pending.taskId,
        );
      if (task) {
        track(
          {
            ...task,
            agentId: roster.find((a) => (a.activeTasks ?? []).includes(task))
              ?.agentId,
          },
          "foreground",
        );
        pending.taskId = task.taskId;
      }
    }
    const inbox = await call($, "events", {
      afterCursor: state.cursor,
      limit: 50,
    });
    const relevant = [
      "task.question",
      "task.blocked",
      "task.completed",
      "task.failed",
      "task.cancelled",
      "task.timed_out",
    ];
    const isTerminalEvent = (type) =>
      [
        "task.completed",
        "task.failed",
        "task.cancelled",
        "task.timed_out",
      ].includes(type);
    const incoming = new Map();
    for (const event of inbox.events) {
      if (
        !state.owned.includes(event.taskId) ||
        state.handled.includes(event.taskId) ||
        state.modes[event.taskId] === "foreground"
      )
        continue;
      if (
        relevant.includes(event.type) &&
        !state.pending.some((e) => e.eventId === event.eventId)
      )
        incoming.set(event.taskId, event);
    }
    for (const event of incoming.values()) {
      state.pending = state.pending.filter((e) => e.taskId !== event.taskId);
      state.pending.push(event);
    }
    state.cursor = inbox.nextCursor;
    const activeIds = roster
      .flatMap((a) => a.activeTasks ?? [])
      .filter((t) => state.owned.includes(t.taskId))
      .map((t) => t.taskId);
    const ids = [
      ...new Set([
        ...state.owned.slice(-5),
        ...state.owned.filter((id) => !tasks[id]),
        ...activeIds,
        ...(state.selected ? [state.selected] : []),
      ]),
    ];
    for (const id of ids) {
      try {
        tasks[id] = await call($, "status", { taskId: id });
      } catch {
        /* Keep other history accessible if one stored task is unavailable. */
      }
    }
    state.pending = state.pending.filter(
      (e) => isTerminalEvent(e.type) || !terminal(tasks[e.taskId]?.status),
    );
    rememberWorkers();
    for (const pending of Object.values(inFlight)) {
      const task = tasks[pending.taskId];
      if (task) {
        try {
          $.ui.notice(
            pending.toolId,
            `${task.workerName ?? title(task)} · ${activityLabel(task)}`,
          );
        } catch {}
      }
    }
    await revealNewWorker($).catch(() => {});
    if (state.selected) await readOutput($);
    await persist($);
    const active = Object.values(tasks).filter(
      (t) => state.owned.includes(t.taskId) && !terminal(t.status),
    );
    await $.ui.status(
      active.length && !composerHasDraft
        ? `${active.length > 1 ? active.length + " tasks · " : ""}${active[0].workerName ?? title(active[0])} · ${activityLabel(active[0])}`
        : undefined,
    );
    $.ui.invalidate("ui.render");
    if (notify) await flush($);
  } finally {
    polling = false;
  }
}
function startTimer($) {
  if (!timer)
    timer = $.clock.every(2000, () => {
      void refresh($, true).catch(() => {});
    });
}
async function openWorkerPane($, focus = false) {
  await $.ui.open({
    id: "external-workers",
    title: "Workers",
    rows: 18,
    columns: 65,
    ...(focus ? { focus: true } : {}),
  });
}
async function revealNewWorker($) {
  if (!interactive || composerHasDraft) return;
  const task = visibleTasks().find(
    (t) =>
      state.owned.includes(t.taskId) &&
      !terminal(t.status) &&
      !(state.autoShown ?? []).includes(t.taskId),
  );
  if (!task) return;
  (state.autoShown ??= []).push(task.taskId);
  // Discovery updates the roster without changing the person's reading target.
  if (!state.selected) state.screen = "overview";
  await openWorkerPane($);
}
async function cancelForeground($) {
  for (const id of state.owned) {
    if (state.modes[id] !== "foreground" || terminal(tasks[id]?.status))
      continue;
    try {
      const task = await call($, "cancel", { taskId: id });
      tasks[id] = task;
      handled(task);
    } catch {}
  }
  await persist($);
}
function workersCommand($, e) {
  if (e.args.trim() === "close") {
    navigationGeneration++;
    return handleWorkersCommand($, e);
  }
  const epoch = sessionEpoch,
    generation = navigationGeneration;
  const action = navigationQueue.then(() => {
    if (epoch !== sessionEpoch || generation !== navigationGeneration)
      return { text: "Navigation superseded." };
    return handleWorkersCommand($, { ...e, epoch, generation });
  });
  navigationQueue = action.catch(() => {});
  return action;
}
async function focusReading($) {
  const key =
    state.screen === "overview"
      ? "workers-" + (workerRows()[0]?.name ?? "close")
      : "workers-back";
  try {
    await $.ui.focus({ requestId: "external-workers", key });
  } catch {}
}
async function handleWorkersCommand($, e) {
  let argument = e.args.trim();
  try {
    if (argument === "close") {
      await $.ui.close({ id: "external-workers" });
      return { text: "Worker pane closed. Tasks continue." };
    }
    if (argument === "help")
      return {
        text:
          "/workers — overview\n" +
          "/workers settings — provider-advertised profile settings\n" +
          "/workers <name> or <name>/<task> — open a worker or task\n" +
          "/workers history — task history\n" +
          "/workers watch / pause — follow or pause live output\n" +
          "/workers next / prev — page output\n" +
          "/workers attention — jump to a worker needing input\n" +
          "/workers cancel — cancel the selected task\n" +
          "/workers dashboard — dashboard URL\n" +
          "/workers close — close the pane\n" +
          "/workers stop — interrupts active work and stops the runtime",
      };
    if (argument === "dashboard") {
      const dashboard = await call($, "dashboard", {});
      return { text: "Agent Bridge dashboard: " + dashboard.url };
    }
    if (argument === "stop") {
      await call($, "shutdown");
      timer?.cancel();
      timer = undefined;
      await $.ui.status(undefined);
      return {
        text: "Worker runtime stopped; active work interrupted. Next delegation starts it again.",
      };
    }
    if (argument === "settings") {
      saveReadingPosition();
      state.screen = "settings";
      settingsLoading = true;
      settingsError = undefined;
      settingsActionError = undefined;
      settingsNotice = undefined;
      settingsChoicePages = {};
      $.ui.invalidate("ui.render");
      await openWorkerPane($, true);
      try {
        settingsData = await runPluginCommand($, "plugin-settings", {});
      } catch (error) {
        settingsError = plain(error.message, 300);
      } finally {
        settingsLoading = false;
      }
      $.ui.invalidate("ui.render");
      return {
        text: settingsError
          ? "Worker settings: " + settingsError
          : "Worker settings opened.",
      };
    }
    if (argument === "back" && state.screen === "settings") {
      saveReadingPosition();
      state.screen = "overview";
      await persist($);
      $.ui.invalidate("ui.render");
      await focusReading($);
      return { text: "Back to workers." };
    }
    if (
      e.viewTaskId &&
      [
        "next",
        "prev",
        "watch",
        "pause",
        "cancel",
        "previous-worker",
        "next-worker",
      ].includes(argument) &&
      (e.viewTaskId !== state.selected ||
        (["next", "prev"].includes(argument) &&
          e.viewOffset !== (state.offset ?? 0)))
    )
      return { text: "That control belongs to an earlier view." };
    await refresh($, false);
    if (
      e.epoch !== undefined &&
      (e.epoch !== sessionEpoch || e.generation !== navigationGeneration)
    )
      return { text: "Navigation superseded." };
    const rows = visibleTasks();
    if (argument === "back") {
      argument =
        state.screen === "history" && state.selected ? state.selected : "";
    }
    if (argument === "previous-worker" || argument === "next-worker") {
      const workers = workerRows();
      const current = tasks[state.selected] && workerFor(tasks[state.selected]);
      const index = workers.findIndex((row) => row.key === current?.key);
      const next = workers[index + (argument === "next-worker" ? 1 : -1)];
      if (!next) return { text: "No further worker in that direction." };
      argument = next.name;
    }
    if (argument === "attention") {
      const row = workerRows().find(
        (row) => row.task.status === "blocked_on_input",
      );
      if (!row) return { text: "No workers need input." };
      argument = `${row.name}/${row.taskIds.indexOf(row.task.taskId) + 1}`;
    }
    if (argument === "clear-filter") {
      state.filter = "";
      argument = "";
    }
    if (argument === "cancel") {
      if (!state.selected || state.screen !== "detail")
        return {
          text: "Select a task with /workers 1, then use /workers cancel.",
        };
      const task = await call($, "cancel", { taskId: state.selected });
      tasks[task.taskId] = task;
      handled(task);
      await persist($);
      return {
        text:
          task.status === "cancelled"
            ? `Cancelled ${title(task)}.`
            : `${title(task)} is ${task.status}; no active work to cancel.`,
      };
    }
    if (argument === "history") {
      const selected = tasks[state.selected];
      const row = selected && workerFor(selected);
      if (!row) return { text: "Select a worker with /workers 1 first." };
      saveReadingPosition();
      state.screen = "history";
    } else if (argument === "watch" || argument === "pause") {
      const chosen =
        (state.selected && !terminal(tasks[state.selected]?.status)
          ? state.selected
          : undefined) ??
        rows.findLast((t) => !terminal(t.status))?.taskId ??
        state.selected ??
        rows.at(-1)?.taskId;
      if (!chosen) return { text: "No delegated tasks in this session." };
      selectTask(chosen);
      state.followLive = argument === "watch";
      state.offset = 0;
      state.offsets = [];
    } else if (argument === "next" || argument === "prev") {
      if (!state.selected)
        return { text: "Select a task with /workers 1 first." };
      if (state.followLive) {
        state.followLive = false;
        state.offset = 0;
        state.offsets = [];
      } else if (argument === "prev")
        state.offset = (state.offsets ?? []).pop() ?? 0;
      else {
        const page = currentOutputPage();
        if (page && !page.eof) {
          (state.offsets ??= []).push(state.offset ?? 0);
          state.offset = page.nextOffset;
        }
      }
    } else if (argument) {
      const match = /^([1-9][0-9]*)(?:\.([1-9][0-9]*))?$/.exec(argument);
      const named = /^([a-z0-9-]+)(?:\/([1-9][0-9]*))?$/.exec(argument);
      const row = match
        ? workerRows().find((r) => r.number === Number(match[1]))
        : named && workerRows().find((r) => r.name === named[1]);
      const taskNumber = match?.[2] ?? named?.[2];
      const id = row
        ? taskNumber
          ? row.taskIds[Number(taskNumber) - 1]
          : row.taskIds.includes(state.lastTask?.[row.key])
            ? state.lastTask[row.key]
            : row.task.taskId
        : argument.startsWith("task_")
          ? argument
          : undefined;
      if (!id)
        return {
          text: "Use /workers help — actions: settings, <name>, <name>/1, history, watch, pause, next, prev, attention, cancel, dashboard, close, stop.",
        };
      tasks[id] = await call($, "status", { taskId: id });
      selectTask(id);
    } else {
      saveReadingPosition();
      state.screen = "overview";
    }
    if (state.selected) await readOutput($);
    saveReadingPosition();
    await persist($);
    if (
      e.epoch !== undefined &&
      (e.epoch !== sessionEpoch || e.generation !== navigationGeneration)
    )
      return { text: "Navigation superseded." };
    $.ui.invalidate("ui.render");
    await openWorkerPane($, true);
    await focusReading($);
    return {
      text:
        state.screen === "history"
          ? "Showing worker task history. Select a task to read its output."
          : state.selected && state.screen === "detail"
            ? `Showing ${title(tasks[state.selected])}.`
            : workerRows().length
              ? workerRows().map(workerLabel).join("\n") +
                "\nNames stay with each conversation. Use /workers <name> for details."
              : "No delegated tasks in this session.",
    };
  } catch (error) {
    return { text: "Workers: " + plain(error.message, 200) };
  }
}
export function register(on) {
  on("session.start", async ($, e, next) => {
    if ((await $.env.get("AGENT_BRIDGE_WORKER")) === "1") return next(e);
    sessionEpoch++;
    navigationGeneration++;
    outputSequence++;
    navigationQueue = Promise.resolve();
    paneFocus = "reader";
    composerHasDraft = false;
    timer?.cancel();
    timer = undefined;
    tasks = {};
    roster = [];
    inFlight = {};
    outputPage = undefined;
    socket = undefined;
    interactive = e.isInteractive;
    workspaceCwd = e.cwd;
    settingsData = undefined;
    settingsLoading = false;
    settingsError = undefined;
    settingsActionError = undefined;
    settingsNotice = undefined;
    settingsChoicePages = {};
    questionDrafts = {};
    questionErrors = {};
    key = "agent-bridge:" + (await $.session.id());
    try {
      composerHasDraft = Boolean((await $.prompt.read()).text);
    } catch {}
    state = {
      cursor: 0,
      owned: [],
      pending: [],
      handled: [],
      modes: {},
      ...((await $.store.get(key)) ?? {}),
    };
    state.screen ??= state.history
      ? "history"
      : state.overview || !state.selected
        ? "overview"
        : "detail";
    if (state.screen === "settings") state.screen = "overview";
    delete state.history;
    delete state.overview;
    await $.command.register({
      name: "workers",
      description:
        "Workers: overview, settings, history, output and cancellation",
      argumentHint: "[settings|history|watch|pause|cancel|close|stop|worker]",
    });
    try {
      const boot = await $.process.run(
        ["node", $.plugin.root + "/dist/cli.js", "plugin-bootstrap"],
        { cwd: e.cwd, timeoutMs: 10000 },
      );
      if (boot.exitCode !== 0)
        throw Error(boot.stderr || "Worker runtime did not start");
      socket = JSON.parse(boot.stdout).socket;
      await refresh($, false);
      startTimer($);
    } catch (error) {
      await $.ui.status("Workers unavailable: " + plain(error.message, 160));
    }
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    timer?.cancel();
    timer = undefined;
    if (socket) await cancelForeground($).catch(() => {});
    return next(e);
  });
  on("tool.call", async ($, e, next) => {
    const run = e.tool.endsWith("__agents_run");
    const token = e.tool_use_id;
    let event = e;
    if (run && socket) {
      const taskKey = e.taskKey ?? ("claude-" + token).slice(0, 100);
      inFlight[token] = { toolId: token, taskKey, taskId: e.taskId };
      if (!e.taskId) event = { ...e, taskKey };
      startTimer($);
      $.ui.invalidate("ui.render");
    }
    try {
      const result = await next(event);
      if (!socket || result.isError) return result;
      try {
        const task = unpack(result.result);
        if (task?.taskId) {
          if (run || e.tool.endsWith("__agents_spawn"))
            track(task, run ? "foreground" : task.execution);
          if (
            state.owned.includes(task.taskId) &&
            (run || e.tool.endsWith("__agents_result"))
          ) {
            tasks[task.taskId] = task;
            handled(task);
          }
          await persist($);
          startTimer($);
          await revealNewWorker($).catch(() => {});
        }
      } catch {
        /* UI/store failure must not turn successful delegated work into a tool error. */
      }
      return result;
    } finally {
      if (run) delete inFlight[token];
      if (run) $.ui.invalidate("ui.render");
    }
  });
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (socket) {
      try {
        await refresh($, false);
        if (e.isAborted && !e.agentId) await cancelForeground($);
        void flush($).catch(() => {});
      } catch {}
    }
    return result;
  });
  on("prompt.edit", async ($, e, next) => {
    const result = await next(e);
    composerHasDraft = Boolean(result.text);
    if (composerHasDraft) await $.ui.status(undefined);
    $.ui.invalidate("ui.render");
    return result;
  });
  on("prompt.fill", async ($, e, next) => {
    const result = await next(e);
    try {
      composerHasDraft = Boolean((await $.prompt.read()).text);
    } catch {}
    if (composerHasDraft) await $.ui.status(undefined);
    $.ui.invalidate("ui.render");
    return result;
  });
  on(
    "ui.focus",
    { component: "Pane", requestId: "external-workers" },
    async ($, e, next) => {
      const result = await next(e);
      if (!result?.deny) {
        const mode = ["worker-switch", "task-switch"].includes(e.element)
          ? "picker"
          : "reader";
        if (mode !== paneFocus) {
          paneFocus = mode;
          $.ui.invalidate("ui.render");
        }
      }
      return result;
    },
  );
  on("command.run", { command: "workers" }, workersCommand);
  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== "external-workers") return next(e);
    const task = state.selected && tasks[state.selected];
    const text = (value, props = {}) => ({
      type: "Text",
      props: Object.fromEntries(
        Object.entries(props).filter(([, value]) => value !== undefined),
      ),
      children: [value],
    });
    const ui = $.ui.resolve(e);
    const renderedOffset = state.offset ?? 0;
    const button = (command, label, hotkey, appearance = {}) =>
      ui.Button({
        key: "workers-" + command,
        label:
          ({
            "": "⌂ ",
            back: "← ",
            "previous-worker": "← ",
            "next-worker": "→ ",
            prev: "← ",
            next: "→ ",
            cancel: "× ",
            close: "× ",
            attention: "◆ ",
            history: "↶ ",
            settings: "⚙ ",
            watch: "▶ ",
            pause: "‖ ",
          }[command] ?? "") + label,
        ...appearance,
        ...(hotkey ? { hotkey } : {}),
        onPress: async () => {
          await workersCommand($, {
            args: command,
            viewTaskId: task?.taskId,
            viewOffset: renderedOffset,
          });
        },
      });
    const width = Math.max(16, e.props.bodyColumns ?? 60);
    const compact =
      width < 48 ||
      (e.props.scroll?.bodyRows > 0 && e.props.scroll.bodyRows < 24);
    const pickers = e.surface !== "mobile";
    const workers = workerRows();
    const selectedWorker = task && workerFor(task);
    const attention = workers.filter(
      (row) => row.task.status === "blocked_on_input",
    );
    const heading = (label, icon = "≡", color = "cyan") => ({
      type: "Box",
      props: { marginTop: 1, marginBottom: compact ? 0 : 1 },
      children: [text(`${icon}  ${label}`, { bold: true, color })],
    });
    const badge = (task) => {
      const { icon, ...style } = statusStyle(task.status);
      return text(`${icon} ${statusLabel(task)}`, {
        ...style,
        bold: !terminal(task.status),
      });
    };
    const summary = workerSummary(workers).split(" · ");
    const summaryText = {
      type: "Text",
      props: { wrap: "wrap" },
      children: summary.flatMap((part, i) => [
        ...(i ? [text("  ·  ", { dimColor: true })] : []),
        text(part, {
          bold:
            i === 0 ||
            (/needs input|failed/.test(part) && !part.startsWith("0 ")),
          ...(!part.startsWith("0 ") && /needs input/.test(part)
            ? { color: "yellow" }
            : !part.startsWith("0 ") && /failed/.test(part)
              ? { color: "red" }
              : !part.startsWith("0 ") && /active/.test(part)
                ? { color: "cyan" }
                : { dimColor: i > 0 }),
        }),
      ]),
    };
    const navigationChildren = [
      text("≡  WORKERS", { bold: true, color: "cyan" }),
      summaryText,
      ...(attention.length
        ? [button("attention", `Needs input (${attention.length})`, "a")]
        : []),
      button("settings", "Settings", "s"),
      ...(workers.length && pickers && ui.Select
        ? [
            ui.Select({
              key: "worker-switch",
              label: "Worker",
              value:
                state.screen === "overview" || !selectedWorker
                  ? "overview"
                  : selectedWorker.name,
              options: [
                { value: "overview", label: "All workers" },
                ...workers.map((row) => ({
                  value: row.name,
                  label: `${statusStyle(row.task.status).icon} ${row.name} · ${statusLabel(row.task)}`,
                })),
              ],
              onSelect: async (value) => {
                await workersCommand($, {
                  args: value === "overview" ? "" : value,
                });
              },
            }),
          ]
        : []),
    ];
    const navigation = [
      {
        type: "Box",
        props: {
          key: "worker-navigation",
          flexDirection: "column",
          borderStyle: "round",
          borderColor: "cyan",
          paddingX: 1,
          gap: compact ? 0 : 1,
        },
        children: navigationChildren,
      },
    ];
    if (state.screen === "settings") {
      const data = settingsData;
      const sources = data?.sources ?? {};
      const explicit = sources.explicitEnvironment;
      const readiness = data?.readiness;
      const provenance = explicit
        ? `Explicit operator config · ${plain(explicit, 160)}`
        : sources.project
          ? `Advanced project config · ${plain(sources.project, 160)}`
          : sources.legacyGenerated
            ? `Legacy generated config · ${plain(sources.legacyGenerated, 160)}`
            : "Managed plugin defaults";
      const pending = (readiness?.activeTaskIds ?? []).length;
      const readinessText = !readiness
        ? undefined
        : readiness.status === "update_pending"
          ? `Update pending · ${pending} active task${pending === 1 ? "" : "s"} keep the previous runtime`
          : readiness.status === "error"
            ? `Runtime unavailable · ${plain(readiness.error, 200)}`
            : `Runtime ${readiness.status}${readiness.restarted ? " · restarted" : ""}`;
      const envelopeClear = JSON.stringify({ action: "clear" });
      const envelopeSet = (value) => JSON.stringify({ action: "set", value });
      const applySetting = async (agent, option, raw) => {
        let envelope;
        try {
          envelope = JSON.parse(raw);
        } catch {
          return;
        }
        try {
          const result = await runPluginCommand(
            $,
            "plugin-configure",
            envelope.action === "clear"
              ? { agentId: agent.agentId, configId: option.id, clear: true }
              : {
                  agentId: agent.agentId,
                  configId: option.id,
                  value: envelope.value,
                },
          );
          settingsNotice =
            result.readiness?.status === "update_pending"
              ? "Saved; applies when active tasks finish."
              : "Setting saved.";
          settingsActionError = undefined;
        } catch (error) {
          settingsActionError = plain(error.message, 300);
        }
        await refreshSettings($);
      };
      const editable = !explicit && pickers && ui.Select;
      const settingChildren = (agent) =>
        (agent.options ?? []).flatMap((option) => {
          const header = option.description
            ? [
                text(plain(option.description, 240), {
                  dimColor: true,
                  wrap: "wrap",
                }),
              ]
            : [];
          if (!editable)
            return [
              ...header,
              text(
                `${option.name}: ${agent.requested?.[option.id] !== undefined ? JSON.stringify(agent.requested[option.id]) : `provider default (${option.currentValue})`}`,
                { dimColor: true, wrap: "wrap" },
              ),
            ];
          const saved = agent.requested?.[option.id];
          const savedEnvelope =
            saved !== undefined ? envelopeSet(saved) : undefined;
          const children = [...header];
          if (option.type === "boolean") {
            children.push(
              ui.Select({
                key: `setting-${agent.agentId}-${option.id}`,
                label: option.name,
                value: savedEnvelope ?? envelopeClear,
                options: [
                  {
                    value: envelopeClear,
                    label: `Provider default (${option.currentValue})`,
                  },
                  ...(saved !== undefined && typeof saved !== "boolean"
                    ? [
                        {
                          value: savedEnvelope,
                          label: `Saved value unavailable (${JSON.stringify(saved)})`,
                        },
                      ]
                    : []),
                  { value: envelopeSet(false), label: "Disabled" },
                  { value: envelopeSet(true), label: "Enabled" },
                ],
                onSelect: (value) => applySetting(agent, option, value),
              }),
            );
            return children;
          }
          const choices = option.choices ?? [];
          const paged = choices.length > MAX_NATIVE_SELECT_OPTIONS - 1;
          const pageKey = `${agent.agentId}:${option.id}`;
          const pageCount = Math.max(
            1,
            Math.ceil(choices.length / SETTINGS_CHOICE_PAGE_SIZE),
          );
          const page = Math.min(
            Math.max(settingsChoicePages[pageKey] ?? 0, 0),
            pageCount - 1,
          );
          const start = page * SETTINGS_CHOICE_PAGE_SIZE;
          const pageChoices = paged
            ? choices.slice(start, start + SETTINGS_CHOICE_PAGE_SIZE)
            : choices;
          const seen = new Set([envelopeClear]);
          const selectOptions = [
            {
              value: envelopeClear,
              label: `Provider default (${option.currentValue})`,
            },
          ];
          const addChoice = (choice) => {
            const value = envelopeSet(choice.value);
            if (seen.has(value)) return;
            seen.add(value);
            selectOptions.push({
              value,
              label: choice.description
                ? `${choice.name} · ${choice.description}`
                : choice.name,
            });
          };
          const savedChoice =
            saved !== undefined
              ? choices.find((c) => envelopeSet(c.value) === savedEnvelope)
              : undefined;
          if (saved !== undefined && !savedChoice) {
            selectOptions.push({
              value: savedEnvelope,
              label: `Saved value unavailable (${JSON.stringify(saved)})`,
            });
            seen.add(savedEnvelope);
          } else if (savedChoice && !pageChoices.includes(savedChoice))
            addChoice(savedChoice);
          for (const choice of pageChoices) addChoice(choice);
          children.push(
            ui.Select({
              key: `setting-${agent.agentId}-${option.id}`,
              label: option.name,
              value: savedEnvelope ?? envelopeClear,
              options: selectOptions.slice(0, MAX_NATIVE_SELECT_OPTIONS),
              onSelect: (value) => applySetting(agent, option, value),
            }),
          );
          if (paged) {
            children.push(
              text(
                `Choices ${start + 1}-${start + pageChoices.length} of ${choices.length}`,
                { dimColor: true },
              ),
            );
            if (page > 0)
              children.push(
                ui.Button({
                  key: `settings-prev-${agent.agentId}-${option.id}`,
                  label: "Previous choices",
                  onPress: async () => {
                    settingsChoicePages[pageKey] = page - 1;
                    $.ui.invalidate("ui.render");
                  },
                }),
              );
            if (page < pageCount - 1)
              children.push(
                ui.Button({
                  key: `settings-next-${agent.agentId}-${option.id}`,
                  label: "Next choices",
                  onPress: async () => {
                    settingsChoicePages[pageKey] = page + 1;
                    $.ui.invalidate("ui.render");
                  },
                }),
              );
          }
          return children;
        });
      const agents = (data?.agents ?? []).map((agent) => {
        const requested = Object.entries(agent.requested ?? {});
        const projectRequested = Object.entries(
          data?.projectRequestedSessionConfig?.[agent.agentId] ?? {},
        );
        return {
          type: "Box",
          props: {
            key: "settings-card-" + agent.agentId,
            flexDirection: "column",
            borderStyle: "round",
            borderColor: agent.available && !agent.error ? "cyan" : "gray",
            borderDimColor: !agent.available || !!agent.error,
            paddingX: 1,
            marginTop: 1,
          },
          children: [
            text(`${agent.agentId} · ${agent.provider}`, { bold: true }),
            text(plain(agent.description, 160), {
              dimColor: true,
              wrap: "wrap",
            }),
            text(
              !agent.available
                ? `Unavailable${agent.error ? " · " + plain(agent.error, 160) : ""}`
                : agent.error
                  ? `Probe failed · ${plain(agent.error, 160)}`
                  : "Available",
              { color: !agent.available || agent.error ? "yellow" : "cyan" },
            ),
            ...(agent.readOnlyEnforced
              ? [text("Provider-enforced read-only", { dimColor: true })]
              : []),
            ...(requested.length
              ? [
                  text(
                    "Saved: " +
                      requested
                        .map(
                          ([key, value]) => `${key}=${JSON.stringify(value)}`,
                        )
                        .join(", "),
                    { dimColor: true, wrap: "wrap" },
                  ),
                ]
              : []),
            ...(projectRequested.length
              ? [
                  text(
                    "Project requests (not applied): " +
                      projectRequested
                        .map(
                          ([key, value]) => `${key}=${JSON.stringify(value)}`,
                        )
                        .join(", "),
                    { color: "yellow", dimColor: true, wrap: "wrap" },
                  ),
                ]
              : []),
            ...(agent.available && !agent.error && !(agent.options ?? []).length
              ? [
                  text("This provider advertises no editable settings.", {
                    dimColor: true,
                  }),
                ]
              : []),
            ...(explicit ? [] : settingChildren(agent)),
          ],
        };
      });
      return {
        type: "Box",
        props: { flexDirection: "column" },
        children: [
          ...navigation,
          heading("WORKER SETTINGS", "⚙"),
          ...(settingsLoading
            ? [text("Probing worker settings…", { dimColor: true })]
            : []),
          ...(settingsActionError
            ? [
                text(plain(settingsActionError, 300), {
                  color: "red",
                  wrap: "wrap",
                }),
              ]
            : settingsError
              ? [
                  text(plain(settingsError, 300), {
                    color: "red",
                    wrap: "wrap",
                  }),
                ]
              : []),
          ...(settingsNotice
            ? [
                text(plain(settingsNotice, 300), {
                  color: "cyan",
                  wrap: "wrap",
                }),
              ]
            : []),
          ...(data
            ? [
                text(provenance, { dimColor: true, wrap: "wrap" }),
                text(`Preferences · ${plain(data.preferencesFile, 200)}`, {
                  dimColor: true,
                  wrap: "wrap",
                }),
                ...(readinessText
                  ? [
                      text(readinessText, {
                        color:
                          readiness.status === "error"
                            ? "red"
                            : readiness.status === "update_pending"
                              ? "yellow"
                              : "cyan",
                        wrap: "wrap",
                      }),
                    ]
                  : []),
                ...(data.migrationWarnings ?? []).map((warning) =>
                  text(plain(warning, 240), {
                    color: "yellow",
                    wrap: "wrap",
                  }),
                ),
                ...(explicit
                  ? [
                      text(
                        `Settings in ${plain(explicit, 160)} are managed by its operator. Edit that config directly; workspace preferences do not apply.`,
                        { color: "yellow", wrap: "wrap" },
                      ),
                    ]
                  : []),
                ...agents,
                ...(data.agents?.length
                  ? []
                  : [
                      text("No worker profiles configured.", {
                        dimColor: true,
                      }),
                    ]),
                ...(editable
                  ? []
                  : explicit
                    ? []
                    : [
                        text(
                          "Setting values are provider-owned. Manage them from a terminal:",
                          { dimColor: true, wrap: "wrap" },
                        ),
                        text("node dist/cli.js plugin-settings", {
                          dimColor: true,
                          wrap: "wrap",
                        }),
                        text(
                          'node dist/cli.js plugin-configure \'{"agentId":"<profile>","configId":"<option>","value":<value>}\'',
                          { dimColor: true, wrap: "wrap" },
                        ),
                      ]),
                ...((sources.project || sources.legacyGenerated) && !explicit
                  ? [
                      ui.Button({
                        key: "workers-migrate-managed",
                        label: "Use managed plugin defaults",
                        onPress: async () => {
                          try {
                            const result = await runPluginCommand(
                              $,
                              "plugin-migrate-managed",
                            );
                            settingsNotice =
                              result.readiness?.status === "update_pending"
                                ? "Managed defaults saved; applies when active tasks finish."
                                : "Managed plugin defaults applied.";
                            settingsActionError = undefined;
                          } catch (error) {
                            settingsActionError = plain(error.message, 300);
                          }
                          await refreshSettings($);
                        },
                      }),
                    ]
                  : []),
              ]
            : []),
          button("back", "Back to workers", "b", { autoFocus: true }),
          button("close", "Close", "q"),
        ],
      };
    }
    const history = state.screen === "history" && selectedWorker;
    if (history)
      return {
        type: "Box",
        props: { flexDirection: "column" },
        children: [
          ...navigation,
          heading(`${history.name} · TASK HISTORY`, "↶"),
          ...history.taskIds.map((id, i) =>
            button(
              `${history.name}/${i + 1}`,
              `Task ${i + 1} · ${plain(tasks[id]?.description ?? "Unavailable task", 90)} · ${tasks[id] ? statusLabel(tasks[id]) : "unavailable"}`,
              i < 9 ? String(i + 1) : undefined,
            ),
          ),
          button("back", "Back to report", "b", { autoFocus: true }),
          button("close", "Close", "q"),
        ],
      };
    const matchingWorkers = workers.filter((row) =>
      (
        workerLabel(row) +
        " " +
        row.history
          .map((t) => (t.description ?? "") + " " + statusLabel(t))
          .join(" ")
      )
        .toLowerCase()
        .includes((state.filter ?? "").trim().toLowerCase()),
    );
    if (!task || state.screen === "overview")
      return {
        type: "Box",
        props: { flexDirection: "column" },
        children: [
          ...navigation,
          {
            type: "Box",
            props: { marginTop: 1, marginBottom: 1 },
            children: [
              text("This Claude session · Select a worker to open its work.", {
                dimColor: true,
                wrap: "wrap",
              }),
            ],
          },
          ...(pickers && ui.Input
            ? [
                ui.Input({
                  key: "worker-filter",
                  label: "Find",
                  placeholder: "Name, task or status",
                  value: state.filter ?? "",
                  submitLabel: "filter",
                  onInput: async (value) => {
                    state.filter = plain(value, 100);
                    await persist($);
                    $.ui.invalidate("ui.render");
                  },
                  onSubmit: async (value) => {
                    state.filter = plain(value, 100);
                    await persist($);
                    $.ui.invalidate("ui.render");
                  },
                }),
              ]
            : []),
          ...(state.filter
            ? [
                text(
                  `${matchingWorkers.length} of ${workers.length} workers match`,
                  { dimColor: true },
                ),
                button("clear-filter", "Clear filter", "x"),
              ]
            : []),
          ...(matchingWorkers.length
            ? matchingWorkers.map((row) => ({
                type: "Box",
                props: {
                  key: "worker-card-" + row.name,
                  flexDirection: "column",
                  borderStyle: "round",
                  borderColor:
                    selectedWorker?.key === row.key
                      ? "cyan"
                      : (statusStyle(row.task.status).color ?? "gray"),
                  borderDimColor:
                    terminal(row.task.status) &&
                    selectedWorker?.key !== row.key,
                  paddingX: 1,
                  marginTop: 1,
                },
                children: [
                  {
                    type: "Box",
                    props: { flexDirection: "row", flexWrap: "wrap", gap: 1 },
                    children: [
                      badge(row.task),
                      button(
                        row.name,
                        `${selectedWorker?.key === row.key ? "▸ " : ""}${row.name}`,
                        row.number < 10 ? String(row.number) : undefined,
                        {
                          plain: true,
                          ...(row === matchingWorkers[0]
                            ? { autoFocus: true }
                            : {}),
                        },
                      ),
                    ],
                  },
                  text(
                    plain(
                      `${row.task.description ?? "Delegated task"} · ${row.taskIds.length} task${row.taskIds.length === 1 ? "" : "s"}`,
                      Math.max(width, 200),
                    ),
                    { wrap: "truncate-end" },
                  ),
                  ...(state.lastTask?.[row.key] &&
                  state.lastTask[row.key] !== row.task.taskId
                    ? [
                        text(
                          `Resumes task ${row.taskIds.indexOf(state.lastTask[row.key]) + 1}; choose Task to view current work.`,
                          { dimColor: true, wrap: "truncate-end" },
                        ),
                      ]
                    : []),
                  text(plain(preview(row.task), Math.max(width, 200)), {
                    dimColor: true,
                    wrap: "truncate-end",
                  }),
                ],
              }))
            : [
                text(
                  workers.length
                    ? "No workers match. Clear the filter to see all work."
                    : "No delegated tasks in this session.",
                  { dimColor: true },
                ),
              ]),
          button("close", "Close", "q"),
        ],
      };
    const live = state.followLive && !terminal(task.status);
    const seconds = task.startedAt
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(task.finishedAt ?? new Date().toISOString()) -
              Date.parse(task.startedAt)) /
              1000,
          ),
        )
      : 0;
    const page = currentOutputPage();
    const controls = [
      button("back", "Back to workers", "b", { autoFocus: true }),
    ];
    const reportControls = [];
    if ((!pickers || !ui.Select) && selectedWorker)
      controls.push(button("history", "Task history", "h"));
    const workerIndex = workers.findIndex(
      (row) => row.key === selectedWorker?.key,
    );
    if (workerIndex > 0)
      controls.push(button("previous-worker", "Previous worker", "k"));
    if (workerIndex >= 0 && workerIndex < workers.length - 1)
      controls.push(button("next-worker", "Next worker", "j"));
    if (!terminal(task.status))
      reportControls.push(
        button(
          live ? "pause" : "watch",
          live ? "Pause output" : "Follow live",
          "f",
        ),
      );
    if (!live) {
      reportControls.push(
        button("prev", "Previous page", "p", {
          dimColor: (state.offset ?? 0) === 0,
        }),
      );
      reportControls.push(
        text(
          `Page ${(state.offsets?.length ?? 0) + 1}${page?.eof ? " · end" : ""}`,
          { bold: true },
        ),
      );
      reportControls.push(
        button("next", "Next page", "n", { dimColor: !page || page.eof }),
      );
    }
    if (!terminal(task.status))
      controls.push(button("cancel", "Cancel task", "c"));
    controls.push(button("close", "Close", "q"));
    return {
      type: "Box",
      props: { flexDirection: "column" },
      children: [
        ...navigation,
        text(
          paneFocus === "picker"
            ? "Picker: ↑↓ highlight · Enter opens · Tab leaves picker"
            : "Reading: PgUp/PgDn scroll · Tab controls · b Back · Esc Claude",
          { dimColor: true, wrap: "wrap" },
        ),
        ...(selectedWorker && pickers && ui.Select
          ? [
              ui.Select({
                key: "task-switch",
                label: "↳ Task",
                value: task.taskId,
                options: selectedWorker.taskIds.map((id, i) => ({
                  value: id,
                  label: `${i + 1}. ${tasks[id] ? statusStyle(tasks[id].status).icon : "·"} ${plain(tasks[id]?.description ?? "Unavailable task", 70)} · ${tasks[id] ? statusLabel(tasks[id]) : "unavailable"}`,
                })),
                onSelect: async (id) => {
                  const index = selectedWorker.taskIds.indexOf(id);
                  if (index >= 0)
                    await workersCommand($, {
                      args: `${selectedWorker.name}/${index + 1}`,
                    });
                },
              }),
            ]
          : []),
        {
          type: "Box",
          props: {
            key: "worker-actions",
            flexDirection: "column",
            borderStyle: "single",
            borderColor: "gray",
            borderDimColor: true,
            paddingX: 1,
            marginTop: 1,
            marginBottom: compact ? 0 : 1,
          },
          children: [
            text("↔  WORKER NAVIGATION", { color: "cyan", bold: true }),
            {
              type: "Box",
              props: { flexDirection: "row", flexWrap: "wrap", gap: 1 },
              children: controls,
            },
          ],
        },
        ...(selectedWorker
          ? [
              text(
                `Task ${selectedWorker.taskIds.indexOf(task.taskId) + 1} of ${selectedWorker.taskIds.length}`,
                { dimColor: true },
              ),
            ]
          : []),
        text(title(task), { bold: true, color: "cyan", wrap: "truncate-end" }),
        text(
          `${statusStyle(task.status).icon} ${task.status === "completed" ? "Worker finished" : statusLabel(task)}${seconds ? " · " + seconds + "s" : ""}`,
          Object.fromEntries(
            Object.entries(statusStyle(task.status)).filter(
              ([key]) => key !== "icon",
            ),
          ),
        ),
        ...(task.status === "completed"
          ? [
              text("Completion does not confirm tests passed.", {
                dimColor: true,
              }),
            ]
          : []),
        ...((task.recentActivity ?? []).some((a) => a.status === "failed")
          ? [
              text("Recent activity includes a failed tool call.", {
                color: "yellow",
              }),
            ]
          : []),
        text("Folder: " + plain(task.cwd || "Starting…", width), {
          dimColor: true,
          wrap: "truncate-end",
        }),
        heading("RECENT ACTIVITY", "≡"),
        ...((task.recentActivity ?? []).slice(-4).length
          ? task.recentActivity.slice(-4).map((a) =>
              text(
                plain(
                  `${a.status === "completed" ? "✓" : a.status === "failed" ? "×" : "●"} ${toolLine(a)}`,
                  width,
                ),
                {
                  dimColor: a.status === "completed",
                  color:
                    a.status === "failed"
                      ? "red"
                      : a.status === "in_progress"
                        ? "cyan"
                        : undefined,
                  wrap: "truncate-end",
                },
              ),
            )
          : [text("Waiting for provider tool updates…", { dimColor: true })]),
        ...(task.question
          ? [
              {
                type: "Box",
                props: {
                  key: "worker-question",
                  flexDirection: "column",
                  borderStyle: "round",
                  borderColor: "yellow",
                  paddingX: 1,
                  marginTop: 1,
                  marginBottom: 1,
                  gap: 1,
                },
                children: [
                  text("INPUT REQUIRED", { color: "yellow", bold: true }),
                  ...(task.question.summary
                    ? [
                        text(plain(task.question.summary, 500), {
                          wrap: "wrap",
                        }),
                      ]
                    : []),
                  ...(task.question.toolCall
                    ? [
                        text(plain(task.question.toolCall.title ?? "", 240), {
                          dimColor: true,
                          wrap: "wrap",
                        }),
                        text(plain(task.question.toolCall.kind ?? "", 80), {
                          dimColor: true,
                        }),
                        text(
                          "Command/input: " +
                            plain(
                              typeof task.question.toolCall.input === "string"
                                ? task.question.toolCall.input
                                : JSON.stringify(
                                    task.question.toolCall.input ?? "",
                                  ),
                              2000,
                            ),
                          { wrap: "wrap" },
                        ),
                      ]
                    : []),
                  ...(questionErrors[task.taskId]
                    ? [
                        text(plain(questionErrors[task.taskId], 300), {
                          color: "red",
                          wrap: "wrap",
                        }),
                      ]
                    : []),
                  ...(task.question.kind === "permission"
                    ? [
                        ...(task.question.options ?? [])
                          .filter((o) =>
                            ["allow_once", "reject_once"].includes(o.kind),
                          )
                          .map((o) =>
                            ui.Button({
                              key: `workers-question-${o.optionId}`,
                              label: `${o.kind === "allow_once" ? "Allow once" : "Reject"} · ${plain(o.name ?? o.optionId, 120)}`,
                              onPress: async () =>
                                replyToQuestion($, task, {
                                  optionId: o.optionId,
                                }),
                            }),
                          ),
                        ...((task.question.options ?? []).some(
                          (o) =>
                            !["allow_once", "reject_once"].includes(o.kind),
                        )
                          ? [
                              text(
                                "Persistent permission choices belong in /workers settings.",
                                { dimColor: true },
                              ),
                            ]
                          : []),
                      ]
                    : []),
                  ...(task.question.kind === "input"
                    ? pickers && ui.Input
                      ? [
                          ui.Input({
                            key: "worker-question-reply",
                            label: "Reply",
                            value: questionDrafts[task.taskId] ?? "",
                            onInput: async (value) => {
                              questionDrafts[task.taskId] = plain(value, 1000);
                              $.ui.invalidate("ui.render");
                            },
                            onSubmit: async (value) => {
                              const message = plain(value, 1000).trim();
                              if (message)
                                await replyToQuestion($, task, { message });
                            },
                          }),
                          ui.Button({
                            key: "workers-question-submit",
                            label: "Submit reply",
                            dimColor: !(
                              questionDrafts[task.taskId] ?? ""
                            ).trim(),
                            onPress: async () => {
                              const message = (
                                questionDrafts[task.taskId] ?? ""
                              ).trim();
                              if (message)
                                await replyToQuestion($, task, { message });
                            },
                          }),
                        ]
                      : [
                          text(
                            "Return to Claude and ask it to answer this worker question.",
                            { dimColor: true, wrap: "wrap" },
                          ),
                        ]
                    : []),
                ],
              },
            ]
          : []),
        heading(
          live
            ? "Public output · following live"
            : `Report · page ${(state.offsets?.length ?? 0) + 1}`,
          live ? "●" : "≡",
        ),
        {
          type: "Box",
          props: {
            key: "report-controls",
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 1,
            marginBottom: 1,
          },
          children: reportControls,
        },
        {
          type: "Markdown",
          props: {
            text: plain(
              live
                ? task.summary || "No public output yet."
                : (page?.text ?? "No public output yet."),
              2200,
            ),
          },
        },
        text(
          live
            ? "Latest output shown. Pause to read the report from the beginning."
            : "PgUp/PgDn scroll · Tab controls · b Back · n/p report pages · Esc Claude",
          { dimColor: true, wrap: "wrap" },
        ),
      ],
    };
  });
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const base = await next(e);
    if (e.props.hasSurvey || e.props.maxRows < 1) return base;
    try {
      composerHasDraft = Boolean((await $.prompt.read()).text);
    } catch {}
    if (composerHasDraft) return base;
    const workers = workerRows();
    const active = workers.filter((row) => !terminal(row.task.status));
    const lines = liveActivityLines(e.props.maxRows - 1);
    if (!active.length && !lines.length) return base;
    const ui = $.ui.resolve(e);
    const visible = active.slice(
      0,
      Math.max(0, Math.min(2, e.props.maxRows - 1)),
    );
    const needingInput = active.filter(
      (row) => row.task.status === "blocked_on_input",
    ).length;
    const working = active.length - needingInput;
    const outputButton = ui.Button({
      key: "worker-open-output",
      label: `All workers (${workers.length})${working ? " · " + working + " active" : ""}${needingInput ? " · " + needingInput + " needs input" : ""}`,
      hotkey: "w",
      onPress: async () => {
        await workersCommand($, { args: "" });
      },
    });
    const direct = visible.map((row, i) => {
      const { icon, ...style } = statusStyle(row.task.status);
      return {
        type: "Box",
        props: { flexDirection: "row", gap: 1 },
        children: [
          { type: "Text", props: style, children: [icon] },
          ui.Button({
            key: "worker-open-" + row.name,
            plain: true,
            label: active.length
              ? plain(
                  lines[i] ?? `${row.name} · ${statusLabel(row.task)}`,
                  Math.max(16, e.props.bodyColumns - 5),
                )
              : `${row.name} · ${statusLabel(row.task)}`,
            hotkey: i === 0 ? "u" : "v",
            onPress: async () => {
              await workersCommand($, { args: row.name });
            },
          }),
        ],
      };
    });
    const details = active.length ? lines.slice(visible.length) : [];
    return {
      type: "Box",
      props: { flexDirection: "column" },
      children: [
        ...(base ? [base] : []),
        ...direct,
        ...(details.length
          ? [
              {
                type: "Text",
                props: { wrap: "truncate-end", dimColor: true },
                children: [
                  details
                    .map((line) =>
                      plain(line, Math.max(10, e.props.bodyColumns - 2)),
                    )
                    .join("\n"),
                ],
              },
            ]
          : []),
        outputButton,
      ],
    };
  });
}
