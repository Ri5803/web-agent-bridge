(() => {
  const labels = {
    send: ["Send prompt", "Send message", "Send", "发送提示词", "发送消息", "发送"],
    stop: ["Stop generating", "Stop response", "Stop streaming", "停止回答", "停止生成"],
    login: ["Log in", "登录"],
    blocked: /verify you are human|checking your browser|验证您是人类|验证你是人类|达到.*限额|usage limit/i
  };
  const visible = el => !!el && !el.hidden && el.getAttribute("aria-hidden") !== "true" &&
    getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
  const button = names => Array.from(document.querySelectorAll("button")).find(el =>
    visible(el) && names.includes(el.getAttribute("aria-label") || el.textContent.trim()));
  const normalize = value => value.replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim();
  const assistants = () => Array.from(document.querySelectorAll(
    'main [data-message-author-role="assistant"]'
  )).map(el => ({ id: el.getAttribute("data-message-id"), text: el.innerText ?? el.textContent }));
  const userMessages = () => Array.from(document.querySelectorAll(
    'main [data-message-author-role="user"]'
  )).map(el => ({ id: el.getAttribute("data-message-id"), text: el.innerText ?? el.textContent }));
  const completeStructuredOutput = value => {
    const candidate = value.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) return true;
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      // A streamed JSON object can briefly look finished while its closing
      // characters have not reached the DOM yet.
      return false;
    }
  };

  function snapshot() {
    const composer = document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[aria-label="与 ChatGPT 聊天"]') ||
      document.querySelector('main [role="textbox"][contenteditable="true"]');
    const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="dialog"]'))
      .filter(visible).map(el => el.innerText ?? el.textContent).join("\n");
    return {
      composer, send: button(labels.send), stop: button(labels.stop),
      login: button(labels.login),
      blocked: labels.blocked.test(alerts) ? alerts.slice(0, 2000) : null,
      assistants: assistants(), users: userMessages()
    };
  }

  function completion(baseline, current, prompt) {
    const newUser = current.users.some(user => !baseline.users.has(user.id) &&
      user.id && normalize(user.text) === normalize(prompt));
    const fresh = current.assistants.filter(message => message.id &&
      !baseline.assistants.has(message.id) && message.text.trim());
    const output = fresh.map(message => message.text).join("\n\n");
    return {
      submitted: newUser,
      done: newUser && !current.stop && fresh.length > 0 && completeStructuredOutput(output),
      output
    };
  }

  function insert(composer, prompt) {
    composer.focus();
    if (composer.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(composer, prompt);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: prompt, inputType: "insertText" }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, prompt))
        throw new Error("The editor rejected text insertion; no send was attempted.");
    }
    const value = composer.value ?? composer.innerText ?? composer.textContent;
    if (normalize(value) !== normalize(prompt))
      throw new Error("The composer text did not match the requested message; not sending.");
  }

  globalThis.WebAgentDOM = { snapshot, completion, insert, normalize };
})();
