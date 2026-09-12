import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { loadConfig } from "./config.mjs";

export async function request(route, input, { config = loadConfig(), signal } = {}) {
  return new Promise((resolve, reject) => {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const outgoing = http.request({
      hostname: "127.0.0.1", port: config.port, path: `/api/${route}`,
      method: body === undefined ? "GET" : "POST", signal,
      headers: {
        Authorization: `Bearer ${config.controlToken}`,
        "Content-Type": "application/json",
        ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) })
      }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("error", reject);
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 8000000) outgoing.destroy(new Error("Broker response too large."));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (response.statusCode >= 400) reject(new Error(data.error || `HTTP ${response.statusCode}`));
          else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

export async function ensureServer(config = loadConfig()) {
  try {
    return await request("status", undefined, { config, signal: AbortSignal.timeout(2000) });
  } catch (error) {
    if (error.code !== "ECONNREFUSED") throw error;
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, WEB_AGENT_DATA_DIR: config.dir },
    detached: true, windowsHide: true, stdio: "ignore"
  });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (spawnError) throw spawnError;
    await new Promise(resolve => setTimeout(resolve, 150));
    try { return await request("status", undefined, { config, signal: AbortSignal.timeout(1000) }); }
    catch (error) { if (error.code !== "ECONNREFUSED") throw error; }
  }
  throw new Error("Bridge did not start. Run npm start to inspect the error.");
}
