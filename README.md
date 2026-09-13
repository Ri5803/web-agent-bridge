# 让网页端 GPT 变成你的真正的子代理

这个项目解决的不是“网页端 GPT 能不能回答问题”，而是：

**能不能把网页端 GPT 的额度，真正接入主代理的工作流。**

主代理可以把一部分分析、审查、整理和执行任务交给网页 GPT，
自己把额度留给规划、判断、整合和最终决策。
这样，任务仍然在推进，但主代理不必为每一步都消耗自己的额度。

关键在于：这不是让你手动多开几个聊天窗口。

## 为什么它是真正的子代理？

桥接之后，主代理可以动态创建新的网页 GPT 对话，直接发送任务，
让多个网页 GPT 并行工作；任务完成后，结果会自动回到主代理。
主代理不需要手动切换窗口、复制粘贴，也不需要反复轮询。
它还可以继续追问同一个代理，或者根据结果创建下一个代理，
把整个过程接入原本的工作流。

所以这里说的“真正的子代理”，指的是它在主代理面前具备完整的代理效力：

- 可以被动态创建
- 可以被直接派发任务
- 可以拥有独立上下文
- 可以并行执行
- 可以自动回报完成
- 可以被继续追问、取消、恢复和关闭

普通网页端 GPT 只能作为一个由人手动使用的聊天窗口；
桥接后的网页 GPT，则成为主代理可以直接调度的协作节点。

## 这意味着什么？

它节省的是主代理的额度，但不会把工作流退回到“人负责盯网页”的模式。
对主代理来说，网页 GPT 的使用方式已经接近普通子代理：
创建、发送、等待、接收、续聊，然后继续推进任务。

所谓“相同的效力”，是指**在主代理工作流中的协作效力相同**，
并不意味着底层实现和权限完全相同。
它仍然运行在浏览器里的 ChatGPT 对话中，受浏览器登录状态、
ChatGPT 账号额度和网页兼容性限制，也不会自动获得主代理的本地文件、
终端或桌面权限。

项目还可以另外接入 Windows Desktop MCP，但桌面控制属于独立的权限层。
核心网页能力仍然是：把网页端 GPT 的额度接入主代理，
同时保留真正子代理所需要的创建、通信、并行、回传和续聊能力。

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

桌面操控默认关闭。Windows 用户确认需要后，可以在配置时显式开启：

```sh
node scripts/configure.mjs --data-dir ../web-agent-private --enable-desktop
```

开启后，MCP 客户端会获得可选的 Windows Desktop 工具。它们能查看窗口、截图、
启动应用、点击、滚动、输入文字和发送按键；输入操作会直接作用于当前电脑，
请只在信任的主代理和本机环境中启用。当前版本使用 Windows 原生桌面接口，
暂不提供 macOS/Linux 实现。网页 GPT 子代理不会凭空获得这些权限；如果希望网页端
模型直接调用桌面工具，还需要把 Desktop MCP 端点通过受保护的 MCP Tunnel 接入
ChatGPT Developer mode。

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
| `desktop_list_windows` | 列出可见桌面窗口 |
| `desktop_list_apps` | 列出桌面应用及其窗口 |
| `desktop_observe` | 截取指定窗口并返回图片 |
| `desktop_launch_app` | 启动应用，不带命令参数 |
| `desktop_focus` | 激活指定窗口 |
| `desktop_click` | 点击窗口内坐标 |
| `desktop_scroll` | 在窗口内滚动 |
| `desktop_type` | 输入文字 |
| `desktop_keypress` | 发送按键或组合键 |

桌面工具同样遵循“先观察、再操作”的顺序：先调用
`desktop_list_windows`，再调用 `desktop_observe`，最后使用截图中的窗口坐标。

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

当前包含 35 项自动化测试，覆盖调度、幂等性、事件等待、恢复、
鉴权、扩展通信、DOM 判定以及模拟 App Server 通知。

开发环境曾完成两个真实网页会话的并行收发、同会话续聊、关闭后恢复，
并在主线程活动期间收到原生中转完成通知。
个人会话 URL、账号信息及原始运行记录不随公开源码发布。
这些验收不是所有账号、模型、浏览器或未来网页版本的兼容保证。

取消、超时或断线不保证网页已经停止生成。应先检查原任务和网页状态，
再决定是否继续，程序不会把不确定的结果伪装为成功。

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
