import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { eventually } from "./helpers.mjs";

const domSource = readFileSync(new URL("../extension/dom.js", import.meta.url), "utf8");
const contentSource = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
function fixture(t) {
  const dom = new JSDOM('<main><div id="prompt-textarea" role="textbox" contenteditable="true"></div><button aria-label="发送提示词">Send</button><section id="messages"></section></main>', {
    url: "https://chatgpt.com/c/test-conversation", runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  dom.window.eval(domSource);
  return dom;
}
const empty = () => ({ assistants: new Set(), users: new Set() });

test("an old reply or the wrong user echo is not completion", t => {
  const dom = fixture(t), api = dom.window.WebAgentDOM;
  const document = dom.window.document;
  document.querySelector("#messages").innerHTML =
    '<div data-message-author-role="assistant" data-message-id="old">Old answer</div>';
  assert.equal(api.completion(empty(), api.snapshot(), "New prompt").done, false);
  document.querySelector("#messages").innerHTML +=
    '<div data-message-author-role="user" data-message-id="u">Different prompt</div>';
  assert.equal(api.completion(empty(), api.snapshot(), "New prompt").done, false);
});

test("a visible stop button prevents premature completion", t => {
  const dom = fixture(t), api = dom.window.WebAgentDOM;
  dom.window.document.querySelector("#messages").innerHTML =
    '<div data-message-author-role="user" data-message-id="u">Hello</div>' +
    '<div data-message-author-role="assistant" data-message-id="a">Partial answer</div>' +
    '<button aria-label="停止回答"></button>';
  assert.equal(api.completion(empty(), api.snapshot(), "Hello").done, false);
  dom.window.document.querySelector('[aria-label="停止回答"]').remove();
  const result = api.completion(empty(), api.snapshot(), "Hello");
  assert.equal(result.done, true);
  assert.equal(result.output, "Partial answer");
});

test("an incomplete JSON reply is not completion", t => {
  const dom = fixture(t), api = dom.window.WebAgentDOM;
  dom.window.document.querySelector("#messages").innerHTML =
    '<div data-message-author-role="user" data-message-id="u">Hello</div>' +
    '<div data-message-author-role="assistant" data-message-id="a">{"marker":"RI-VIDEO-731</div>';
  const result = api.completion(empty(), api.snapshot(), "Hello");
  assert.equal(result.done, false);
  assert.equal(result.output, '{"marker":"RI-VIDEO-731');

  dom.window.document.querySelector('[data-message-author-role="assistant"]').textContent =
    '{"marker":"RI-VIDEO-7319","executed":false}';
  assert.equal(api.completion(empty(), api.snapshot(), "Hello").done, true);
});

test("content worker observes the new reply and emits its own final report", async t => {
  const dom = fixture(t);
  const { window } = dom;
  const messages = [];
  let listener;
  window.chrome = { runtime: {
    id: "test-extension",
    sendMessage: async message => { messages.push(message); return {}; },
    onMessage: { addListener: handler => { listener = handler; } }
  } };
  window.document.execCommand = (_action, _ui, value) => {
    window.document.querySelector("#prompt-textarea").textContent = value;
    return true;
  };
  window.document.querySelector('[aria-label="发送提示词"]').onclick = () => {
    window.document.querySelector("#prompt-textarea").textContent = "";
    const area = window.document.querySelector("#messages");
    area.innerHTML = '<div data-message-author-role="user" data-message-id="u">Hello</div>' +
      '<button aria-label="停止回答"></button>';
    window.setTimeout(() => {
      area.innerHTML += '<div data-message-author-role="assistant" data-message-id="a">Reply</div>';
      area.querySelector("button").remove();
    }, 10);
  };
  window.eval(contentSource);
  listener({ type: "pageCommand", command: {
    kind: "send", jobId: "job", lease: "lease", prompt: "Hello", timeoutMs: 3000
  } }, { id: "test-extension" }, () => {});
  await eventually(() => messages.some(message => message.status === "completed"), 4000);
  const complete = messages.find(message => message.status === "completed");
  assert.equal(complete.output, "Reply");
  assert.equal(complete.conversationUrl, "https://chatgpt.com/c/test-conversation");
  assert.ok(messages.some(message => message.phase === "submitted"));
});

test("the content worker preserves a draft instead of overwriting it", async t => {
  const dom = fixture(t), messages = [];
  let listener;
  dom.window.document.querySelector("#prompt-textarea").textContent = "User draft";
  dom.window.chrome = { runtime: {
    id: "test-extension",
    sendMessage: async message => { messages.push(message); },
    onMessage: { addListener: handler => { listener = handler; } }
  } };
  dom.window.eval(contentSource);
  listener({ type: "pageCommand", command: {
    kind: "send", jobId: "j", lease: "l", prompt: "Hello", timeoutMs: 1000
  } }, { id: "test-extension" }, () => {});
  await eventually(() => messages.some(message => message.status === "failed"));
  assert.equal(dom.window.document.querySelector("#prompt-textarea").textContent, "User draft");
});
