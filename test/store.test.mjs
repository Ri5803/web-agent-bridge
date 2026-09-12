import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { config, complete } from "./helpers.mjs";

test("dynamic agents have independent IDs and enforce an explicit capacity", t => {
  const store = new Store(config(t, { maxAgents: 2 }));
  const a = store.create({ name: "A", requestKey: "a" });
  const b = store.create({ name: "B", requestKey: "b" });
  assert.notEqual(a.agent.id, b.agent.id);
  assert.throws(() => store.create({ name: "C", requestKey: "c" }), /limit/);
  assert.equal(store.claim().agentId, a.agent.id);
  assert.equal(store.claim().agentId, b.agent.id);
  assert.equal(store.claim(), null);
});

test("idempotency keys do not create duplicate tabs or duplicate submissions", t => {
  const store = new Store(config(t));
  const create = { name: "A", instructions: "Role", requestKey: "a" };
  const first = store.create(create);
  assert.equal(store.create(create).job.id, first.job.id);
  assert.throws(() => store.create({ ...create, name: "Different" }), /different request/);
  complete(store, store.claim());
  const send = { agentId: first.agent.id, text: "One", requestKey: "one" };
  const job = store.send(send);
  assert.equal(store.send(send).id, job.id);
  assert.throws(() => store.send({ ...send, requestKey: "two" }), /pending job/);
  assert.equal(Object.values(store.state.jobs).filter(job => job.kind === "send").length, 1);
});

test("follow-ups reuse conversation URL and send role instructions only once", t => {
  const store = new Store(config(t));
  const { agent } = store.create({ name: "A", instructions: "You are A.", requestKey: "a" });
  complete(store, store.claim());
  store.send({ agentId: agent.id, text: "First", requestKey: "one" });
  const first = store.claim();
  assert.equal(first.prompt, "You are A.\n\nFirst");
  store.report({ jobId: first.jobId, lease: first.lease, phase: "submitted",
    conversationUrl: "https://chatgpt.com/c/conversation-a" });
  complete(store, first, { output: "Answer" });
  store.send({ agentId: agent.id, text: "Second", requestKey: "two" });
  const second = store.claim();
  assert.equal(second.prompt, "Second");
  assert.equal(second.conversationUrl, "https://chatgpt.com/c/conversation-a");
});

test("wait resolves from the completion event without polling", async t => {
  const store = new Store(config(t));
  const { job } = store.create({ name: "A", requestKey: "a" });
  const command = store.claim();
  const pending = store.wait(job.id, 2000);
  assert.equal(store.listenerCount(`job:${job.id}`), 1);
  complete(store, command);
  assert.equal((await pending).status, "completed");
  assert.equal(store.listenerCount(`job:${job.id}`), 0);
});

test("wait timeout is not a job timeout, and abort removes listeners", async t => {
  const store = new Store(config(t));
  const { job } = store.create({ name: "A", requestKey: "a" });
  assert.equal((await store.wait(job.id, 5)).waitTimedOut, true);
  assert.equal(store.job(job.id).status, "queued");
  const controller = new AbortController();
  const wait = store.wait(job.id, 2000, controller.signal);
  controller.abort();
  await assert.rejects(wait, /Wait cancelled/);
  assert.equal(store.listenerCount(`job:${job.id}`), 0);
});

test("cancelled jobs never silently become completed from a late report", t => {
  const store = new Store(config(t));
  const { agent, job } = store.create({ name: "A", requestKey: "a" });
  const command = store.claim();
  const events = [];
  store.on("event", event => events.push(event));
  store.cancel(job.id);
  complete(store, command, { output: "late text" });
  assert.equal(store.job(job.id).status, "cancelled");
  assert.equal(store.job(job.id).lateOutput, "late text");
  assert.equal(store.agent(agent.id).status, "blocked");
  assert.equal(events.length, 1);
});

test("disconnect and restart require explicit recovery, never resend", t => {
  const settings = config(t);
  const store = new Store(settings);
  const { agent, job } = store.create({ name: "A", requestKey: "a" });
  store.claim();
  const recovered = new Store(settings);
  assert.equal(recovered.job(job.id).status, "needs_attention");
  assert.equal(recovered.claim(), null);
  assert.throws(() => recovered.send({ agentId: agent.id, text: "Retry", requestKey: "retry" }), /attention/);
  recovered.reopen({ agentId: agent.id, requestKey: "reopen" });
  assert.equal(recovered.claim().kind, "create");
});

test("stale leases, foreign URLs, and huge output cannot contaminate another task", t => {
  const store = new Store(config(t));
  store.create({ name: "A", requestKey: "a" });
  const command = store.claim();
  assert.deepEqual(store.report({ jobId: command.jobId, lease: "wrong", status: "completed" }), { ignored: true });
  assert.throws(() => complete(store, command, { conversationUrl: "https://evil.example/c/a" }), /Unexpected/);
  assert.throws(() => complete(store, command, { output: "a".repeat(1000001) }), /too large/);
  assert.equal(store.job(command.jobId).status, "running");
});

test("closing frees a slot and reopening preserves the original conversation", t => {
  const store = new Store(config(t, { maxAgents: 1 }));
  const { agent } = store.create({ name: "A", requestKey: "a" });
  complete(store, store.claim(), { conversationUrl: "https://chatgpt.com/c/saved" });
  store.closeAgent({ agentId: agent.id, requestKey: "close" });
  complete(store, store.claim());
  assert.equal(store.agent(agent.id).status, "closed");
  store.reopen({ agentId: agent.id, requestKey: "reopen" });
  assert.equal(store.claim().conversationUrl, "https://chatgpt.com/c/saved");
});

test("job timeout is terminal and doesn't claim successful delivery", t => {
  const store = new Store(config(t));
  const { job } = store.create({ name: "A", requestKey: "a" });
  const command = store.claim();
  store.expire(store.job(job.id).deadline + 1);
  assert.equal(store.job(job.id).status, "timed_out");
  complete(store, command);
  assert.equal(store.job(job.id).status, "timed_out");
  assert.equal(Object.values(store.state.deliveries)[0].status, "not_configured");
});
