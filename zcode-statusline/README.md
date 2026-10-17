# zcode-statusline

在 ZCode 里复刻参考图那种「状态栏」：**每条回复的末尾附一行真实用量**。

```
⟳ 1 turns 77 steps · 136 tok/s ｜ 3.3M tok · Cache hit 97%
```

左侧一组是本轮进度（轮数、步数、本轮即时输出速率），右侧一组是会话用量（token 总量、缓存命中率）。
所有数字都来自 ZCode 自己的 usage 数据库（`~/.zcode/cli/db/db.sqlite`，只读），没有任何估算或演示数据。

## 为什么是"回复末尾的一行"

ZCode 0.16.9 的界面**没有给插件留任何 UI 位置**：插件只能提供 skills / commands / hooks / MCP，桌面端没有 `contributes`、webview、扩展宿主这类扩展点，客户端包里也搜不到 `tok/s`、输入框下方状态栏之类的东西。

钩子的输出通道同样受限：schema 里虽然有 `systemMessage` 字段，但运行时代码只在 `decision:"block"` 分支消费它，**单独返回 `systemMessage` 等于空操作**（这正是很多同类插件"写了却不显示"的原因）。真正会进入会话的只有 `additionalContext`。

所以本插件采用客户端上**唯一可行**的路径：

```
UserPromptSubmit 钩子  →  注入「状态栏指令」(含脚本绝对路径 + 会话 ID)
        ↓
模型收尾时运行 scripts/statusline.mjs  →  读 usage 库算出一行
        ↓
该行作为回复的最后一行输出  →  在你眼前就是输入框正上方那条状态栏
```

> 说明：这不是客户端原生渲染的状态栏，位置在回复尾部而不是输入框正下方——在当前客户端版本下，后者对插件不可达。要真正的"贴输入框"只能等官方开放 UI 扩展点。

## 它显示什么

| 字段 | 含义 | 数据来源 |
| --- | --- | --- |
| `N turns` | 本会话已发生的用户轮数 | `model_usage.turn_id` 去重计数 |
| `M steps` | 本轮工具调用次数（含失败的调用） | `tool_usage`（每次调用一行，实时入库） |
| `X tok/s` | 本轮即时输出速率 = 本轮生成 token ÷ 本轮纯生成耗时（按段加权，排除首字等待与工具等待） | `model_usage.first_token_at/completed_at` |
| `T tok` | 会话累计 token（提示词 + 生成；提示词已含缓存读） | `model_usage.input_tokens/output_tokens` |
| `Cache hit P%` | 会话缓存命中率 = 缓存读 ÷ 提示词总量 | `model_usage.cache_read_input_tokens ÷ input_tokens` |

口径细节（已在本机库上核对）：

- `input_tokens` **已经包含** `cache_read_input_tokens`（原样对上 provider 的 `totalTokens = inputTokens + outputTokens`），所以命中率就是两者相除，不再做加法。
- `output_tokens` **已经包含** `reasoning_tokens`，因此速率分子不重复相加（有些实现把两者相加，会让速率虚高近一倍）。
- 只统计主对话（`query_source = 'main_turn'`）；子代理、后台请求不混入。

## 安装

1. 打开 **插件市场 → 添加 → 添加插件市场**，粘贴这个仓库的本地路径或 Git 地址（marketplace 根目录，即本仓库根目录）：

   ```
   <your-checkout-path>/ZcodeTokbar
   ```

2. 在 **个人 → zcode-tokbar → zcode-statusline → 安装**。
3. **重开会话**，让 `UserPromptSubmit` 钩子重新注册；此后每条回复末尾应出现状态栏行。

安装后可在 **设置 → 插件管理** 里查看/停用；`/status` 命令可随时手动打印一次状态栏（用于验证是否安装成功）。

## 配置

`~/.zcode/statusline.config.json`：

```json
{ "statusline": false }
```

写入后不再注入状态栏指令（整个插件的显示行为关闭）。

环境变量：

- `ZCODE_USAGE_DB`：覆盖数据库路径（默认 `~/.zcode/cli/db/db.sqlite`）。
- `STATUSLINE_MIN_MS`：速率样本的最小生成耗时，默认 `200` 毫秒，低于该值的段不参与速率计算。

## 手动验证

```bash
node scripts/statusline.mjs --session sess_xxxxxxxx   # 指定会话
node scripts/statusline.mjs --json                    # 机器可读
node scripts/statusline.mjs --debug                   # 无输出时说明原因
node --test test/statusline.test.mjs                  # 6 项口径测试(临时库夹具)
```

## 与 zcode-tps-monitor 的关系

两者都读同一个 usage 库，但输出不同：tps-monitor 的行以速率为主（`⚡ … tok/s(本轮) · 首字 …`），本插件的行是参考图那种「进度 + 会话用量」两组的紧凑状态栏。**同时启用会出现两行**；只想留一行时，把 tps-monitor 的行关掉：

```bash
# ~/.zcode/tps-monitor.config.json
{ "tokenRateLine": false }
```

## 已知限制

- 数值是「运行那一刻」的实时快照：生成该行之后的收尾文字不计入本轮 token 与速率（状态栏本来就是实时的）。
- 该行由模型按指令输出。模型若被要求"不要附加任何内容"，则不会出现（这是有意保留的逃生门）。
- 纯问答轮（无工具调用）同样会显示，步数为 `0`。
- 若某轮脚本没有输出（例如会话尚无已完成请求），则不会添加任何行。

## 文件结构

```
zcode-statusline/
├── .zcode-plugin/plugin.json     # 插件清单(名称/版本/钩子/命令)
├── hooks/hooks.json              # UserPromptSubmit → prompt-submit.mjs
├── hooks/prompt-submit.mjs       # 注入「状态栏指令」(固化脚本路径 + 会话 ID)
├── scripts/statusline.mjs        # 核心:读 usage 库算出一行(含 --json/--debug)
├── commands/status.md            # /status 命令:手动打印一次
└── test/statusline.test.mjs      # 口径测试(node --test)
```
