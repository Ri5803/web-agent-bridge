import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.mjs";

const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
if (!values["data-dir"]) throw new Error("Pass --data-dir with the private runtime directory.");
const dir = resolve(values["data-dir"]);
const root = fileURLToPath(new URL("../", import.meta.url));
const config = loadConfig(dir);
writeFileSync(new URL("../.mcp.json", import.meta.url), JSON.stringify({
  mcpServers: {
    web_agent_bridge: {
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/mcp.mjs", import.meta.url))],
      env: { WEB_AGENT_DATA_DIR: dir }
    }
  }
}, null, 2) + "\n");
console.log(JSON.stringify({
  pluginRoot: root, configFile: `${dir}/config.json`,
  browserEndpoint: `ws://127.0.0.1:${config.port}/browser`,
  notificationsConfigured: !!config.codex
}, null, 2));
