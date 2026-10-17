#!/usr/bin/env node
// UserPromptSubmit 钩子:每轮注入「状态栏指令」。
//
// ZCode 0.16.9 客户端没有任何"插件可写的界面扩展点":钩子输出里只有 additionalContext
// 会进入会话(裸 systemMessage 是 schema 里存在但运行时不消费的空操作),所以让这一行
// 出现在界面里的唯一通道,就是让模型在收尾时把脚本输出原样写成回复的最后一行。
//
// 该钩子把当前会话 ID 与脚本绝对路径固化进指令,模型收尾时无需自行解析路径/会话。
// 输出必须是严格 JSON。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "statusline.mjs");
const CONFIG = path.join(os.homedir(), ".zcode", "statusline.config.json");

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(raw);
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", finish);
    setTimeout(finish, 1500); // 客户端不给 stdin 时不挂起
  });
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })
  );
}

try {
  const cfg = readConfig();
  if (cfg.statusline === false) {
    emit("");
    process.exit(0);
  }

  let sid = "";
  try {
    const payload = JSON.parse((await readStdin()) || "{}");
    sid = payload.session_id || "";
  } catch {}
  sid = sid || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";

  const cmd = `node "${SCRIPT}"${sid ? ` --session ${sid}` : ""}`;
  emit(
    [
      "【状态栏指令】本次回复的最后一行,必须原样输出下面这条命令打印的那一行(纯文本一行,不加引号、不加代码块、其后不再有任何内容;命令没有输出就不加):",
      cmd,
      "它读取 ZCode usage 数据库,给出本轮真实用量:轮数、步数、tok/s、会话 token 总量与缓存命中率。若用户明确要求不要附加任何内容,则不执行。",
    ].join("\n")
  );
} catch {
  emit("");
}
process.exit(0);
