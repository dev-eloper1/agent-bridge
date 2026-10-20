export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: "probe",
      description: "ACP integration probe",
      inputSchema: { type: "object", properties: {} },
    });
    await $.command.register({
      name: "acp-probe",
      description: "Check ACP probe",
    });
    await $.ui.status("ACP bridge probe ready");
    return next(e);
  });
  on("tool.call", { tool: "mcp__acp-spike__probe" }, async () => ({
    result: "ACP custom tool works",
  }));
  on("command.run", { command: "acp-probe" }, async () => ({
    text: "ACP custom tool/status integration; external native subagents unproven",
  }));
  on("ui.render", { component: "Spinner" }, async ($, e, next) =>
    next({ ...e, props: { ...e.props, suffix: " · ACP probe" } }),
  );
}
