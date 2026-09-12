(() => {
  let active = null;
  const DOM = globalThis.WebAgentDOM;
  const currentUrl = () => /^\/c\/[a-zA-Z0-9-]+$/.test(location.pathname)
    ? location.origin + location.pathname : null;
  const report = message => chrome.runtime.sendMessage({ type: "pageReport", ...message }).catch(() => {});

  function observeUntil(check, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        observer.disconnect();
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value);
      };
      const inspect = () => {
        try { const result = check(); if (result) finish(null, result); }
        catch (error) { finish(error); }
      };
      const abort = () => finish(new Error("Cancelled."));
      const observer = new MutationObserver(inspect);
      const timer = setTimeout(() => finish(new Error("Page readiness timed out.")), timeoutMs);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else inspect();
    });
  }

  async function ready(signal) {
    return observeUntil(() => {
      const state = DOM.snapshot();
      if (state.blocked) throw new Error("The page requires user attention: " + state.blocked);
      if (state.login) throw new Error("Log in to ChatGPT in this browser first.");
      if (state.composer && !state.stop) return state;
      return null;
    }, 30000, signal);
  }

  async function run(command) {
    if (active) throw new Error("This page is already handling a job.");
    const controller = new AbortController();
    const ticket = { ...command, controller };
    active = ticket;
    let clicked = false;
    let observer, timeout, settle;
    const cleanup = () => {
      observer?.disconnect();
      clearTimeout(timeout);
      clearTimeout(settle);
      if (active === ticket) active = null;
    };
    try {
      const initial = await ready(controller.signal);
      if (controller.signal.aborted) throw new Error("Cancelled before submission.");
      if (command.kind === "create") {
        cleanup();
        await report({ jobId: command.jobId, lease: command.lease,
          status: "completed", conversationUrl: currentUrl(), output: "Conversation is ready." });
        return;
      }
      if (command.kind !== "send") throw new Error("Unsupported page command.");
      const draft = initial.composer.value ?? initial.composer.innerText ?? initial.composer.textContent;
      if (DOM.normalize(draft)) throw new Error("The owned tab contains a draft. It was not overwritten.");
      const baseline = {
        assistants: new Set(initial.assistants.map(message => message.id)),
        users: new Set(initial.users.map(message => message.id))
      };
      DOM.insert(initial.composer, command.prompt);
      const prepared = await observeUntil(() => {
        const state = DOM.snapshot();
        return state.send && !state.send.disabled ? state : null;
      }, 5000, controller.signal);
      await new Promise((resolve, reject) => {
        let submitted = false, lastOutput = null;
        const inspect = () => {
          const state = DOM.snapshot();
          if (state.blocked || state.login) {
            reject(new Error("The page requires login, verification, or limit recovery.")); return;
          }
          const result = DOM.completion(baseline, state, command.prompt);
          if (result.submitted && !submitted) {
            submitted = true;
            void report({ jobId: command.jobId, lease: command.lease,
              phase: "submitted", conversationUrl: currentUrl() });
          }
          if (!result.done) { clearTimeout(settle); settle = null; return; }
          if (result.output === lastOutput && settle) return;
          clearTimeout(settle);
          lastOutput = result.output;
          settle = setTimeout(() => {
            const verified = DOM.completion(baseline, DOM.snapshot(), command.prompt);
            if (!verified.done || verified.output !== lastOutput) { settle = null; return; }
            if (!currentUrl()) {
              reject(new Error("A stable conversation URL was not created. Login may be required."));
              return;
            }
            resolve(verified.output);
          }, 1000);
        };
        observer = new MutationObserver(inspect);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
        timeout = setTimeout(() => reject(new Error("Reply completion timed out; not resending.")), command.timeoutMs);
        controller.signal.addEventListener("abort", () => reject(new Error("Cancelled.")), { once: true });
        if (controller.signal.aborted) { reject(new Error("Cancelled.")); return; }
        clicked = true;
        prepared.send.click();
        inspect();
      }).then(output => {
        cleanup();
        return report({
          jobId: command.jobId, lease: command.lease, status: "completed",
          conversationUrl: currentUrl(), output
        });
      });
    } catch (error) {
      cleanup();
      await report({
        jobId: command.jobId, lease: command.lease,
        status: clicked ? "needs_attention" : "failed",
        error: error.message, conversationUrl: currentUrl()
      });
    } finally {
      cleanup();
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message.type === "pageCommand") {
      if (active) { respond({ accepted: false, error: "Page busy." }); return false; }
      respond({ accepted: true });
      void run(message.command);
    } else if (message.type === "pageCancel") {
      if (active?.jobId === message.jobId && active.lease === message.lease) {
        const state = DOM.snapshot();
        state.stop?.click();
        active.controller.abort();
      }
      respond({ accepted: true });
    } else if (message.type === "pagePing") respond({ ready: true });
    return false;
  });
  void chrome.runtime.sendMessage({ type: "pageReady" }).catch(() => {});
})();
