const $ = (id) => document.getElementById(id);
const fragment = location.hash.slice(1);
if (fragment) {
  sessionStorage.setItem("bridge-token", fragment);
  history.replaceState(null, "", location.pathname);
}
const token = sessionStorage.getItem("bridge-token") ?? "";
let overview,
  selectedReference,
  selectedTask,
  offset = 0,
  offsets = [],
  lastPage;
const sections = ["library", "workers", "details", "editor", "report"];
function show(view) {
  for (const id of sections) $(id).hidden = id !== view;
  document
    .querySelectorAll(".nav")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.view ===
          (view === "report"
            ? "workers"
            : ["details", "editor"].includes(view)
              ? "library"
              : view),
      ),
    );
  $("notice").hidden = true;
  window.scrollTo(0, 0);
}
function notice(error) {
  $("notice").textContent = error.message ?? String(error);
  $("notice").hidden = false;
}
async function api(url, body) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? "Request failed");
  return result;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function run(action) {
  return (...args) => Promise.resolve(action(...args)).catch(notice);
}
function empty(title, description) {
  const card = element("div", undefined, "empty");
  card.append(element("h3", title), element("p", description));
  return card;
}
async function load() {
  overview = await api("/api/overview");
  $("project").textContent = overview.project;
  $("definition-count").textContent = overview.definitions.length;
  $("library-count").textContent = String(overview.definitions.length).padStart(
    2,
    "0",
  );
  $("definition-list").replaceChildren();
  for (const definition of overview.definitions) {
    const card = element("button", undefined, "card");
    const top = element("div", undefined, "card-top");
    top.append(
      element("span", "◈", "card-icon"),
      element(
        "span",
        definition.scope ?? definition.reference.split(":")[0],
        "pill",
      ),
    );
    const bottom = element("div", undefined, "card-bottom");
    bottom.append(
      element(
        "span",
        definition.error
          ? "Needs attention"
          : `${definition.delivery} · v${definition.version}`,
      ),
      element("span", "Open ↗"),
    );
    card.append(
      top,
      element("h3", definition.name ?? definition.reference),
      element("p", definition.description ?? definition.error),
      bottom,
    );
    card.addEventListener(
      "click",
      run(() => inspect(definition.reference)),
    );
    $("definition-list").append(card);
  }
  if (!overview.definitions.length)
    $("definition-list").append(
      empty(
        "Your agent library starts here.",
        "Create a specialist with clear instructions and an output contract. Save it to this project or your personal library, then ask Claude to use it.",
      ),
    );
  $("binding").replaceChildren(element("option", "Choose a worker profile…"));
  $("binding").firstChild.value = "";
  $("worker-list").replaceChildren();
  for (const worker of overview.workers) {
    const option = element("option", worker.agentId);
    option.value = worker.agentId;
    $("binding").append(option);
    const card = element("div", undefined, "card");
    const top = element("div", undefined, "card-top");
    top.append(
      element("span", "◎", "card-icon"),
      element("span", worker.available ? worker.status : "unavailable", "pill"),
    );
    card.append(
      top,
      element("h3", worker.agentId),
      element("p", worker.description),
    );
    const sessions = element("div", undefined, "session-list");
    for (const session of worker.sessions ?? []) {
      if (!session.lastTask) continue;
      const button = element(
        "button",
        `${session.workerName ?? session.agentSessionId} · ${session.lastTask.status}`,
      );
      button.addEventListener(
        "click",
        run(async () => {
          selectedTask = session.lastTask.taskId;
          offset = 0;
          offsets = [];
          await readReport();
        }),
      );
      sessions.append(button);
      if (session.template) {
        const definition = element(
          "button",
          `Pinned definition: ${session.template.name} v${session.template.version}`,
        );
        definition.addEventListener(
          "click",
          run(() => inspectConversation(session.agentSessionId)),
        );
        sessions.append(definition);
      }
    }
    if (!sessions.children.length)
      sessions.append(
        element("p", "No retained conversation for this profile yet."),
      );
    card.append(sessions);
    $("worker-list").append(card);
  }
}
function displayDefinition(result) {
  const d = result.definition;
  $("detail-name").textContent = d.name;
  $("detail-description").textContent = d.description;
  $("detail-meta").textContent =
    `${d.scope} · v${d.version}${d.pinned ? " · PINNED" : ""}`;
  $("markdown").innerHTML = result.html; // Only the server's html-disabled Markdown renderer supplies this.
  $("definition-json").textContent = JSON.stringify(
    { ...d, instructions: undefined },
    null,
    2,
  );
  $("binding-result").hidden = !d.binding;
  $("binding-result").textContent = d.binding
    ? JSON.stringify(d.binding, null, 2)
    : "";
  $("binding").parentElement.hidden = Boolean(d.pinned);
}
async function inspect(reference) {
  selectedReference = reference;
  const result = await api(
    "/api/definition?" + new URLSearchParams({ reference }),
  );
  displayDefinition(result);
  show("details");
}
async function inspectConversation(conversation) {
  const result = await api(
    "/api/definition?" + new URLSearchParams({ conversation }),
  );
  displayDefinition(result);
  show("details");
}
$("binding").addEventListener(
  "change",
  run(async () => {
    const agentId = $("binding").value;
    if (!agentId) {
      $("binding-result").hidden = true;
      return;
    }
    const result = await api(
      "/api/definition?" +
        new URLSearchParams({ reference: selectedReference, agentId }),
    );
    displayDefinition(result);
  }),
);
function draft() {
  return {
    format: 1,
    id: $("id").value,
    name: $("name").value,
    version: $("version").value,
    description: $("description").value,
    instructions: $("instructions").value,
    delivery: $("delivery").value,
    requiresReadOnly: $("read-only").checked,
  };
}
$("definition-form").addEventListener(
  "submit",
  run(async (event) => {
    event.preventDefault();
    const saved = await api("/api/definitions", {
      scope: $("scope").value,
      definition: draft(),
    });
    await load();
    await inspect(`${saved.definition.scope}:${saved.definition.id}`);
  }),
);
$("preview").addEventListener(
  "click",
  run(async () => {
    const result = await api("/api/preview", draft());
    $("editor-preview").innerHTML = result.html;
    $("editor-preview").hidden = false;
  }),
);
$("create").addEventListener("click", () => {
  show("editor");
  $("editor-preview").hidden = true;
  $("name").focus();
});
$("refresh").addEventListener("click", run(load));
$("back").addEventListener("click", () => show("library"));
$("editor-back").addEventListener("click", () => show("library"));
$("report-back").addEventListener("click", () => show("workers"));
for (const button of document.querySelectorAll(".nav"))
  button.addEventListener("click", () => show(button.dataset.view));
async function readReport() {
  const result = await api(
    "/api/task?" + new URLSearchParams({ taskId: selectedTask, offset }),
  );
  lastPage = result.page;
  $("report-title").textContent =
    result.result.description ?? result.result.workerName ?? "Task report";
  $("report-status").textContent = result.result.status;
  $("report-meta").textContent =
    `${result.result.workerName ?? result.result.agentId} · ${result.result.cwd ?? ""}`;
  $("report-body").innerHTML = result.html;
  $("page-label").textContent =
    `Page ${offsets.length + 1}${result.page.eof ? " · end" : ""}`;
  $("report-prev").disabled = !offsets.length;
  $("report-next").disabled = result.page.eof;
  show("report");
}
$("report-prev").addEventListener(
  "click",
  run(async () => {
    if (!offsets.length) return;
    offset = offsets.pop();
    await readReport();
  }),
);
$("report-next").addEventListener(
  "click",
  run(async () => {
    if (lastPage?.eof) return;
    offsets.push(offset);
    offset = lastPage.nextOffset;
    await readReport();
  }),
);
load().catch(notice);
