# ZcodeTokbar

**English** | [简体中文](README.zh.md)

[![Windows](https://img.shields.io/badge/Windows-10%2B-blue.svg)](https://www.microsoft.com/windows) [![Node 22+](https://img.shields.io/badge/Node-22%2B-green.svg)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Live token usage for ZCode, two flavours: a real-time bar under the input box (Windows, CDP injection) and a one-line statusline at the end of every reply (marketplace plugin).

![In-page bar](assets/bar-inpage.svg)

```
⟳ 2 turns 59 steps · 196 tok/s ⛁ 21.1M tok · Cache hit 49% ◉ 27%
```

![Reply statusline](assets/statusline-reply.png)

## Quick start

- **In-page bar (Windows):** run `scripts\deploy-local.cmd`, then launch ZCode from the Start Menu.
- **Statusline plugin:** add this repo as a marketplace, install `zcode-statusline`, and start a new session. `/status` prints it on demand.

Numbers come straight from ZCode's local logs/usage DB (read-only): turns/steps, tok/s, session tokens, cache-hit rate, context %.

---

## Buy Me a Coffee / Support

If ZcodeTokbar saved you from token anxiety, feel free to support the developer! ☕

<img src="assets/alipay.jpg" width="280" alt="Buy Me a Coffee" />
