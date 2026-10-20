import { test, expect } from "claude-code/testing";
test("custom tool and status hook are callable", async ($, on) => {
  on("tool.check", () => ({ decision: "allow" }));
  const result = await $.tool.call({
    tool: "mcp__acp-spike__probe",
    input: {},
  });
  expect(result.result).toBe("ACP custom tool works");
  const command = await $.command.run({ command: "acp-probe", args: "" });
  expect(command.text).toContain("external native subagents unproven");
});
