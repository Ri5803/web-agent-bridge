# 把网页 GPT 变成你的子代理

**Web Agent Bridge：让 Codex 分派任务，让多个网页 GPT 并行完成。**

一个研究方案，一个寻找反例，一个检查遗漏。
主代理继续推进，你不用在多个聊天窗口之间来回复制粘贴。

Web Agent Bridge 通过本地 MCP 服务和浏览器扩展，把独立的 ChatGPT 网页对话
接入 Codex 工作流：自动创建新对话、并行分派任务、保留上下文续聊。
网页任务完成后，通过原生中转把原文结果回传给正在工作的主代理，
不必反复打开网页查看进度。

**MIT 开源，本地部署，核心网页链路无需 API Key。**
需要保持浏览器在线并登录 ChatGPT，仍受账号额度和网页兼容性限制。

A local MCP bridge for parallel ChatGPT webpage conversations, event-based
results, and optional native Codex relay notifications.

这是社区开发的实验性项目，不是 OpenAI 官方产品，也不是 ChatGPT 网页 API。
请遵守所用服务的条款、账号权限及使用限额。项目不保证特定模型、
网页长期兼容性或无人值守运行。

## 功能

- 动态创建网页会话，使用稳定的 `agentId`，不依赖标签页位置。
- 创建代理时可为新对话指定 `model` 和 `reasoning_effort`，不指定则使用账号默认值。
- 默认最多 3 个活动网页代理；不同代理可以并行，同一代理一次一个任务。
- 提供发送、原文结果、事件等待、取消、关闭和恢复操作。
- 初始角色说明只随第一条消息发送；后续复用网页会话上下文。
- 幂等请求键、任务状态持久化、断线与超时后的显式恢复。
- 浏览器通过 DOM 变化监听回复，不要求主模型反复截图等待。
- 原生中转子代理可等待网页结果，并通过原生完成通知回到主代理。

“网页代理”不是一个新的操作系统子进程，也不自动获得本机工具权限。
原生中转模式需要宿主提供原生子代理工具，并占用相应名额和模型调用。

## 架构

```text
Codex / MCP client
  -> local broker (loopback HTTP)
  -> authenticated browser extension (WebSocket)
  -> independent ChatGPT conversations

Webpage completion
  -> broker completion event
  -> native relay finishes
  -> parent receives the native completion notification
```

主代理直接调用 `web_agent_wait` 会阻塞该工具调用。
让原生中转子代理负责等待，主代理才能继续其他工作。
主回合结束、应用退出或机器休眠后的自动唤醒未验证。
可选 App Server 直连通知是另一条路径，不是运行本桥接的必要条件。

## 环境要求

- Node.js 22 或更新版本，以及 npm。
- Chrome 116+ 或兼容的 Chromium 浏览器；已进行 Windows + Edge 在线验收。
- 已在安装扩展的浏览器中登录、能够正常使用的 ChatGPT 账号。
- 支持本地 stdio MCP 的客户端。原生中转通知还需要原生子代理工具。
- 浏览器能够访问 ChatGPT，扩展能够访问本机服务。

核心网页路径不需要 OpenAI API Key。不同对话使用同一个浏览器账号，
不提供独立账号额度或账号级记忆隔离。当前主要支持文本任务，
不自动上传文件、在已有对话中切换模型或处理验证码。

创建代理时可以传入 ChatGPT 模型 slug 和思考强度。例如：

```json
{
  "name": "反例分析",
  "model": "gpt-5",
  "reasoning_effort": "high",
  "requestKey": "create-counterexample-agent"
}
```

这两个选项只用于打开新的网页对话；未知或不可用的模型可能由 ChatGPT
回退到账号默认值。本桥接会保留请求值，但不会把网页选择器的最终状态伪装成已确认。

## 安装

在仓库根目录运行：

```sh
npm ci
node scripts/configure.mjs --data-dir ../web-agent-private
```

`--data-dir` 用于指定私有运行目录，建议放在仓库外。
程序会在该目录生成本机连接令牌，并在仓库中生成 `.mcp.json`。
`.mcp.json` 包含本机绝对路径，已经加入忽略列表，不要提交。

然后安装浏览器扩展：

1. 打开浏览器扩展管理页，启用开发人员模式。
2. 加载仓库中的 `extension` 文件夹。
3. 打开扩展选项，服务地址填写 `ws://127.0.0.1:19347/browser`。
4. 从私有运行目录的 `config.json` 读取 `browserToken`，填入连接令牌。
5. 勾选启用并保存。不要把 `controlToken` 填入扩展。

注册 MCP 时，以生成的 `.mcp.json` 为本机配置依据。Codex CLI 示例：

```sh
codex mcp add web_agent_bridge --env WEB_AGENT_DATA_DIR=/absolute/private/runtime -- node /absolute/repository/src/mcp.mjs
```

将示例路径替换为当前机器的实际路径；有空格的路径需要引号。
为 `mcp_servers.web_agent_bridge` 设置 `tool_timeout_sec = 3700`，
以容纳最长一小时的事件等待。注册后在新会话检查工具是否可用。

可选的 `.codex-plugin/plugin.json` 是本地插件描述文件。
它引用安装时生成的 `.mcp.json`，因此必须先运行配置命令再安装插件；
本仓库没有自动安装插件市场或修改全局配置。

Windows 用户也可使用 `scripts/setup.ps1 -DataDir <private-directory>`。
本地服务可由首次 MCP 调用按需启动；也可以在设置
`WEB_AGENT_DATA_DIR` 后运行 `node src/cli.mjs start`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `web_agent_create` | 创建新会话并返回代理和准备任务 ID |
| `web_agent_send` | 给指定代理发消息 |
| `web_agent_status` | 查看连接、代理、任务与直连通知状态 |
| `web_agent_result` | 读取某项任务的原文结果 |
| `web_agent_wait` | 等待任务完成事件 |
| `web_agent_cancel` | 请求停止任务 |
| `web_agent_close` | 关闭托管标签页，不删除云端历史 |
| `web_agent_reopen` | 恢复保存的会话，不自动重发旧提示词 |

创建、发送、关闭和恢复需要唯一 `requestKey`。同一操作的重试复用该键，
不要对不确定是否提交的提示词换新键重发。准备任务完成后才能发送。

例如对 Codex 说：

> 创建两个网页代理，分别分析方案和寻找反例。使用原生中转子代理收发和等待，
> 网页完成后通过子代理完成通知回传结果，不要让中转模型代替网页模型回答。

更多操作见 [使用指南](USER-GUIDE.md)，数据边界见 [安全说明](SECURITY.md)。

## 验证与限制

```sh
npm test
npm run check
```

当前包含 34 项自动化测试，覆盖调度、幂等性、事件等待、恢复、
鉴权、扩展通信、DOM 判定以及模拟 App Server 通知。

开发环境曾完成两个真实网页会话的并行收发、同会话续聊、关闭后恢复，
并在主线程活动期间收到原生中转完成通知。
个人会话 URL、账号信息及原始运行记录不随公开源码发布。
这些验收不是所有账号、模型、浏览器或未来网页版本的兼容保证。

取消、超时或断线不保证网页已经停止生成。应先检查原任务和网页状态，
再决定是否继续，程序不会把不确定的结果伪装为成功。

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
