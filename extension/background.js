let socket = null;
let heartbeat = null;
let status = { connected: false, connecting: false, error: null };
let connectionGeneration = 0;
let settleConnection = null;
const jobs = new Map();
const cancelled = new Set();
const readyWaiters = new Map();
const reportBuffer = new Map();
const owned = new Map();
let loaded = false;
let loading = null;

async function load() {
  if (loaded) return;
  if (!loading) loading = (async () => {
    const saved = await chrome.storage.local.get(["ownedConversations", "pendingReports"]);
    const session = await chrome.storage.session.get("ownedTabs");
    for (const [id, value] of Object.entries(saved.ownedConversations || {})) {
      const transient = session.ownedTabs?.[id];
      owned.set(id, { conversationUrl: value.conversationUrl,
        tabId: transient?.conversationUrl === value.conversationUrl ? transient.tabId : null });
    }
    for (const [id, value] of Object.entries(saved.pendingReports || {})) reportBuffer.set(id, value);
    loaded = true;
  })().finally(() => { loading = null; });
  return loading;
}
const currentStatus = () => ({ ...status, ownedAgents: owned.size, pendingReports: reportBuffer.size });
const saveOwned = () => Promise.all([
  chrome.storage.local.set({ ownedConversations: Object.fromEntries(
    Array.from(owned, ([id, value]) => [id, { conversationUrl: value.conversationUrl }])
  ) }),
  chrome.storage.session.set({ ownedTabs: Object.fromEntries(owned) })
]);
const saveReports = () => chrome.storage.local.set({ pendingReports: Object.fromEntries(reportBuffer) });

function validUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" &&
      (url.pathname === "/" || /^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname));
  } catch { return false; }
}

async function sendReport(message) {
  const report = { ...message, type: "report", reportId: crypto.randomUUID() };
  reportBuffer.set(report.reportId, report);
  await saveReports();
  if (status.connected) socket.send(JSON.stringify(report));
}

async function waitForPage(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "pagePing" });
    if (reply?.ready) return;
  } catch { /* Newly created documents do not have a content script yet. */ }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyWaiters.delete(tabId);
      reject(new Error("ChatGPT did not load its bridge content script."));
    }, 35000);
    readyWaiters.set(tabId, () => { clearTimeout(timer); resolve(); });
    // Recheck after registering the waiter to avoid a pageReady registration race.
    chrome.tabs.sendMessage(tabId, { type: "pagePing" }).then(reply => {
      if (reply?.ready) { readyWaiters.get(tabId)?.(); readyWaiters.delete(tabId); }
    }).catch(() => {});
  });
}

async function execute(command) {
  await load();
  const { agentId, jobId, lease } = command;
  if (jobs.has(agentId)) throw new Error("Agent already has a browser job.");
  jobs.set(agentId, command);
  try {
    if (cancelled.has(jobId)) throw new Error("Cancelled before dispatch.");
    let binding = owned.get(agentId);
    let tab = null;
    if (binding?.tabId != null) {
      try { tab = await chrome.tabs.get(binding.tabId); } catch { /* Closed tab. */ }
      if (tab && !validUrl(tab.url)) throw new Error("The bridge-owned tab was navigated away; not reusing it.");
      if (tab && binding.conversationUrl && tab.url?.split("?")[0] !== binding.conversationUrl)
        throw new Error("The tab is no longer on this agent's conversation.");
    }
    if (command.kind === "close") {
      if (tab) await chrome.tabs.remove(tab.id);
      owned.delete(agentId);
      await saveOwned();
      jobs.delete(agentId);
      await sendReport({ jobId, lease, status: "completed", output: "Owned tab closed. Cloud conversation was not deleted." });
      return;
    }
    const target = command.conversationUrl || binding?.conversationUrl || "https://chatgpt.com/";
    if (!validUrl(target)) throw new Error("Unexpected conversation URL.");
    if (!tab) {
      tab = await chrome.tabs.create({ url: target, active: false });
      binding = { tabId: tab.id, conversationUrl: target === "https://chatgpt.com/" ? null : target };
      owned.set(agentId, binding);
      await saveOwned();
    }
    command.tabId = tab.id;
    await waitForPage(tab.id);
    if (cancelled.has(jobId)) throw new Error("Cancelled before page submission.");
    const reply = await chrome.tabs.sendMessage(tab.id, { type: "pageCommand", command });
    if (!reply?.accepted) throw new Error(reply?.error || "Page did not accept the command.");
  } catch (error) {
    jobs.delete(agentId);
    cancelled.delete(jobId);
    await sendReport({ jobId, lease, status: "needs_attention", error: error.message });
  }
}

async function connect() {
  const generation = ++connectionGeneration;
  settleConnection?.();
  clearInterval(heartbeat);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  status = { connected: false, connecting: true, error: null };
  try {
    await load();
    const { bridgeSettings } = await chrome.storage.local.get("bridgeSettings");
    if (generation !== connectionGeneration) return currentStatus();
    if (!bridgeSettings?.enabled) {
      status = { connected: false, connecting: false, errorCode: "disabled", error: "Disabled" };
      return currentStatus();
    }
    const url = new URL(bridgeSettings.url);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/browser" ||
        url.search || url.hash || url.username || url.password || !bridgeSettings.token)
      throw new Error("Use a loopback browser endpoint and its browser token.");
    const ws = new WebSocket(url.href);
    socket = ws;
    const isCurrent = () => socket === ws && generation === connectionGeneration;
    // A successful save means the broker acknowledged the token, not just that a socket was created.
    return await new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        if (settleConnection === finish) settleConnection = null;
        resolve(currentStatus());
      };
      const deadline = setTimeout(() => {
        if (!isCurrent()) { finish(); return; }
        status = { connected: false, connecting: false,
          errorCode: "handshake_timeout", error: "The local broker did not acknowledge the connection." };
        finish();
        ws.close();
      }, 10000);
      settleConnection = finish;
      ws.onopen = () => {
        if (isCurrent()) ws.send(JSON.stringify({ type: "hello", token: bridgeSettings.token }));
      };
      ws.onmessage = async event => {
        if (!isCurrent()) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        try {
          if (message.type === "ready") {
            status = { connected: true, connecting: false, error: null };
            finish();
            for (const report of reportBuffer.values()) ws.send(JSON.stringify(report));
            clearInterval(heartbeat);
            heartbeat = setInterval(() => {
              if (isCurrent() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
            }, 20000);
          } else if (message.type === "command") {
            void execute(message).catch(error => { status.error = error.message; });
          } else if (message.type === "cancel") {
            cancelled.add(message.jobId);
            const job = jobs.get(message.agentId);
            if (job?.jobId === message.jobId && job.lease === message.lease && job.tabId) {
              await chrome.tabs.sendMessage(job.tabId, {
                type: "pageCancel", jobId: job.jobId, lease: job.lease
              }).catch(() => {});
            }
          } else if (message.type === "ack") {
            reportBuffer.delete(message.reportId);
            await saveReports();
          } else if (message.type === "error") status.error = message.error;
        } catch (error) { status.error = error.message; }
      };
      ws.onclose = event => {
        if (!isCurrent()) return;
        status.connected = false;
        status.connecting = false;
        if (event.code === 1008) {
          status.errorCode = "authentication_failed";
          status.error = "Authentication failed. Check the browser token.";
        } else if (event.code === 1013) {
          status.errorCode = "driver_busy";
          status.error = "Another browser driver is already connected.";
        } else if (!status.error) {
          status.errorCode = "disconnected";
          status.error = "Broker connection closed.";
        }
        clearInterval(heartbeat);
        finish();
        void chrome.alarms.create("bridgeReconnect", { delayInMinutes: 0.5 });
      };
      ws.onerror = () => {
        if (!isCurrent()) return;
        status.errorCode = "connection_failed";
        status.error = "Could not connect to the local broker.";
      };
    });
  } catch (error) {
    if (generation === connectionGeneration)
      status = { connected: false, connecting: false, errorCode: "background_error", error: error.message };
    return currentStatus();
  }
}

function isOptionsPage(sender) {
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  try {
    const expected = new URL(chrome.runtime.getURL("options.html"));
    const actual = new URL(sender.url);
    return actual.protocol === expected.protocol && actual.host === expected.host &&
      actual.pathname === expected.pathname && !actual.username && !actual.password &&
      (sender.frameId == null || sender.frameId === 0);
  } catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== "string") return false;
  // Options pages can be tabs too. Authenticate their extension URL, not the absence of sender.tab.
  if (isOptionsPage(sender) && ["settingsChanged", "bridgeStatus"].includes(message.type)) {
    const result = message.type === "settingsChanged" ? connect() : load().then(currentStatus);
    result.then(respond).catch(error => respond({
      ...currentStatus(), errorCode: "background_error", error: error.message
    }));
    return true;
  }
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab || !sender.url?.startsWith("https://chatgpt.com/")) return false;
  if (message.type === "pageReady") {
    readyWaiters.get(sender.tab.id)?.();
    readyWaiters.delete(sender.tab.id);
    respond({ accepted: true });
  } else if (message.type === "pageReport") {
    const entry = Array.from(jobs.entries()).find(([, job]) =>
      job.tabId === sender.tab.id && job.jobId === message.jobId && job.lease === message.lease);
    if (!entry) { respond({ ignored: true }); return false; }
    const [agentId, job] = entry;
    if (message.conversationUrl) {
      if (!validUrl(message.conversationUrl) || !message.conversationUrl.includes("/c/")) {
        respond({ ignored: true }); return false;
      }
      owned.get(agentId).conversationUrl = message.conversationUrl;
    }
    if (message.status) {
      jobs.delete(agentId);
      cancelled.delete(job.jobId);
    }
    Promise.all([saveOwned(), sendReport({
      jobId: job.jobId, lease: job.lease, status: message.status, phase: message.phase,
      conversationUrl: message.conversationUrl, output: message.output, error: message.error
    })]).then(() => respond({ accepted: true }));
    return true;
  }
  return false;
});
chrome.tabs.onRemoved.addListener(tabId => {
  for (const [agentId, job] of jobs) {
    if (job.tabId !== tabId || job.kind === "close") continue;
    jobs.delete(agentId);
    void sendReport({ jobId: job.jobId, lease: job.lease,
      status: "needs_attention", error: "The owned ChatGPT tab was closed." });
  }
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "bridgeReconnect") void connect(); });
chrome.runtime.onStartup.addListener(() => void connect());
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
void connect();
