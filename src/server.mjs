import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig, safeEqual } from "./config.mjs";
import { Store, BridgeError } from "./store.mjs";
import { Notifier } from "./notifier.mjs";

const json = (response, status, body) => {
  if (response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
};

async function body(request) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new BridgeError("Content-Type must be application/json.", 415);
  let size = 0, chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1200000) throw new BridgeError("Request too large.", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new BridgeError("Invalid JSON."); }
}

export async function startServer(config) {
  const store = new Store(config);
  const notifier = new Notifier(store);
  let driver = null;
  let stopped = false;
  let closeService;
  const dispatch = () => {
    if (!driver || driver.readyState !== WebSocket.OPEN || stopped) return;
    let command;
    while ((command = store.claim())) driver.send(JSON.stringify(command));
  };
  store.on("queued", dispatch);
  store.on("cancel", message => {
    if (driver?.readyState === WebSocket.OPEN) driver.send(JSON.stringify(message));
  });
  const server = http.createServer(async (request, response) => {
    try {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress))
        throw new BridgeError("Loopback access only.", 403);
      const url = new URL(request.url, `http://127.0.0.1:${config.port}`);
      if (request.method === "GET" && url.pathname === "/health")
        return json(response, 200, { service: "web-agent-bridge", version: "0.1.0" });
      if (request.headers.origin)
        throw new BridgeError("Browser-origin HTTP control requests are not allowed.", 403);
      if (!safeEqual(request.headers.authorization, `Bearer ${config.controlToken}`))
        throw new BridgeError("Unauthorized.", 401);
      if (request.method === "GET" && url.pathname === "/api/status")
        return json(response, 200, {
          browserConnected: !!driver,
          notification: config.codex ? {
            configured: true, threadId: config.codex.threadId,
            meaning: "accepted = App Server acknowledged; not proof the model read it"
          } : { configured: false },
          agents: Object.values(store.state.agents).map(({ instructions, ...rest }) => rest),
          jobs: Object.values(store.state.jobs).map(({ text, lease, output, ...rest }) => rest),
          deliveries: store.state.deliveries
        });
      if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const id = url.pathname.slice("/api/jobs/".length);
        return json(response, 200, store.job(id));
      }
      if (request.method !== "POST") throw new BridgeError("Unknown route.", 404);
      const input = await body(request);
      let result;
      switch (url.pathname) {
        case "/api/create": result = store.create(input); break;
        case "/api/send": result = store.send(input); break;
        case "/api/close": result = store.closeAgent(input); break;
        case "/api/reopen": result = store.reopen(input); break;
        case "/api/cancel": result = store.cancel(input.jobId); break;
        case "/api/shutdown":
          result = { stopping: true };
          setImmediate(() => void closeService());
          break;
        case "/api/wait": {
          const timeout = input.timeoutMs ?? 600000;
          if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000)
            throw new BridgeError("timeoutMs must be 1..3600000.");
          const controller = new AbortController();
          const abort = () => controller.abort();
          response.on("close", abort);
          try { result = await store.wait(input.jobId, timeout, controller.signal); }
          finally { response.off("close", abort); }
          break;
        }
        default: throw new BridgeError("Unknown route.", 404);
      }
      json(response, 200, result);
    } catch (error) {
      json(response, error.status || 500, { error: error.message });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1200000 });
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
    if (!local || request.url !== "/browser" ||
        (origin && !/^(?:chrome-extension|extension):\/\/[a-p]{32}$/.test(origin))) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws));
  });
  wss.on("connection", ws => {
    let authenticated = false;
    const deadline = setTimeout(() => ws.close(1008, "Authentication required."), 5000);
    ws.on("message", data => {
      try {
        const message = JSON.parse(data.toString());
        if (!authenticated) {
          if (message.type !== "hello" || !safeEqual(message.token, config.browserToken)) {
            ws.close(1008, "Authentication failed."); return;
          }
          if (driver) { ws.close(1013, "Another browser driver is already connected."); return; }
          clearTimeout(deadline);
          authenticated = true;
          driver = ws;
          ws.send(JSON.stringify({ type: "ready", maxParallel: config.maxParallel }));
          dispatch();
          return;
        }
        if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        else if (message.type === "report") {
          const result = store.report(message);
          ws.send(JSON.stringify({ type: "ack", reportId: message.reportId, ...result }));
        } else throw new BridgeError("Unknown browser message.");
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", error: error.message }));
      }
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      if (driver === ws) {
        driver = null;
        store.disconnect();
      }
    });
    ws.on("error", () => {});
  });
  const expiry = setInterval(() => store.expire(), 1000);
  expiry.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  closeService = async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(expiry);
      notifier.close();
      store.off("queued", dispatch);
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
  };
  return { server, store, close: closeService };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const service = await startServer(config);
  console.log(`Web Agent Bridge listening on 127.0.0.1:${config.port}`);
  const stop = () => service.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
