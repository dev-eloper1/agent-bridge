import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Runtime, inputs } from "../dist/runtime.js";
import { schema, loadConfig } from "../dist/config.js";
import { remote, serve } from "../dist/server.js";

const root = process.cwd();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (predicate(value)) return value;
    await pause(10);
  }
  throw Error("Decision test condition timed out");
}
function makeConfig(dir) {
  return {
    ...schema.parse({
      version: 1,
      runtime: { maxConcurrentTasks: 2, maxRuntimeMs: 5000 },
      providers: {
        mock: {
          command: process.execPath,
          args: [path.join(root, "scripts/mock-acp.mjs")],
          env: { MOCK_STATE: path.join(dir, "mock.json") },
          readOnlyEnforced: true,
        },
      },
      agents: {
        demo: { provider: "mock", description: "decision test", workspace: "read-only" },
      },
    }),
    root: dir,
    stateDir: path.join(dir, "state"),
    socket: path.join(dir, "unused.sock"),
    sourceFile: path.join(dir, "unused.yaml"),
    configDigest: "decisions",
  };
}
function fixture(t) {
  const dir = mkdtempSync(path.join(root, ".decisions-"));
  const runtimes = [];
  const open = () => {
    const r = new Runtime(makeConfig(dir));
    runtimes.push(r);
    return r;
  };
  t.after(async () => {
    for (const r of runtimes) await r.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return open;
}
const options = [
  { label: "sqlite", tradeoff: "durable, one more native module" },
  { label: "json", tradeoff: "simple, slow at scale" },
];
const openDecision = (r, extra = {}) =>
  r.call("decision_open", { question: "Which store?", options, ...extra });
const status = (r, task) => r.call("status", { taskId: task.taskId });
const waitStatus = (r, task, expected) =>
  until(() => status(r, task), (value) => value.status === expected);

test("dependent waits for a person's decision while unrelated work runs, then gets the choice fenced", async (t) => {
  const r = fixture(t)();
  const decision = await openDecision(r);
  assert.equal(decision.status, "open");
  assert.equal(decision.openedBy, "coordinator");
  const waiting = await r.call("spawn", {
    agentId: "demo",
    prompt: "use the chosen store",
    waitsOnDecisions: [decision.decisionId],
  });
  assert.equal(waiting.queueReason, "waiting_on_decision");
  const unrelated = await r.call("spawn", { agentId: "demo", prompt: "unrelated" });
  await waitStatus(r, unrelated, "completed");
  assert.equal((await status(r, waiting)).status, "queued");
  const resolved = r.decide({ decisionId: decision.decisionId, option: "1", surface: "mod-button" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution.option, "sqlite");
  assert.equal(resolved.resolution.surface, "mod-button");
  assert.ok(resolved.resolution.at);
  await waitStatus(r, waiting, "completed");
  const output = await r.call("result", { taskId: waiting.taskId, maxChars: 6000 });
  const text = JSON.stringify(output);
  assert.match(text, new RegExp(`source=decision:${decision.decisionId}`));
  assert.match(text, /UNTRUSTED-[a-f0-9]{16}/);
  assert.match(text, /Answer: sqlite/);
  assert.throws(
    () => r.decide({ decisionId: decision.decisionId, option: "2", surface: "mod-command" }),
    /resolved/,
  );
});

test("free text, labels and surfaces are recorded; bad answers are refused", async (t) => {
  const r = fixture(t)();
  const strict = await openDecision(r);
  assert.throws(() => r.decide({ decisionId: strict.decisionId, text: "both", surface: "mod-command" }), /free text/);
  assert.throws(() => r.decide({ decisionId: strict.decisionId, option: "9", surface: "mod-command" }), /Unknown option/);
  assert.throws(() => r.decide({ decisionId: strict.decisionId, option: "1", surface: "Not A Surface" }), /surface/);
  assert.equal(r.decide({ decisionId: strict.decisionId, option: "json", surface: "mod-command" }).resolution.surface, "mod-command");
  const free = await openDecision(r, { allowFreeText: true });
  const answer = r.decide({ decisionId: free.decisionId, text: " neither ", surface: "mod-command" });
  assert.equal(answer.resolution.text, "neither");
});

test("withdrawn decision fails its dependents with a clear reason and refuses new ones", async (t) => {
  const r = fixture(t)();
  const decision = await openDecision(r);
  const waiting = await r.call("spawn", {
    agentId: "demo",
    prompt: "never runs",
    waitsOnDecisions: [decision.decisionId],
  });
  r.withdraw({ decisionId: decision.decisionId, surface: "mod-command" });
  const failed = await waitStatus(r, waiting, "failed");
  assert.equal(failed.startedAt, undefined);
  assert.match(failed.summary, new RegExp(`Decision ${decision.decisionId} was withdrawn`));
  await assert.rejects(
    r.call("spawn", { agentId: "demo", prompt: "late", waitsOnDecisions: [decision.decisionId] }),
    /withdrawn/,
  );
});

test("expiry happens on the timer and blocks dependents", async (t) => {
  const r = fixture(t)();
  const decision = await openDecision(r, { expiresInMs: 50 });
  assert.ok(decision.expiresAt);
  const waiting = await r.call("spawn", {
    agentId: "demo",
    prompt: "never runs",
    waitsOnDecisions: [decision.decisionId],
  });
  const failed = await waitStatus(r, waiting, "failed");
  assert.match(failed.summary, /was expired/);
  assert.equal((await r.call("decision_status", { decisionId: decision.decisionId })).status, "expired");
  assert.throws(() => r.decide({ decisionId: decision.decisionId, option: "1", surface: "mod-button" }), /expired/);
});

test("decisions and waiting tasks survive a restart; resolution after restart releases work", async (t) => {
  const open = fixture(t);
  const first = open();
  const decision = await openDecision(first, { expiresInMs: 60_000 });
  const waiting = await first.call("spawn", {
    agentId: "demo",
    prompt: "after restart",
    waitsOnDecisions: [decision.decisionId],
  });
  await first.close();
  const second = open();
  const reloaded = await second.call("decision_status", { decisionId: decision.decisionId });
  assert.equal(reloaded.status, "open");
  assert.equal(reloaded.question, "Which store?");
  assert.deepEqual(reloaded.options, options);
  assert.equal(reloaded.expiresAt, decision.expiresAt);
  assert.deepEqual((await status(second, waiting)).waitsOnDecisions, [decision.decisionId]);
  second.decide({ decisionId: decision.decisionId, option: "2", surface: "mod-command" });
  await waitStatus(second, waiting, "completed");
  await second.close();
  const third = open();
  const final = await third.call("decision_status", { decisionId: decision.decisionId });
  assert.equal(final.resolution.option, "json");
  assert.equal(final.resolution.surface, "mod-command");
  assert.equal((await status(third, waiting)).status, "completed");
});

test("no MCP tool can resolve, withdraw or expire a decision", () => {
  // mcp.ts registers one tool per key of `inputs` (plus agents_run).
  const names = Object.keys(inputs);
  assert.ok(names.includes("decision_open"));
  assert.ok(names.includes("decision_status"));
  for (const name of names)
    assert.doesNotMatch(name, /decide|resolve|withdraw|expire|answer/);
  // Opening cannot smuggle in a pre-decided status or resolution.
  for (const extra of [{ status: "resolved" }, { resolution: { option: "sqlite" } }])
    assert.throws(() =>
      inputs.decision_open.parse({ question: "q", options, ...extra }),
    );
  // Labels cannot impersonate positions or each other, so a person's
  // "/workers decide <id> 2" always means what the pane showed.
  for (const bad of [
    [{ label: "2", tradeoff: "a" }, { label: "1", tradeoff: "b" }],
    [{ label: "ship", tradeoff: "a" }, { label: " Ship ", tradeoff: "b" }],
  ])
    assert.throws(() => inputs.decision_open.parse({ question: "q", options: bad }));
  // A model's reply to a task question cannot target a decision.
  assert.throws(() =>
    inputs.reply.parse({ taskId: "dec_00000000-0000-0000-0000-000000000000", questionId: "q" }),
  );
});

function daemonConfig(dir) {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    runtime: { stateDir: path.join(dir, "s"), maxConcurrentTasks: 1 },
    providers: { mock: {
      command: process.execPath,
      args: [path.join(root, "scripts/mock-acp.mjs")],
      readOnlyEnforced: true,
    } },
    agents: { one: { provider: "mock", description: "test", workspace: "read-only" } },
  }));
  return loadConfig(file);
}
function post(config, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: config.socket, path: route, method: "POST", agent: false },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
function watch(config, since) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: config.socket, path: "/events?since=" + since, agent: false }, (res) => {
      let body = "";
      const events = [];
      res.on("data", (chunk) => {
        body += chunk;
        let end;
        while ((end = body.indexOf("\n")) >= 0) {
          events.push(JSON.parse(body.slice(0, end)));
          body = body.slice(end + 1);
        }
      });
      resolve({ res, events });
    });
    req.on("error", reject);
  });
}

test("/human route settles decisions with its surface; /call cannot; events replay and push live", async (t) => {
  const dir = mkdtempSync(path.join(root, ".dec-"));
  const config = daemonConfig(dir);
  const daemon = await serve(config);
  const watchers = [];
  t.after(async () => {
    for (const w of watchers) w.res.destroy();
    daemon.stop();
    await daemon.runtime.close();
    await until(() => !existsSync(path.join(config.stateDir, "lock")), Boolean);
    rmSync(dir, { recursive: true, force: true });
  });
  const first = await remote(config, "decision_open", { question: "Ship it?", options });
  // Replay: a watcher connecting after the fact still sees decision.opened.
  const late = await watch(config, 0);
  watchers.push(late);
  await until(() => late.events.length, (n) => n === 1);
  assert.equal(late.events[0].kind, "decision.opened");
  assert.equal(late.events[0].decisionId, first.decisionId);
  assert.equal(late.events[0].taskId, undefined);
  assert.equal(late.events[0].requiresReply, true);
  // The model's path refuses every settling verb.
  for (const method of ["decide", "withdraw", "human", "resolve"])
    await assert.rejects(remote(config, method, { decisionId: first.decisionId }), /Unknown method/);
  const listed = await remote(config, "decision_status", {});
  assert.deepEqual(listed.decisions.map((d) => d.decisionId), [first.decisionId]);
  // Only the named Mod surfaces are accepted.
  const forged = await post(config, "/human", {
    action: "decide", decisionId: first.decisionId, option: "1", surface: "mcp",
  });
  assert.equal(forged.status, 400);
  const decided = await post(config, "/human", {
    action: "decide", decisionId: first.decisionId, option: "1", surface: "mod-button",
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.result.resolution.surface, "mod-button");
  await until(() => late.events.length, (n) => n === 2);
  assert.equal(late.events[1].kind, "decision.resolved");
  assert.match(late.events[1].summary, /mod-button: sqlite/);
  // Live: withdraw and timer expiry reach a connected watcher.
  const second = await remote(config, "decision_open", { question: "Rename?", options });
  const third = await remote(config, "decision_open", { question: "Later?", options, expiresInMs: 30 });
  const since = late.events[1].cursor;
  const live = await watch(config, since);
  watchers.push(live);
  const withdrawn = await post(config, "/human", {
    action: "withdraw", decisionId: second.decisionId, surface: "mod-command",
  });
  assert.equal(withdrawn.body.result.status, "withdrawn");
  await until(() => live.events.map((e) => e.kind),
    (kinds) => kinds.includes("decision.withdrawn") && kinds.includes("decision.expired"));
  assert.deepEqual(
    live.events.filter((e) => e.decisionId === third.decisionId).map((e) => e.kind),
    ["decision.opened", "decision.expired"],
  );
  // No gaps or duplicates after the resume cursor.
  assert.deepEqual(live.events.map((e) => e.cursor), live.events.map((_, i) => since + 1 + i));
});

test("decision events opened by a task name both; stored events must name a task or a decision", async (t) => {
  const open = fixture(t);
  const r = open();
  const task = await r.call("spawn", { agentId: "demo", prompt: "opener" });
  await waitStatus(r, task, "completed");
  const decision = await openDecision(r, { openedBy: task.taskId });
  const event = r.store.state.events.findLast((e) => e.type === "decision.opened");
  assert.equal(event.taskId, task.taskId);
  assert.equal(event.decisionId, decision.decisionId);
  assert.equal(event.agentId, "demo");
  const events = await r.call("events", {});
  assert.equal(events.events.at(-1).kind, "decision.opened");
  await r.close();
  // Restart validates the stored decision events.
  const again = open();
  assert.equal(again.store.state.events.at(-1).decisionId, decision.decisionId);
  await again.close();
  const state = structuredClone(again.store.state);
  delete state.events.at(-1).taskId;
  delete state.events.at(-1).decisionId;
  const dir = mkdtempSync(path.join(root, ".decisions-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "state"));
  writeFileSync(path.join(dir, "state", "state.json"), JSON.stringify(state));
  assert.throws(() => new Runtime(makeConfig(dir)), /task\/decision reference/);
});
