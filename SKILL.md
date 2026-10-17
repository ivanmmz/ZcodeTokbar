---
name: zcode-token-bar
description: >
  在 ZCode 输入框正下方显示实时 token 用量条（页内注入，非独立窗口），并负责安装、修复、卸载。
  显示内容：⟳ 轮次/步数 · tok/s　⛁ 累计 token · 缓存命中率　◉ 上下文占用百分比。
  使用场景：用户说「安装/重装 token 计数器」「token 条不显示了」「修复 token bar」
  「卸载 token 计数器」「ZCode 底部用量条」，或需要重新部署到新机器 / 从存档恢复时。
  Use when the user asks to install, repair, or remove the ZCode token counter / token bar /
  usage bar under the input box. Triggers: token 计数器, token bar, 用量条, token 显示, 缓存命中,
  zcode-token-bar, 修复计数器, 卸载计数器.
---

# zcode-token-bar —— ZCode 输入框下方的实时 token 用量条

## 这套东西是什么

一个常驻控制器（Node，无依赖）通过 Chromium 远程调试端口（CDP）把一条统计条
**注入 ZCode 自己的页面**（`[data-testid="v4-composer"]` 容器末尾，即输入框正下方），
因此外观与内置组件一致（用 ZCode 的主题变量着色），不是独立悬浮窗。

数据来自 ZCode 会话日志 `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl`。

显示口径：
- `N turns N steps` —— 不同 `turnId` 数（用户发了几轮）/ 模型请求数（含工具循环每一步）
- `tok/s` —— 最近 5 次请求的输出速度
- `N tok` —— 本会话累计（未缓存输入 + 缓存写入 + 缓存读取 + 输出）
- `Cache hit N%` —— cacheRead ÷ (cacheRead + input + cacheWrite)
- `N%` —— 最后一次请求（输入侧 + 输出）÷ 模型上下文窗口

## 目录结构

```
Zcode/
  README.md             完整文档（原理、排查、环境变量、还原）
  SKILL.md              本文件
  scripts/
    token_bar_cdp.js    控制器：连接调试端口、注入页内条、管理回退（Node，无第三方依赖）
    token_bar.py        悬浮小窗（回退模式；仅用标准库）
    launch_zcode.vbs    启动器：先起控制器，再带调试端口启动 ZCode
    install.cmd         一键安装（探测路径 → paths.ini → hook → 快捷方式）
    deploy-local.cmd    推荐入口：先复制到 %USERPROFILE%\.zcode\tools\token-bar 再安装
    uninstall.cmd       还原（恢复快捷方式、移除 hook、停进程）
    start.cmd/stop.cmd  手动启停
    setup.js            读写 ~/.zcode/cli/config.json 的 SessionStart hook（幂等）
    shortcuts.ps1       创建/还原快捷方式
```

## 安装 / 修复

**推荐**：在 `scripts` 目录运行 `deploy-local.cmd`
（复制到本地 `%USERPROFILE%\.zcode\tools\token-bar` 并安装，避免网盘同步影响运行）。

直接就地安装也可以：运行 `scripts\install.cmd`（装在哪就以哪为运行位置）。

安装器会做四件事：
1. 探测 `node` / `ZCode.exe` / `pythonw`，写入 `paths.ini`；
2. 调 `setup.js add` 在 `~/.zcode/cli/config.json` 写入 `SessionStart` hook
   （同时设 `hooks.enabled: true`；已存在指向本工具的条目会先替换，其余 hook 不动）；
3. 把开始菜单 `ZCode.lnk` 指向 `launch_zcode.vbs`（原快捷键备份为 `ZCode.lnk.backup`）；
4. 建桌面 `Token Counter` 快捷方式。

安装是幂等的，重复运行安全。

## 验证安装是否生效

1. 从开始菜单启动 ZCode（走 `launch_zcode.vbs`）。
2. 约 2 秒后输入框下方出现统计条；或查看 `scripts/controller.log`，
   应包含 `connected to ZCode UI on port 9333 - in-page bar active`。
3. 只有悬浮窗（而非页内条）时，说明 ZCode 没带调试端口启动 —— 检查开始菜单快捷方式
   是否指向 `launch_zcode.vbs`。
4. `node token_bar_cdp.js --dump` 可在不开界面的情况下打印当前统计，便于确认数据源可用。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 完全没有条 | 控制器没运行：跑 `start.cmd`；确认 `controller.log`；确认 ZCode 从开始菜单启动 |
| 只有悬浮小窗 | ZCode 未带 `--remote-debugging-port=9333`（快捷方式被还原/换了启动方式）；hook 兜底仍在工作 |
| 条在但数字不动 | 会话日志没更新（未发起对话），或读取的不是当前会话；会话切换会自动跟随最新日志 |
| 端口被占用 | 设 `ZCTB_CDP_PORT` 环境变量（`launch_zcode.vbs` 与控制器都会跟随它） |
| 装了别的 ZCode 版本 | 重跑 `install.cmd`，它会重新探测 `ZCode.exe` 并重写 `paths.ini` |

## 卸载

`scripts\uninstall.cmd`：停进程 → 恢复开始菜单快捷方式 → 移除 hook → 删桌面快捷方式。
备份保留 `ZCode.lnk.backup` 与 `config.json.token-bar.bak`。

## 关键实现细节（修改代码前必读）

- **注入点**：`[data-testid="v4-composer"]` 的最后一个子元素（`id="zctb-host"`）。
  ZCode 更新后若该 testid 变化，需同步修改 `token_bar_cdp.js` 中的 `SNIPPET`。
- **调试端口**：打包版默认**不开** 9229（仅 `!isPackaged` dev 模式开），必须用
  `--remote-debugging-port=9333` 启动；CDP 客户端连接不需要 `--remote-allow-origins`。
- **单实例**：控制器监听 `127.0.0.1:9334`；悬浮窗用命名互斥体 `Local\ZCodeTokenBar`。
- **hook 触发时机**：`SessionStart` 只在**发送第一条消息**时执行（`runSessionStartHooks`
  在 executeTurn 内），不在 App 启动瞬间 —— 所以它只是兜底，主入口必须是 VBS 启动器。
- **回退逻辑**：控制器等待端口 20 秒（`ZCTB_PORT_WAIT_MS`）后拉起悬浮窗；端口出现即切回页内并关闭悬浮窗；ZCode 退出后控制器常驻等待下次启动。
- **沙箱测试**（不影响正在使用的实例）：用环境变量
  `ZCODE_DESKTOP_USER_DATA_DIR` / `ZCODE_DESKTOP_SESSION_DATA_DIR` 指定独立数据目录，
  再配合 `--remote-debugging-port=<其它端口>` 启动第二个 ZCode。
