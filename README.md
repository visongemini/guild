# Guild

Guild 是 BDV 独立实现的、双语、本地优先的 macOS 桌面客户端，通过官方 `grok`
进程使用 Grok 4.6。Guild 2 不接入 MiniMax、Ornith 或其他第三方模型，也不提供
OpenAI 兼容路由。当前源码版本为 **2.1.6**。

## 当前状态

Guild 已开放源码，当前仓库包含可构建的桌面客户端源码：

- 原生选择工作区；工作区是任务的父级，可搜索、归档、恢复和删除；
- 同一任务连续多轮对话，支持停止、持久化的后续消息队列和重启续聊；
- ACP 权限选择、思考与工具活动合并展示、Markdown、图片和音频内联显示；
- 从头像面板按需读取官方用量、百分比和重置时间；
- SQLite 本地持久化，以及异常退出、窗口重开和休眠/唤醒后的恢复；
- 简体中文与 English 可持久化切换；浏览器登录态默认不复制；
- macOS arm64 DMG 的安全配置、内容扫描和完整性验证。

源码公开不等于 macOS 安装包已通过 Apple 公证。面向普通用户分发的安装包仍需
Developer ID 签名与公证；开发者可按下方步骤在本机自行构建。

## 下载与安装

普通用户可以从 GitHub Releases 下载 `Guild-2.1.6-arm64.dmg`，打开 DMG 后将 Guild
拖入“应用程序”。当前安装包尚未经过 Apple 公证；macOS 首次启动若提示开发者无法
验证，请在 Finder 中右键 Guild，选择“打开”，并再次确认。不要从第三方网站下载或
执行来历不明的解除隔离命令。

从源码构建需要 Apple Silicon Mac、Node.js 24/npm，以及已经由用户自行安装并登录的
官方 `grok` CLI：

```sh
git clone https://github.com/visongemini/guild.git
cd guild
npm ci
npm test
npm run package:desktop
open apps/desktop/dist/Guild-2.1.6-arm64.dmg
```

`npm ci` 会在首次安装时下载并校验与锁文件一致的 Electron 二进制；桌面构建也会再次
检查它，不再依赖手工执行 Electron。若下载因网络中断失败，恢复网络后运行
`npm run prepare:electron`，再重新打包。

## 开发与验证

Guild 不读取 `~/.grok/auth.json`，也不会代替 Grok 直接请求上游。

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

输出位于 `apps/desktop/dist/Guild-2.1.6-arm64.dmg`。未配置 Apple Developer ID
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
- 所有模型请求都由官方 `grok` 子进程通过 ACP stdio 发出；
- 运行时固定为官方 Grok Build，不提供第三方模型适配器或模型切换入口；
- 不提取凭据来直接调用上游，也不共享登录；
- 对话、工作区、诊断和账号状态默认只保留在本机；仓库不包含用户数据或密钥；
- 第三方运行时、依赖和商标仍受各自权利约束；
- Guild 与 xAI 没有隶属、背书或赞助关系。

## 许可证

Guild 自有源码以 [MIT License](LICENSE) 开源。官方 Grok 运行时、第三方依赖、
字体、图标及商标分别受其自身条款约束，详见 `NOTICE` 与 `THIRD-PARTY-NOTICES`。

---

Guild is BDV's independently implemented, bilingual, local-first macOS desktop client for
the official `grok` process. The current source version is **2.1.6**.

The current branch contains the complete daily-use core: native workspace selection,
workspace-owned tasks, multi-turn conversations, cancellation, durable follow-up queues,
ACP permission choices, official usage display, inline image/audio rendering, local SQLite
persistence, restart and sleep/wake recovery, bilingual UI, and a verified arm64 DMG build.

Apple Silicon users can download `Guild-2.1.6-arm64.dmg` from GitHub Releases. The current
build is not Apple-notarized; on first launch, use Finder's **Open** context-menu action and
confirm macOS's warning. To build from source with Node.js 24 and npm 11:

```sh
git clone https://github.com/visongemini/guild.git
cd guild
npm ci
npm test
npm run package:desktop
open apps/desktop/dist/Guild-2.1.6-arm64.dmg
```

The install and desktop-build paths both prepare and verify the lockfile-pinned Electron binary.
If the first download is interrupted, restore network access and run `npm run prepare:electron`.

Public source availability does not imply an Apple-notarized binary release. Guild never reads
`~/.grok/auth.json`; all model requests originate from the official user-installed Grok process.
Conversation and account data remain local and are not included in this repository. Guild is
not affiliated with, endorsed by, or sponsored by xAI. Guild-owned source is available under
the MIT License; third-party components remain under their own terms.
