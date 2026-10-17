# ZcodeTokbar

[English](README.md) | **简体中文**

[![Windows](https://img.shields.io/badge/Windows-10%2B-blue.svg)](https://www.microsoft.com/windows) [![Node 22+](https://img.shields.io/badge/Node-22%2B-green.svg)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

让 ZCode 的 token 开销看得见：输入框下方的实时用量条（Windows，CDP 注入）+ 每条回复末尾的一行状态栏（插件市场插件）。

![输入框用量条](assets/bar-inpage.svg)

```
⟳ 2 turns 59 steps · 196 tok/s ⛁ 21.1M tok · Cache hit 49% ◉ 27%
```

![回复末尾状态栏](assets/statusline-reply.svg)

## 快速开始

- **页内用量条（Windows）：** 运行 `scripts\deploy-local.cmd`，然后从开始菜单启动 ZCode。
- **状态栏插件：** 把本仓库加为插件市场，安装 `zcode-statusline`，重开一个会话。`/status` 可随时手动打印。

所有数字只读 ZCode 本地日志/usage 库：轮数/步数、tok/s、会话 token、缓存命中率、上下文占用。

---

## 支持与赞助 (Buy Me a Coffee)

如果 ZcodeTokbar 帮你省下了 token 焦虑，欢迎请开发者喝杯咖啡！☕

<img src="assets/alipay.jpg" width="280" alt="请喝咖啡" />
