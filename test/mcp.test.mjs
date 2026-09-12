import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer } from "../src/server.mjs";
import { config } from "./helpers.mjs";

test("the real MCP process initializes, exposes eight tools, and reads broker status", async t => {
  const settings = config(t);
  const service = await startServer(settings);
  settings.port = service.server.address().port;
  writeFileSync(join(settings.dir, "config.json"), JSON.stringify(settings));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp.mjs", import.meta.url))],
    env: { ...process.env, WEB_AGENT_DATA_DIR: settings.dir },
    stderr: "pipe"
  });
  const client = new Client({ name: "bridge-test", version: "0.1.0" });
  t.after(async () => { await client.close(); await service.close(); });
  await client.connect(transport);
  const instructions = client.getInstructions();
  assert.ok(instructions);
  assert.match(instructions, /native Codex relay subagent/);
  assert.match(instructions, /untrusted/);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 8);
  assert.ok(listed.tools.some(tool => tool.name === "web_agent_create"));
  const response = await client.callTool({ name: "web_agent_status", arguments: {} });
  assert.notEqual(response.isError, true);
  const status = JSON.parse(response.content[0].text);
  assert.equal(status.browserConnected, false);
  assert.equal(status.notification.configured, false);
});
