import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

export function runtimeDir() {
  return resolve(process.env.WEB_AGENT_DATA_DIR || ".runtime");
}

export function loadConfig(dir = runtimeDir()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify({
      version: 1,
      port: 19347,
      controlToken: randomBytes(32).toString("hex"),
      browserToken: randomBytes(32).toString("hex"),
      maxAgents: 3,
      maxParallel: 3,
      jobTimeoutMs: 600000,
      codex: null
    }, null, 2), { mode: 0o600, flag: "wx" });
  }
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
    throw new Error("Invalid local port.");
  if (!Number.isInteger(config.maxAgents) || config.maxAgents < 1 || config.maxAgents > 20)
    throw new Error("maxAgents must be 1..20.");
  if (!Number.isInteger(config.maxParallel) || config.maxParallel < 1 ||
      config.maxParallel > config.maxAgents) throw new Error("Invalid maxParallel.");
  if (!Number.isInteger(config.jobTimeoutMs) || config.jobTimeoutMs < 1000 ||
      config.jobTimeoutMs > 3600000) throw new Error("Invalid jobTimeoutMs.");
  for (const key of ["controlToken", "browserToken"]) {
    if (typeof config[key] !== "string" || config[key].length < 32)
      throw new Error(`Invalid ${key}.`);
  }
  if (config.codex) {
    const url = new URL(config.codex.url);
    if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Codex endpoint must be a loopback ws:// address.");
    if (typeof config.codex.threadId !== "string" || !config.codex.threadId)
      throw new Error("An explicit Codex target threadId is required.");
  }
  return { ...config, dir };
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
