import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { WebSocket } from "ws";
import { startServer } from "../src/server.mjs";
import { request } from "../src/client.mjs";
import { config, eventually } from "./helpers.mjs";

const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const optionsSource = readFileSync(new URL("../extension/options.js", import.meta.url), "utf8");
const optionsHtml = readFileSync(new URL("../extension/options.html", import.meta.url), "utf8");
const extensionId = "a".repeat(32);

function background(t, { scheme = "chrome-extension", settings, WebSocketClass = WebSocket } = {}) {
  const origin = `${scheme}://${extensionId}`;
  const local = settings ? { bridgeSettings: settings } : {};
  const session = {};
  const timers = new Set(), intervals = new Set(), sockets = new Set();
  let listener;
  const event = () => ({ addListener() {} });
  const storage = values => ({
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => key in values).map(key => [key, structuredClone(values[key])]));
    },
    async set(update) { Object.assign(values, structuredClone(update)); }
  });
  const chrome = {
    storage: { local: storage(local), session: storage(session) },
    runtime: {
      id: extensionId, getURL: path => `${origin}/${path}`,
      onMessage: { addListener: callback => { listener = callback; } },
      onStartup: event()
    },
    tabs: { onRemoved: event() },
    alarms: { onAlarm: event(), async create() {} },
    action: { onClicked: event() }
  };
  class BrowserSocket extends WebSocketClass {
    constructor(url) { super(url, { origin }); sockets.add(this); }
  }
  const context = {
    chrome, WebSocket: BrowserSocket, URL, crypto: globalThis.crypto,
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay); timers.add(timer); return timer;
    },
    clearTimeout,
    setInterval(callback, delay) {
      const timer = setInterval(callback, delay); intervals.add(timer); return timer;
    },
    clearInterval
  };
  t.after(() => {
    for (const socket of sockets) {
      socket.onclose = null;
      socket.onerror = () => {};
      socket.terminate();
    }
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
  });
  runInNewContext(backgroundSource, context, { filename: "background.js" });
  const sender = { id: extensionId, url: `${origin}/options.html`, tab: { id: 5 }, frameId: 0 };
  return {
    local, chrome, sender, sockets,
    send(message, source = sender) {
      return new Promise((resolve, reject) => {
        let replied = false;
        const timer = setTimeout(() => reject(new Error("Background reply timed out.")), 3000);
        const keepAlive = listener(message, source, value => {
          replied = true; clearTimeout(timer); resolve(value);
        });
        if (keepAlive !== true && !replied) { clearTimeout(timer); resolve(undefined); }
      });
    }
  };
}

test("the options tab receives status even when sender.tab is present", async t => {
  const worker = background(t);
  const state = await worker.send({ type: "bridgeStatus" });
  assert.equal(state?.connected, false);
  assert.equal(state?.ownedAgents, 0);
});

test("status requests also work from an options page without tab metadata", async t => {
  const worker = background(t);
  const { tab, ...sender } = worker.sender;
  assert.equal((await worker.send({ type: "bridgeStatus" }, sender))?.connected, false);
});

test("an options sender with no optional id still requires the exact extension URL", async t => {
  const worker = background(t);
  const { id, ...sender } = worker.sender;
  assert.equal((await worker.send({ type: "bridgeStatus" }, sender))?.connected, false);
  assert.equal(await worker.send({ type: "bridgeStatus" }, {
    ...sender, url: `https://${extensionId}/options.html`
  }), undefined);
});

test("ChatGPT content scripts and other extensions cannot change settings", async t => {
  const worker = background(t);
  for (const sender of [
    { ...worker.sender, url: "https://chatgpt.com/" },
    { ...worker.sender, id: "b".repeat(32) },
    { ...worker.sender, url: `chrome-extension://${"b".repeat(32)}/options.html` }
  ]) {
    assert.equal(await worker.send({ type: "settingsChanged" }, sender), undefined);
    assert.equal(await worker.send({ type: "bridgeStatus" }, sender), undefined);
  }
});

for (const scheme of ["chrome-extension", "extension"]) {
  test(`${scheme} options tab saves settings and waits for broker authentication`, async t => {
    const settings = config(t);
    const service = await startServer(settings);
    settings.port = service.server.address().port;
    t.after(() => service.close());
    const worker = background(t, { scheme });
    await worker.send({ type: "bridgeStatus" });
    worker.local.bridgeSettings = {
      url: `ws://127.0.0.1:${settings.port}/browser`,
      token: settings.browserToken, enabled: true
    };
    const saved = await worker.send({ type: "settingsChanged" });
    assert.equal(saved?.connected, true);
    assert.equal((await request("status", undefined, { config: settings })).browserConnected, true);
  });
}

test("authentication failure is returned to the options page instead of an empty reply", async t => {
  const settings = config(t);
  const service = await startServer(settings);
  settings.port = service.server.address().port;
  t.after(() => service.close());
  const worker = background(t);
  await worker.send({ type: "bridgeStatus" });
  worker.local.bridgeSettings = {
    url: `ws://127.0.0.1:${settings.port}/browser`, token: "wrong".repeat(16), enabled: true
  };
  const state = await worker.send({ type: "settingsChanged" });
  assert.equal(state?.connected, false);
  assert.match(state?.error ?? "", /令牌|Authentication/);
});

test("storage failure is returned as a background error rather than losing the response", async t => {
  const worker = background(t);
  await worker.send({ type: "bridgeStatus" });
  worker.chrome.storage.local.get = async () => { throw new Error("Storage unavailable."); };
  const result = await worker.send({ type: "settingsChanged" });
  assert.equal(result.connected, false);
  assert.equal(result.connecting, false);
  assert.equal(result.error, "Storage unavailable.");
});

async function options(t, sendMessage) {
  const dom = new JSDOM(optionsHtml, {
    url: `https://extension-fixture.invalid/options.html`, runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  dom.window.chrome = {
    runtime: { sendMessage },
    storage: { local: {
      async get() { return {}; },
      async set() {}
    } }
  };
  await dom.window.eval(`(async () => { ${optionsSource}\n })()`);
  return dom.window;
}

test("an empty background response produces an actionable status, not a TypeError", async t => {
  const window = await options(t, (_message, respond) => {
    respond?.(undefined); return Promise.resolve(undefined);
  });
  assert.match(window.document.querySelector("#status").textContent, /后台|重新加载/);
  assert.doesNotMatch(window.document.querySelector("#status").textContent, /undefined|TypeError/);
});

test("a valid background reply renders the options status and counts", async t => {
  const state = { connected: true, ownedAgents: 2, pendingReports: 1 };
  const window = await options(t, (_message, respond) => {
    respond?.(state); return Promise.resolve(state);
  });
  assert.equal(window.document.querySelector("#status").textContent, "已连接");
  assert.equal(window.document.querySelector("#agents").textContent, "2");
  assert.equal(window.document.querySelector("#reports").textContent, "1");
});

test("refresh catches a failed messaging channel without an unhandled rejection", async t => {
  let calls = 0;
  const window = await options(t, (_message, respond) => {
    if (++calls > 1) throw new Error("Extension context invalidated.");
    const state = { connected: false };
    respond?.(state); return Promise.resolve(state);
  });
  window.document.querySelector("#refresh").click();
  await eventually(() => /重新加载|后台/.test(window.document.querySelector("#status").textContent));
});

test("save renders the acknowledged result and releases the disabled controls", async t => {
  const types = [];
  const window = await options(t, (message, respond) => {
    types.push(message.type);
    respond({ connected: message.type === "settingsChanged" });
  });
  window.document.querySelector("#token").value = "test".repeat(16);
  window.document.querySelector("#enabled").checked = true;
  window.document.querySelector("#settings").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await eventually(() => window.document.querySelector("#status").textContent === "已连接");
  assert.deepEqual(types, ["bridgeStatus", "settingsChanged"]);
  assert.equal(window.document.querySelector('button[type="submit"]').disabled, false);
});
