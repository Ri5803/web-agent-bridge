import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { startServer } from "../src/server.mjs";
import { request } from "../src/client.mjs";
import { Store } from "../src/store.mjs";
import { Notifier } from "../src/notifier.mjs";
import { config, complete, eventually } from "./helpers.mjs";

async function broker(t) {
  const settings = config(t);
  const service = await startServer(settings);
  settings.port = service.server.address().port;
  t.after(() => service.close());
  return { settings, service };
}
async function driver(t, settings) {
  const ws = new WebSocket(`ws://127.0.0.1:${settings.port}/browser`);
  const commands = [];
  ws.on("message", bytes => {
    const message = JSON.parse(bytes);
    if (message.type === "command") commands.push(message);
  });
  await once(ws, "open");
  t.after(() => ws.terminate());
  const ready = once(ws, "message");
  ws.send(JSON.stringify({ type: "hello", token: settings.browserToken }));
  await ready;
  return { ws, commands };
}

test("HTTP control rejects missing token, browser token, and browser origins", async t => {
  const { settings } = await broker(t);
  const url = `http://127.0.0.1:${settings.port}/api/status`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${settings.browserToken}` } })).status, 401);
  assert.equal((await fetch(url, { headers: {
    Authorization: `Bearer ${settings.controlToken}`, Origin: "https://evil.example"
  } })).status, 403);
  assert.equal((await request("status", undefined, { config: settings })).browserConnected, false);
});

test("a browser-created job flows through event wait and follow-up without polling", async t => {
  const { settings } = await broker(t);
  const { ws, commands } = await driver(t, settings);
  const { agent, job } = await request("create", { name: "A", requestKey: "a" }, { config: settings });
  await eventually(() => commands.length === 1);
  const waiting = request("wait", { jobId: job.id, timeoutMs: 5000 }, { config: settings });
  ws.send(JSON.stringify({ type: "report", jobId: job.id, lease: commands[0].lease,
    status: "completed", conversationUrl: "https://chatgpt.com/c/a" }));
  assert.equal((await waiting).status, "completed");
  const sent = await request("send", {
    agentId: agent.id, text: "Next", requestKey: "follow-up"
  }, { config: settings });
  await eventually(() => commands.length === 2);
  assert.equal(commands[1].conversationUrl, "https://chatgpt.com/c/a");
  ws.send(JSON.stringify({ type: "report", jobId: sent.id, lease: commands[1].lease,
    status: "completed", output: "Web reply" }));
  const result = await request("wait", { jobId: sent.id, timeoutMs: 5000 }, { config: settings });
  assert.equal(result.output, "Web reply");
});

test("a second driver cannot steal tasks from the already paired browser", async t => {
  const { settings } = await broker(t);
  await driver(t, settings);
  const other = new WebSocket(`ws://127.0.0.1:${settings.port}/browser`);
  await once(other, "open");
  const closed = once(other, "close");
  other.send(JSON.stringify({ type: "hello", token: settings.browserToken }));
  assert.equal((await closed)[0], 1013);
});

test("extension origin aliases still require the browser token", async t => {
  const { settings } = await broker(t);
  for (const scheme of ["chrome-extension", "extension"]) {
    const ws = new WebSocket(`ws://127.0.0.1:${settings.port}/browser`, {
      origin: `${scheme}://${"a".repeat(32)}`
    });
    t.after(() => ws.terminate());
    await once(ws, "open");
    const closed = once(ws, "close");
    ws.send(JSON.stringify({ type: "hello", token: settings.controlToken }));
    assert.equal((await closed)[0], 1008);
  }
  assert.equal((await request("status", undefined, { config: settings })).browserConnected, false);
});

test("websites and lookalike extension origins cannot open a browser channel", async t => {
  const { settings } = await broker(t);
  for (const origin of [
    "https://chatgpt.com",
    "https://evil.example",
    `extension://${"a".repeat(32)}.evil.example`,
    `chrome-extension://${"a".repeat(32)}/options.html`,
    "null"
  ]) {
    const ws = new WebSocket(`ws://127.0.0.1:${settings.port}/browser`, { origin });
    t.after(() => ws.terminate());
    let opened = false;
    ws.on("open", () => { opened = true; ws.close(); });
    ws.on("error", () => {});
    await new Promise(resolve => ws.on("close", resolve));
    assert.equal(opened, false, origin);
  }
});

test("completion actively submits toolOutput to a test App Server", async t => {
  const parent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(parent, "listening");
  t.after(() => { for (const ws of parent.clients) ws.terminate(); parent.close(); });
  const received = [];
  parent.on("connection", ws => ws.on("message", bytes => {
    const message = JSON.parse(bytes);
    received.push(message);
    if (message.id) ws.send(JSON.stringify({ id: message.id, result:
      message.method === "turn/start" ? { turn: { id: "test-turn" } } : {} }));
  }));
  const store = new Store(config(t, {
    codex: { url: `ws://127.0.0.1:${parent.address().port}`, threadId: "explicit-parent" }
  }));
  const notifier = new Notifier(store);
  t.after(() => notifier.close());
  store.create({ name: "A", requestKey: "a" });
  complete(store, store.claim(), { output: "Completed on the webpage." });
  await eventually(() => Object.values(store.state.deliveries)[0]?.status === "accepted");
  const turn = received.find(message => message.method === "turn/start");
  assert.equal(turn.params.threadId, "explicit-parent");
  assert.deepEqual(turn.params.input, []);
  assert.equal(turn.params.toolOutput.namespace, "web_agent_bridge");
  assert.equal(JSON.parse(turn.params.toolOutput.output).output, "Completed on the webpage.");
  assert.ok(received.find(message => message.method === "thread/read"));
  assert.ok(!received.some(message => message.method === "thread/resume"));
});

test("lost notification acknowledgement becomes uncertain, not automatically duplicated", async t => {
  const parent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(parent, "listening");
  t.after(() => { for (const ws of parent.clients) ws.terminate(); parent.close(); });
  let starts = 0;
  parent.on("connection", ws => ws.on("message", bytes => {
    const message = JSON.parse(bytes);
    if (message.method === "turn/start") { starts++; ws.close(); }
    else if (message.id) ws.send(JSON.stringify({ id: message.id, result: {} }));
  }));
  const store = new Store(config(t, {
    codex: { url: `ws://127.0.0.1:${parent.address().port}`, threadId: "explicit-parent" }
  }));
  const notifier = new Notifier(store, { timeoutMs: 300 });
  t.after(() => notifier.close());
  store.create({ name: "A", requestKey: "a" });
  complete(store, store.claim());
  await eventually(() => Object.values(store.state.deliveries)[0]?.status === "uncertain");
  notifier.nextAttempt = 0;
  await notifier.drain();
  assert.equal(starts, 1);
});
