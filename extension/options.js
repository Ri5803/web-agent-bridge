const form = document.querySelector("#settings");
const field = id => document.querySelector(`#${id}`);
const reloadMessage = "扩展后台未返回有效状态。请在扩展管理页重新加载 Web Agent Bridge，再关闭并重新打开此配置页。";
const errors = {
  disabled: "未启用连接",
  authentication_failed: "连接令牌未通过验证，请重新粘贴浏览器连接令牌。",
  driver_busy: "另一个浏览器扩展已连接。请只保留一个启用的 Web Agent Bridge。",
  connection_failed: "无法连接本地服务，请确认服务已启动。",
  disconnected: "本地服务连接已断开，正在等待重连。",
  handshake_timeout: "本地服务未确认连接，请检查服务是否正常运行。"
};
function askBackground(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reloadMessage)), 15000);
    try {
      chrome.runtime.sendMessage({ type }, response => {
        clearTimeout(timer);
        if (chrome.runtime.lastError || !response || typeof response.connected !== "boolean") {
          reject(new Error(reloadMessage));
          return;
        }
        resolve(response);
      });
    } catch {
      clearTimeout(timer);
      reject(new Error(reloadMessage));
    }
  });
}
function render(state) {
  field("status").textContent = state.connected ? "已连接" : state.connecting ? "正在连接…"
    : errors[state.errorCode] || state.error || "未连接";
  field("agents").textContent = state.ownedAgents ?? 0;
  field("reports").textContent = state.pendingReports ?? 0;
}
async function refresh() {
  try { render(await askBackground("bridgeStatus")); }
  catch (error) { field("status").textContent = error.message; }
}
try {
  const { bridgeSettings } = await chrome.storage.local.get("bridgeSettings");
  if (bridgeSettings) {
    field("url").value = bridgeSettings.url;
    field("token").value = bridgeSettings.token;
    field("enabled").checked = bridgeSettings.enabled;
  }
} catch { field("status").textContent = reloadMessage; }
function busy(value) {
  form.querySelector('button[type="submit"]').disabled = value;
  field("refresh").disabled = value;
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  busy(true);
  try {
    const url = new URL(field("url").value.trim());
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" ||
        url.pathname !== "/browser" || url.search || url.hash || url.username || url.password)
      throw new Error("服务地址必须为 ws://127.0.0.1:端口/browser");
    const token = field("token").value.trim();
    if (token.length < 32) throw new Error("连接令牌长度不足。");
    await chrome.storage.local.set({ bridgeSettings: {
      url: url.href, token, enabled: field("enabled").checked
    } });
    field("status").textContent = "正在连接…";
    render(await askBackground("settingsChanged"));
  } catch (error) { field("status").textContent = error.message; }
  finally { busy(false); }
});
field("refresh").addEventListener("click", () => void refresh());
await refresh();
