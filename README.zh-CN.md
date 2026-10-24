<div align="center">

# herdr-web

**把 [herdr](https://herdr.dev) 里的 Claude Code 和 Codex 会话，变成浏览器里的聊天应用。**

[![CI](https://github.com/FL-Penly/herdr-web/actions/workflows/ci.yml/badge.svg)](https://github.com/FL-Penly/herdr-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · 简体中文

</div>

herdr 在终端窗格里跑你的编程 agent。herdr-web 把同样的会话显示成对话线程，你可以在任何浏览器（包括手机）
里阅读、回答和引导它们。agent 依旧跑在 herdr 里：网页端读取它们的会话记录和屏幕，并像你一样往窗格里打字。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/chat-dark.png">
  <img alt="herdr-web 中的一个 Claude Code 会话：对话线程、带选项的权限确认，以及会话侧栏" src="docs/assets/chat-light.png">
</picture>

## 功能

- **所有会话一个侧栏。** herdr 各工作区里的 Claude Code 和 Codex 窗格全部列出，带实时状态、git 分支、当前在做
  什么以及已经跑了多久。
- **需要你的事放进收件箱。** 权限确认、提问、打开的对话框和跑完的轮次会排到最前面，标签页标题显示数量，并弹出
  提示，可选提示音和桌面通知。可以标记为已处理，或推迟一小时再提醒。
- **对话线程，而不是终端回滚。** 回复直接读自会话记录（Claude）或 rollout（Codex），以 Markdown 渲染。工具调用
  分组、可折叠，编辑带 diff，目标（`/goal`）显示为一条横栏。agent 工作时，正在写的回复会从它的屏幕上实时显示；
  提出的计划完整展示。Codex 不会告诉外部某个窗格在写哪个 rollout，所以靠推断并对照终端核实；如果某个窗格仍显示
  别的会话，用它 ⋯ 菜单里的「同步会话…」纠正。
- **在浏览器里回答。** 允许或拒绝权限，在 `AskUserQuestion` 里选一项或自己写答案（多个问题时显示答到第几题，
  提交前列出每题的回答），回答 Codex 排队的问题而不打断它
  工作，也可以直接按 `1`–`9` / `Esc`。
- **真正的输入框。** 回复；agent 工作时追加的消息会排队；停止它并把你的消息还给你；切换模型和推理强度；用 `/`
  搜索内置命令、你自己的命令和技能。粘贴或拖入图片和文件，会自动上传并把路径写进消息。
- **需要时就切到终端。** 每个窗格一键切成完整的 xterm.js 终端：只读旁观或接管控制，触屏上有 `Esc`、`Tab`、
  `Ctrl-C` 和方向键的按键栏。
- **审阅改动。** 查看工作区的 diff，新文件完整显示，并把审阅意见发回给 agent。
- **从任意回复分叉。** 通过自带的 [quick-fork](plugin/quick-fork) 插件，从结尾或更早的某条回复把会话分叉到新标签页
  或分屏。Claude Code 的分叉沿用原会话的启动参数和环境变量，Codex 的分叉沿用环境变量。
- **新建会话。** 选目录（列出最近用过的目录，输入路径时自动补全）：已有工作区在这个目录里，会话就放进去；
  没有的话就新建一个以目录名命名的工作区（可以改名，也可以换成别的工作区）。再选 Claude Code、Codex 或普通
  shell，选模型和推理强度，写下第一条消息；agent 就绪后自动发出。侧栏里工作区的菜单可以给它改名。
- **哪里都顺手。** 浅色和深色主题、可以添加到主屏幕的手机布局（见[在手机上用](#在手机上用)）、命令面板（`Ctrl/⌘ K`），界面语言按浏览器在中文和英文之间自动选择。

<img alt="终端视图：xterm.js 中的 herdr 窗格" src="docs/assets/terminal.png">

## 环境要求

- [herdr](https://herdr.dev) 0.9.5 或更新版本，跑在同一台机器上
- [Bun](https://bun.sh) 1.3.7 或更新版本（更早的版本在 WebSocket 握手里重复发协议头，浏览器会拒绝连接）
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和/或 [Codex CLI](https://github.com/openai/codex)
- Linux。macOS 也能用，但因为没有 `/proc`，有两处缺口：分叉出的会话不会继承原会话的环境变量，Codex 会话和窗格
  的对应可能没那么准。

## 快速开始

```sh
git clone https://github.com/FL-Penly/herdr-web.git
cd herdr-web
bun install
bun start
```

打开它打印出的地址。地址里 `#t=` 后面是访问 token：页面用它登录，把它保存在这个浏览器里，再把它从地址栏去掉。
token 放在 URL 的片段（`#` 之后）里，浏览器从不把这部分发给服务端或代理。这个链接在轮换 token 之前一直有效，请像
密码一样对待它。如果不是在终端里启动的（systemd、nohup），用 `bun run url` 获取地址。不带 token 打开地址会看到登录
界面，把 token（或整个链接）粘贴进去即可；在主机上用 `bun run url` 或 `cat ~/.config/herdr-web/token` 可以看到它。

## 远程访问与安全

herdr-web 能往 herdr 的每个窗格里打字。能访问到它的人，就能以你的身份执行命令。请像对待 SSH 一样对待它。

- 默认只监听 `127.0.0.1`。每个请求都需要访问 token，它会一次性生成到 `~/.config/herdr-web/token`（权限
  `0600`）。删掉这个文件并重启 herdr-web 即可轮换 token。
- 要从其他设备访问，按以下顺序优先选择：
  1. SSH 隧道：`ssh -L 12500:127.0.0.1:12500 your-host`，然后打开 `http://localhost:12500/#t=…`；
  2. Tailscale、WireGuard 这类私有网络；
  3. 在 `127.0.0.1:12500` 前面放一个带 TLS 的反向代理（Caddy、nginx）。
- `HERDR_WEB_HOST=0.0.0.0` 会通过明文 HTTP 在所有网卡上暴露界面。只在你信任的网络里这样做，并且绝不要和
  `HERDR_WEB_TOKEN=off` 一起用（服务端会拒绝这种组合）。
- 不使用 cookie。浏览器把 token 存在这个源（协议、主机**和**端口）的本地存储里，同一台主机其他端口上的页面读不到它；
  每个请求都带上它（`Authorization: Bearer …`，WebSocket 则用子协议）。页面本身（HTML、脚本、样式、图标）不含任何
  秘密，不需要 token 就能加载。来自其他源的 WebSocket 升级和会改变状态的请求也会被拒绝。设置菜单里的「退出登录」会
  让这台设备忘掉 token。

威胁模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 在手机上用

herdr-web 专门为在手机上盯着、指挥 agent 做了适配。在手机上打开一次登录链接（怎么连到主机见上一节），或者打开
地址后把 token 粘贴到登录界面，手机浏览器会记住它。

- **添加到主屏幕**，当成全屏 App 用：iPhone 上用 Safari 的「分享 → 添加到主屏幕」，Android 上用 Chrome 菜单里的
  「添加到主屏幕 / 安装应用」。iPhone 主屏幕 App 的存储和 Safari 是分开的，所以第一次打开会看到登录界面：粘贴登录
  链接（`bun run url` 打印的那个）或只粘贴其中的 token。
- **单手就能操作。** 从屏幕左侧往右滑打开会话列表，点蓝色的收件箱按钮直达「需要你」，长按会话或标签页打开窗格菜单
  （复制窗格 ID、派活命令、重命名）。返回键 / 返回手势会先关掉最上层的抽屉、菜单或面板。
- **回答和回复。** 权限和提问卡片是整行的大按钮。输入框里回车是换行，圆形按钮负责发送（或停止 agent）。`+` 可以直接
  拍照上传。
- **终端**有一行按键（Esc、Tab、粘滞的 Ctrl、^C、方向键、回车）、字号按钮，以及方便复制的「选择文字」视图。开始打字
  就会接管窗格，并把它调整成手机的宽度。
- **通知：** 在设置里打开「系统通知」。浏览器只在 HTTPS 或 `http://localhost`（SSH 隧道也算）下允许通知；而且没有
  推送服务器，只有 herdr-web 还在后台运行时手机才会收到。

手机一般不在 herdr 主机上，所以这就是远程访问，上一节的内容全部适用。优先用 Tailscale/WireGuard 或带 HTTPS 的反向
代理，不要在共享网络上直接暴露明文 HTTP；登录链接要像密码一样保管（手机会一直保存 token，直到你退出登录或轮换 token）。

## 配置

所有配置都通过环境变量设置。`src/` 里只有 [`src/config.ts`](src/config.ts) 读取它们（quick-fork 插件单独运行时有自己的默认值）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HERDR_WEB_HOST` | `127.0.0.1` | 监听的网卡地址。设为 `0.0.0.0` 可以从其他机器访问。 |
| `HERDR_WEB_PORT` | `12500` | 监听端口，1 到 65535 之间的整数。 |
| `HERDR_WEB_TOKEN` | 自动生成 | 固定的访问 token：至少 16 个字符，只能包含字母、数字和 `-_.~`。不设置时一次性生成到 `<配置目录>/token`。设为 `off` 关闭鉴权，仅在回环地址上允许。 |
| `HERDR_WEB_CONFIG_DIR` | `$XDG_CONFIG_HOME/herdr-web`（`~/.config/herdr-web`） | token 和收件箱状态。 |
| `HERDR_WEB_HIDE_WORKSPACES` | 空 | 要隐藏的 herdr 工作区名称，逗号分隔，例如 `Board,Wake`。 |
| `HERDR_WEB_CLAUDE_DIRS` | 空 | 额外查找会话记录的 Claude 配置目录，用 `:` 分隔。 |
| `HERDR_BIN_PATH` | `herdr` | herdr 可执行文件。 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 的配置目录：会话记录、设置、命令和技能。 |
| `CLAUDE_CODE_EFFORT_LEVEL` | 不设置 | Claude Code 默认使用的推理强度，会话没设置时显示它。 |
| `CODEX_HOME` | `~/.codex` | Codex 的主目录：rollout、配置、prompts、技能和模型缓存。 |
| `XDG_RUNTIME_DIR` | 不设置 | 上传文件存到 `$XDG_RUNTIME_DIR/herdr-web/uploads`（`0700`）；没有它时存到 `$XDG_CACHE_HOME/herdr-web/uploads`（`~/.cache/herdr-web/uploads`）。单个上传上限 25 MB，超过一周的上传文件会在启动时删除，之后的上传也会顺带清理（最多每小时一次）。 |

## 作为服务运行

[`contrib/systemd/herdr-web.service`](contrib/systemd/herdr-web.service) 是一个 systemd 用户单元：

```sh
cp contrib/systemd/herdr-web.service ~/.config/systemd/user/
# 如果你的克隆目录或 bun 在别处，修改 WorkingDirectory 和 PATH
systemctl --user daemon-reload
systemctl --user enable --now herdr-web
loginctl enable-linger "$USER"   # 退出登录后继续运行
bun run url                      # 登录地址
```

`bun run url` 用当前 shell 的环境变量生成链接；如果你在单元文件里设置了 `HERDR_WEB_*` 变量，在 shell 里也要设置同样的值。它只读取 token：如果 herdr-web 还没生成 token，它会提示后退出。

## quick-fork 插件

分叉按钮用的是 [`plugin/quick-fork`](plugin/quick-fork)。它也可以单独作为 herdr 插件使用，为当前聚焦的窗格提供
“向右分屏 / 向下分屏 / 新标签页”分叉动作：

```sh
herdr plugin install FL-Penly/herdr-web/plugin/quick-fork
# 或者在本仓库的克隆里：
herdr plugin link "$PWD/plugin/quick-fork"
```

## 工作原理

一个 Bun 服务每秒轮询一次 `herdr api snapshot`，读取每个 agent 的屏幕和会话记录，判断谁需要你，再通过 WebSocket
推给浏览器。对话线程直接来自 Claude 的会话记录和 Codex 的 rollout。操作会变成 `herdr agent prompt` /
`pane send-keys` 调用，其中的按键序列都针对真实的 TUI 屏幕做过测试。终端视图走 `herdr terminal session` 的流。
浏览器端是原生 ES 模块，没有构建步骤。

详见 [docs/architecture.md](docs/architecture.md)。

## 开发

```sh
bun install
bun run dev      # 改动后自动重启
bun run check    # 类型检查、lint 和测试
```

[CONTRIBUTING.md](CONTRIBUTING.md) 介绍了目录结构、约定，以及 Claude Code 或 Codex 改了 TUI 时如何补测试。

## 许可证

[MIT](LICENSE)
