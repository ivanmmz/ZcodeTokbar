---
description: 显示 ZCode 用量状态栏(轮数 / 步数 / tok/s / 会话 token 总量 / 缓存命中率)
---

请运行下面这条命令,并把它的输出**原样**作为本次回复的最后一行展示(纯文本一行,不要改写任何数字,不要另加解释):

```
node "${ZCODE_PLUGIN_ROOT}/scripts/statusline.mjs"
```

`${ZCODE_PLUGIN_ROOT}` 由 ZCode 在运行插件命令时自动解析到本插件的安装目录,无需手动替换。
如果你的客户端版本不支持该变量,改用已安装的缓存副本二选一:

- PowerShell 找最新版后运行:
  `$d = Get-ChildItem "$env:USERPROFILE\.zcode\cli\plugins\cache" -Recurse -Directory -Filter "zcode-statusline" | Sort-Object FullName -Descending | Select-Object -First 1; node "$($d.FullName)\scripts\statusline.mjs"`
- 或 CMD 手工 `dir` 找到版本号最大的那个目录后运行同名脚本。

命令只读取 `~/.zcode/cli/db/db.sqlite`(只读),不会修改任何数据;若它没有任何输出,就说明当前会话还没有已完成的模型请求。
