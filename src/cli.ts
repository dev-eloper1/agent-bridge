#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { serve, remote } from "./server.js";
import { mcp } from "./mcp.js";
import { initializeProject } from "./project-config.js";
import { fileURLToPath } from "node:url";
import {
  bootstrap,
  ensureRuntime,
  pluginConfig,
  pluginDoctor,
  pluginRestart,
} from "./plugin.js";
const args = process.argv.slice(2);
const index = args.indexOf("--config");
const file = index >= 0 ? args.splice(index, 2)[1] : "agents.yaml";
try {
  const [command = "help", value = "{}"] = args;
  const pluginMode = [
    "plugin-mcp",
    "plugin-bootstrap",
    "plugin-doctor",
    "plugin-restart",
  ].includes(command);
  const context =
    pluginMode && process.env.AGENT_BRIDGE_WORKER !== "1"
      ? command === "plugin-doctor" || command === "plugin-restart"
        ? pluginConfig()
        : await bootstrap()
      : undefined;
  const config =
    context?.config ??
    loadConfig(
      pluginMode
        ? fileURLToPath(new URL("../agents.yaml", import.meta.url))
        : file,
    );
  if (pluginMode && process.env.AGENT_BRIDGE_WORKER === "1") {
    if (command === "plugin-mcp") await mcp(config);
    else console.log(JSON.stringify({ disabled: true }));
  } else if (context && command === "plugin-bootstrap")
    console.log(
      JSON.stringify({
        configFile: context.file,
        socket: context.config.socket,
        workspace: context.config.root,
      }),
    );
  else if (context && command === "plugin-mcp")
    await mcp(config, () => ensureRuntime(context.file, config));
  else if (command === "plugin-doctor")
    console.log(JSON.stringify(await pluginDoctor(), null, 2));
  else if (command === "plugin-restart")
    console.log(JSON.stringify(await pluginRestart(), null, 2));
  else if (command === "serve") {
    await serve(config);
    console.error(`Agent bridge listening at ${config.socket}`);
  } else if (command === "mcp") await mcp(config);
  else if (command === "init") console.log(initializeProject(config, value));
  else if (command === "help")
    console.log(
      "bridge [--config agents.yaml] serve | mcp | init /path/to/project | plugin-doctor | plugin-restart | list | dashboard | doctor | specialists_schema | specialists_validate | specialists_catalog | templates|define|spawn|status|steer|reply|events|result|artifact|wait|cancel JSON",
    );
  else
    console.log(
      JSON.stringify(await remote(config, command, JSON.parse(value)), null, 2),
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
