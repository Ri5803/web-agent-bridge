import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const base = fileURLToPath(new URL("../../../work/bridge-tests/", import.meta.url));
mkdirSync(base, { recursive: true });
export function config(t, overrides = {}) {
  const dir = mkdtempSync(join(base, "case-"));
  t.after(() => {
    if (!resolve(dir).startsWith(resolve(base) + sep)) throw new Error("Unsafe test cleanup.");
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, port: 0, controlToken: randomBytes(32).toString("hex"),
    browserToken: randomBytes(32).toString("hex"),
    maxAgents: 3, maxParallel: 3, jobTimeoutMs: 30000, codex: null, ...overrides
  };
}
export async function eventually(predicate, timeout = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Condition did not become true.");
    await delay(10);
  }
}
export function complete(store, command, details = {}) {
  return store.report({ jobId: command.jobId, lease: command.lease,
    status: "completed", ...details });
}
