import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

export const terminal = new Set(["completed", "failed", "cancelled", "timed_out", "needs_attention"]);
const copy = value => structuredClone(value);
const now = () => new Date().toISOString();

export class BridgeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function text(value, name, max = 100000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new BridgeError(`${name} must be a nonempty string, at most ${max} characters.`);
  return value;
}

export function conversationUrl(value) {
  if (value == null) return null;
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com" || !/^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname))
    throw new BridgeError("Unexpected conversation URL.");
  return url.origin + url.pathname;
}

export class Store extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.file = join(config.dir, "state.json");
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : { version: 1, agents: {}, jobs: {}, keys: {}, events: [], deliveries: {} };
    if (this.state.version !== 1) throw new Error("Unsupported state version.");
    // A crash can occur after the site accepted a prompt. Never silently send it again.
    for (const job of Object.values(this.state.jobs)) {
      if (job.status === "running") {
        this.finish(job.id, "needs_attention", {
          error: "Bridge restarted during execution. Inspect the conversation before retrying."
        });
      }
    }
    for (const delivery of Object.values(this.state.deliveries)) {
      if (delivery.status === "sending") {
        delivery.status = "uncertain";
        delivery.error = "Restarted while submitting notification; not automatically duplicated.";
      }
    }
    this.save();
  }

  save() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  existing(key, signature) {
    if (!key) throw new BridgeError("requestKey is required for safe retries.");
    text(key, "requestKey", 200);
    const existing = this.state.keys[key];
    if (existing && existing.signature !== signature)
      throw new BridgeError("requestKey was already used for a different request.", 409);
    return existing ? copy(this.state.jobs[existing.jobId]) : null;
  }

  create({ name, instructions = "", requestKey }) {
    text(name, "name", 120);
    if (typeof instructions !== "string" || instructions.length > 50000)
      throw new BridgeError("Invalid instructions.");
    const signature = JSON.stringify(["create", name, instructions]);
    const existing = this.existing(requestKey, signature);
    if (existing) return { agent: copy(this.agent(existing.agentId)), job: existing };
    if (Object.values(this.state.agents).filter(a => a.status !== "closed").length >= this.config.maxAgents)
      throw new BridgeError("Active agent limit reached. Close an idle agent first.", 409);
    const agent = {
      id: randomUUID(), name, instructions, status: "creating",
      conversationUrl: null, createdAt: now(), initialized: false
    };
    this.state.agents[agent.id] = agent;
    const job = this.enqueue(agent, "create", "", requestKey, signature);
    return { agent: copy(agent), job };
  }

  send({ agentId, text: message, requestKey }) {
    text(message, "text");
    const signature = JSON.stringify(["send", agentId, message]);
    const existing = this.existing(requestKey, signature);
    if (existing) return existing;
    const agent = this.agent(agentId);
    if (["closed", "blocked"].includes(agent.status))
      throw new BridgeError("Agent is closed or needs attention. Reopen/recover it explicitly.", 409);
    if (Object.values(this.state.jobs).some(j => j.agentId === agentId && !terminal.has(j.status)))
      throw new BridgeError("This agent already has a pending job. Wait before sending a follow-up.", 409);
    return this.enqueue(agent, "send", message, requestKey, signature);
  }

  closeAgent({ agentId, requestKey }) {
    const signature = JSON.stringify(["close", agentId]);
    const existing = this.existing(requestKey, signature);
    if (existing) return existing;
    const agent = this.agent(agentId);
    if (Object.values(this.state.jobs).some(j => j.agentId === agentId && !terminal.has(j.status)))
      throw new BridgeError("Cancel the pending job before closing this agent.", 409);
    return this.enqueue(agent, "close", "", requestKey, signature);
  }

  reopen({ agentId, requestKey }) {
    const signature = JSON.stringify(["reopen", agentId]);
    const existing = this.existing(requestKey, signature);
    if (existing) return existing;
    const agent = this.agent(agentId);
    if (!["closed", "blocked"].includes(agent.status))
      throw new BridgeError("Only a closed or blocked agent can be reopened.", 409);
    if (agent.status === "closed" &&
        Object.values(this.state.agents).filter(a => a.status !== "closed").length >= this.config.maxAgents)
      throw new BridgeError("Active agent limit reached.", 409);
    agent.status = "creating";
    return this.enqueue(agent, "create", "", requestKey, signature);
  }

  enqueue(agent, kind, message, requestKey, signature) {
    const job = {
      id: randomUUID(), agentId: agent.id, kind, text: message,
      status: "queued", createdAt: now(), submitted: false, output: null,
      error: null, lease: null
    };
    this.state.jobs[job.id] = job;
    this.state.keys[requestKey] = { signature, jobId: job.id };
    this.save();
    this.emit("queued");
    return copy(job);
  }

  agent(id) {
    const agent = this.state.agents[id];
    if (!agent) throw new BridgeError("Unknown agent.", 404);
    return agent;
  }
  job(id) {
    const job = this.state.jobs[id];
    if (!job) throw new BridgeError("Unknown job.", 404);
    return job;
  }

  claim() {
    const running = Object.values(this.state.jobs).filter(j => j.status === "running");
    if (running.length >= this.config.maxParallel) return null;
    const job = Object.values(this.state.jobs).find(j => j.status === "queued" &&
      !running.some(r => r.agentId === j.agentId));
    if (!job) return null;
    const agent = this.agent(job.agentId);
    job.status = "running";
    job.lease = randomUUID();
    job.startedAt = now();
    job.deadline = Date.now() + this.config.jobTimeoutMs;
    agent.status = job.kind === "create" ? "creating" : "busy";
    this.save();
    return {
      type: "command", jobId: job.id, lease: job.lease, agentId: agent.id,
      kind: job.kind, conversationUrl: agent.conversationUrl,
      prompt: job.kind === "send"
        ? (!agent.initialized && agent.instructions
          ? `${agent.instructions}\n\n${job.text}` : job.text)
        : "",
      timeoutMs: this.config.jobTimeoutMs
    };
  }

  report(message) {
    const job = this.job(message.jobId);
    if (message.lease !== job.lease)
      return { ignored: true };
    if (job.status !== "running") {
      if (terminal.has(job.status) && job.status !== "completed" &&
          typeof message.output === "string" && message.output.length <= 1000000) {
        job.lateOutput = message.output;
        if (message.conversationUrl)
          this.agent(job.agentId).conversationUrl = conversationUrl(message.conversationUrl);
        this.save();
        return { ignored: true, recovered: true };
      }
      return { ignored: true };
    }
    if (message.conversationUrl)
      this.agent(job.agentId).conversationUrl = conversationUrl(message.conversationUrl);
    if (message.phase === "submitted") {
      job.submitted = true;
      this.agent(job.agentId).initialized = true;
      this.save();
      return { accepted: true };
    }
    if (!["completed", "failed", "needs_attention"].includes(message.status))
      throw new BridgeError("Unexpected driver report.");
    if (message.output != null && (typeof message.output !== "string" || message.output.length > 1000000))
      throw new BridgeError("Output too large.");
    return this.finish(job.id, message.status, {
      output: message.output ?? null,
      error: message.error ? String(message.error).slice(0, 4000) : null
    });
  }

  finish(id, status, details = {}) {
    const job = this.job(id);
    if (terminal.has(job.status)) return copy(job);
    if (!terminal.has(status)) throw new BridgeError("Invalid final status.");
    Object.assign(job, details, { status, completedAt: now() });
    const agent = this.agent(job.agentId);
    agent.status = status === "completed"
      ? (job.kind === "close" ? "closed" : "idle")
      : "blocked";
    if (job.kind === "send" && status === "completed") agent.initialized = true;
    const event = {
      id: randomUUID(), type: `job.${status}`, at: now(),
      agentId: agent.id, agentName: agent.name, jobId: job.id, kind: job.kind,
      status, conversationUrl: agent.conversationUrl,
      output: job.output, error: job.error, trust: "untrusted_external_model_output"
    };
    this.state.events.push(event);
    this.state.deliveries[event.id] = {
      status: this.config.codex ? "pending" : "not_configured", attempts: 0,
      targetThreadId: this.config.codex?.threadId ?? null
    };
    this.save();
    this.emit("event", copy(event));
    this.emit(`job:${id}`, copy(job));
    this.emit("queued");
    return copy(job);
  }

  cancel(id) {
    const job = this.job(id);
    if (terminal.has(job.status)) return copy(job);
    const command = {
      type: "cancel", agentId: job.agentId, jobId: id, lease: job.lease
    };
    const result = this.finish(id, "cancelled", {
      error: "Cancellation requested. A submitted website response may still finish; inspect before reuse."
    });
    this.emit("cancel", command);
    return result;
  }

  disconnect() {
    for (const job of Object.values(this.state.jobs)) {
      if (job.status === "running")
        this.finish(job.id, "needs_attention", {
          error: "Browser disconnected. No prompt was automatically resubmitted."
        });
    }
  }

  expire(at = Date.now()) {
    for (const job of Object.values(this.state.jobs)) {
      if (job.status === "running" && job.deadline <= at) {
        this.emit("cancel", { type: "cancel", agentId: job.agentId, jobId: job.id, lease: job.lease });
        this.finish(job.id, "timed_out", { error: "Timed out. Inspect the webpage before retrying." });
      }
    }
  }

  wait(id, timeoutMs = 600000, signal) {
    const job = this.job(id);
    if (terminal.has(job.status)) return Promise.resolve(copy(job));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off(`job:${id}`, done);
        signal?.removeEventListener("abort", abort);
      };
      const done = result => { cleanup(); resolve(result); };
      const abort = () => { cleanup(); reject(new BridgeError("Wait cancelled.", 499)); };
      const timer = setTimeout(() => done({ ...copy(this.job(id)), waitTimedOut: true }), timeoutMs);
      this.once(`job:${id}`, done);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
