# Guild

Guild 是 BDV 独立实现的、双语、本地优先的 macOS 桌面客户端，有三个引擎：官方 `grok`
进程（Grok 任务的模型列表跟随官方运行时，不接入第三方模型）、用户自行安装的 Claude Code
（经 ACP 适配器 `@agentclientprotocol/claude-agent-acp` 驱动 `claude`），以及用户自行安装的 OpenAI Codex
（经 ACP 适配器 `@agentclientprotocol/codex-acp`，使用你自己的 ChatGPT 订阅登录）。Claude 任务还可以经本机回环
路由器使用 Online 和 Local 模型，并在工作台使用隔离的浏览器面板。Guild 不提供 OpenAI 兼容路由。
当前源码版本为 **3.0.0（开发中）**，最近发布的安装包为 2.2.1。

## 当前状态

Guild 已开放源码，当前仓库包含可构建的桌面客户端源码：

- 原生选择工作区；工作区是任务的父级，可搜索、归档、恢复和删除；
- 同一任务连续多轮对话，支持停止、持久化的后续消息队列和重启续聊；
- ACP 权限选择、思考与工具活动合并展示、Markdown、图片和音频内联显示；
- 从头像面板按需读取官方用量、百分比和重置时间；
- SQLite 本地持久化，以及异常退出、窗口重开和休眠/唤醒后的恢复；
- 简体中文与 English 可持久化切换；浏览器登录态默认不复制；
- macOS arm64 DMG 的安全配置、内容扫描和完整性验证。

3.0 开发中（设计见 `docs/20-GUILD3-DUAL-ENGINE.md`，决策 D-057 至 D-060；各项按工作包分阶段落地，
当前分支可能尚未全部可用）：

- Claude Code 引擎：任务在第一轮时绑定引擎，之后不再更换；
- 3.1：OpenAI Codex 引擎和通用的多引擎基础（设计见 `docs/21-GUILD31-ENGINES.md`，决策 D-066），以及新的应用图标
  （设置中可选深色或浅色 Dock 图标）；
- 模型来源与本机路由器：Claude 任务内可在 Claude 订阅、Online 和 Local 模型之间切换，但从 Claude 订阅
  切到 Online 或 Local 后不能再切回（要用 Claude 请新建任务）；
- 隔离的浏览器面板，以及智能体可经本机 MCP 服务器操作它的固定工具集。

源码公开不等于 macOS 安装包已通过 Apple 公证。面向普通用户分发的安装包仍需
Developer ID 签名与公证；开发者可按下方步骤在本机自行构建。

## 下载与安装

普通用户可以从 GitHub Releases 下载 `Guild-2.2.1-arm64.dmg`，打开 DMG 后将 Guild
拖入“应用程序”。当前安装包尚未经过 Apple 公证；macOS 首次启动若提示开发者无法
验证，请在 Finder 中右键 Guild，选择“打开”，并再次确认。不要从第三方网站下载或
执行来历不明的解除隔离命令。

已安装的 Guild 只在固定位置查找 `node`、适配器和 `claude`（`~/.local/bin`、`~/.npm-global/bin`、Homebrew 和系统目录，以及 nvm、Volta、asdf、fnm、mise 的最新版本）：
它不读取启动它时的 `PATH`，也不使用他人可写或位于临时目录的文件。

从源码构建需要 Apple Silicon Mac、Node.js 24/npm，以及至少一个由用户自行安装并登录的引擎：
官方 `grok` CLI，和/或 `claude`（Claude Code）加 `claude-agent-acp` 适配器，和/或 `codex-acp` 适配器
（`npm install -g @agentclientprotocol/codex-acp`，再用 `codex login` 登录；适配器需要 Node.js >= 22）。Guild 不分发其中任何一个：

```sh
git clone https://github.com/visongemini/guild.git
cd guild
npm ci
npm test
npm run package:desktop
open apps/desktop/dist/Guild-<version>-arm64.dmg
```

`npm ci` 会在首次安装时下载并校验与锁文件一致的 Electron 二进制；桌面构建也会再次
检查它，不再依赖手工执行 Electron。若下载因网络中断失败，恢复网络后运行
`npm run prepare:electron`，再重新打包。

## 开发与验证

Guild 不读取 `~/.grok/auth.json`，也不读取 Claude 或 Codex 的登录凭据，也不会代替 Grok 直接请求上游。

```sh
npm ci
npm test
npm audit
npm run start:desktop
```

生成并自动验证 arm64 安装包：

```sh
npm run package:desktop
```

输出位于 `apps/desktop/dist/Guild-<version>-arm64.dmg`。未配置 Apple Developer ID
时只会生成临时签名构建；为使没有 Team ID 的 Electron 子组件能够启动，该内部构建
显式关闭了 library validation。它不应作为面向公众的安装包发布。正式发行必须由同一
Developer ID 签完整个应用、移除这项临时权限并完成公证。

应用数据独立存放在 `~/Library/Application Support/Guild-v2`，不会触碰冻结的
Guild 1.1.x 数据目录。

## 隐私与独立实现边界

仓库从内容寻址的过滤规格开始，不继承 Guild 1.1 的源码或 Git 对象。冻结的
Guild 1.1.13 只作为黑盒视觉与交互基准；它的渲染器、程序包、私有数据和旧源码
都不是实现输入。

- Guild 是单用户本地客户端，不是共享 API 网关；
- Grok 任务的所有模型请求都由官方 `grok` 子进程通过 ACP stdio 发出，只使用官方 Grok 模型；
- Claude 任务的请求由用户自行安装的 `claude` 发出；Online 和 Local 模型经 Guild 在 `127.0.0.1`
  上的本机路由器转发，该路由器仅回环、单用户、带随机令牌，不对外开放；
- Codex 任务的请求由用户自行安装的 Codex 适配器和它自带的 Codex 内核发出，使用你自己的 ChatGPT 订阅登录；Guild 不读取
  `~/.codex`，不调用适配器的认证方法，也不提供 API 密钥输入框；
- 不提取凭据来直接调用上游：Guild 不读取 Grok、Claude 或 Codex 的登录凭据，也不共享登录；路由任务里的
  Claude Code 只带 Guild 生成的一次性令牌，Claude 订阅的登录信息不会经过路由器，路由器也不会连接
  Anthropic；
- Online 模型会把对话发送给该模型的厂商：对话每换到一个新的厂商时会先提醒，内容包括 CLAUDE.md、
  记忆、对话以及对话里的浏览器页面文本和截图，可按工作区选择不再提醒；Local 模型的请求只留在本机或
  你自己的 Tailscale 网络内，路由任务里 Claude Code 自己的后台请求（例如生成标题和摘要）和子代理也走
  最近一次启动时所用的第三方模型，不再发往 Anthropic；
- 第三方模型的密钥从你指定的环境变量文件读取，只在内存中使用，不写入数据库、日志或界面；新增来源或
  修改其地址、密钥变量须经原生确认框；
- 浏览器面板使用独立的存储分区和沙箱，访问不到 Node 或 Guild 自身界面；智能体只能使用固定工具集
  （没有 eval），每次调用都遵循该引擎当前的权限模式（除非权限模式或你选过「始终允许」，否则会先询问）；
- 对话、工作区、诊断和账号状态默认只保留在本机；仓库不包含用户数据或密钥；
- 第三方运行时、依赖和商标仍受各自权利约束；
- Guild 与 xAI、Anthropic、OpenAI 均没有隶属、背书或赞助关系。

## 许可证

Guild 自有源码以 [MIT License](LICENSE) 开源。官方 Grok 运行时、Claude Code、Codex 与 ACP 适配器（均由
用户自行安装，不随 Guild 分发）、第三方依赖、字体、图标及商标分别受其自身条款约束，详见 `NOTICE`
与 `THIRD-PARTY-NOTICES`。

---

Guild is BDV's independently implemented, bilingual, local-first macOS desktop client with three
engines: the official `grok` process, the user-installed Claude Code (the `claude` binary driven
through the ACP adapter `@agentclientprotocol/claude-agent-acp`), and the user-installed OpenAI Codex
(through the ACP adapter `@agentclientprotocol/codex-acp`, on your own ChatGPT subscription login). Inside a Claude task the user can
also use Online and Local models through a loopback router, and the workbench has an isolated browser
pane. The current source version is **3.0.0 (in development)**; the latest released package is 2.2.1.

The current branch contains the complete daily-use core: native workspace selection,
workspace-owned tasks, multi-turn conversations, cancellation, durable follow-up queues,
ACP permission choices, official usage display, inline image/audio rendering, local SQLite
persistence, restart and sleep/wake recovery, bilingual UI, and a verified arm64 DMG build.

The 3.0 work (Claude engine, model sources and router, browser pane; design in
`docs/20-GUILD3-DUAL-ENGINE.md`, decisions D-057 to D-060) lands in stages, so the current branch may
not have all of it yet. Guild 3.1 adds the Codex engine and a generic multi-engine foundation
(`docs/21-GUILD31-ENGINES.md`, decision D-066) and a new app icon with a dark or light Dock icon choice in Settings.

Apple Silicon users can download `Guild-2.2.1-arm64.dmg` from GitHub Releases. The current
build is not Apple-notarized; on first launch, use Finder's **Open** context-menu action and
confirm macOS's warning. An installed Guild looks for `node`, the adapters and `claude` only in fixed places (`~/.local/bin`, `~/.npm-global/bin`, the Homebrew and
system directories, and the newest releases of nvm, Volta, asdf, fnm and mise): it does not read the `PATH` it was started with and does not
use a file that others can write or that sits in a temporary directory. The files it runs in place (`claude`, the adapter packages and the Codex core)
must also be owned by you or root and writable by neither group nor others, with every folder above them: a Homebrew prefix that the admin group can write does not qualify,
so install those under your home folder (Settings > Engines names the path when Guild refuses one).

Building from source needs Node.js 24 and npm 11, plus at least one
user-installed and logged-in engine: the official `grok` CLI, and/or `claude` (Claude Code) with the
`claude-agent-acp` adapter, and/or the `codex-acp` adapter (`npm install -g @agentclientprotocol/codex-acp`,
then `codex login`; the adapters need Node.js >= 22). Guild distributes none of them.

```sh
git clone https://github.com/visongemini/guild.git
cd guild
npm ci
npm test
npm run package:desktop
open apps/desktop/dist/Guild-<version>-arm64.dmg
```

The install and desktop-build paths both prepare and verify the lockfile-pinned Electron binary.
If the first download is interrupted, restore network access and run `npm run prepare:electron`.

Public source availability does not imply an Apple-notarized binary release. Guild never reads
`~/.grok/auth.json`, Claude credentials or `~/.codex`. Requests of Grok tasks originate from the official
user-installed Grok process and use official Grok models only; requests of Codex tasks originate from the
user-installed Codex adapter and the Codex core it ships, on your own ChatGPT login (Guild never calls the
adapter's authentication method and has no API key field for it); requests of Claude tasks originate
from the user-installed `claude`, and Online and Local models are reached through a loopback-only,
single-user router on `127.0.0.1` that is never exposed to the network. The first switch of a
conversation to an Online model of a given vendor shows a reminder that CLAUDE.md, memory, the
conversation, and browser page text or screenshots in the conversation will be sent to that vendor,
and a different vendor asks again; requests to Local models stay on your machine or your own
Tailscale network. In such a routed task Claude Code carries a throwaway token that Guild generated,
so your Claude subscription login never reaches the router and the router never connects to Anthropic;
Claude Code's own background requests (titles, summaries) and subagents use the third-party model the
process started with. Switching the task back to a Claude subscription model restarts Claude Code natively
and resumes the same conversation, so the login goes straight to Anthropic and still never passes through
the router, and OpenViking's automatic capture stays off for a task that has used a third-party model. Keys for Online and Local sources are read from an env file you
designate, kept in memory only and never stored, and adding or changing a source needs a native
confirmation. The browser pane runs in its own sandboxed partition, and agents reach it only through a
fixed tool set with no eval, where every call follows the engine's permission mode (it prompts unless
the mode or an "always allow" choice permits it). Conversation and account data remain local and are not included
in this repository. Guild is not affiliated with, endorsed by, or sponsored by xAI, Anthropic or OpenAI.
Guild-owned source is available under the MIT License; third-party components, and the user-installed
Grok, Claude Code, Codex and adapters, remain under their own terms.
