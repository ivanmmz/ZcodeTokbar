#!/usr/bin/env node
// zcode-statusline 核心:从 ZCode 自身 usage 库算出一行状态栏。
//
// 用法:
//   node statusline.mjs                     当前会话(按 ZCODE_SESSION_ID / 库中最近会话解析)
//   node statusline.mjs --session sess_xxx  指定会话
//   node statusline.mjs --json              输出 JSON(供程序/测试消费)
//   ZCODE_USAGE_DB=/path/db.sqlite          覆盖数据库路径
//
// 数据口径(均已在本机库上核对):
//   model_usage.input_tokens              提示词总量,*已包含*缓存读(cache_read_input_tokens)
//   model_usage.output_tokens             生成总量,*已包含* reasoning_tokens(不再重复相加)
//   model_usage.first_token_at/completed_at  纯生成耗时 = completed_at - first_token_at(不含首字等待与工具等待)
//   tool_usage                            每次工具调用一行,按 turn_id 实时入库 → 步数
// 输出格式(与参考图一致的两组):
//   ⟳ 1 turns 16 steps · 157 tok/s ｜ 577K tok · Cache hit 92%
//
// 只读打开 WAL 数据库,不影响运行中的客户端;任何异常都静默退出(退出码 0),
// 调用方据此不显示任何行。

// 抑制 node:sqlite 的 ExperimentalWarning(须在动态 import 之前接管 warning 通道)
process.removeAllListeners("warning");
process.on("warning", () => {});

const { DatabaseSync } = await import("node:sqlite");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DB = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const GEN_MS_MIN = Number(process.env.STATUSLINE_MIN_MS) || 200; // 有效速率样本:最短生成耗时

// ---------- 数字格式 ----------

// 紧凑单位:千以下原始、千~万一位小数 k、万~百万取整 k、百万以上一位小数 M
export function fmtCompact(n) {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

// ---------- 计算 ----------

// rows: 某个 turn 的全部已完成请求段
export function turnRate(rows) {
  let out = 0;
  let genMs = 0;
  for (const r of rows) {
    const o = r.output_tokens ?? 0;
    const first = r.first_token_at;
    const done = r.completed_at;
    if (o <= 0) continue; // 零产出段不计入分子,也不让它拉长分母
    if (!Number.isFinite(first) || !Number.isFinite(done) || done <= first) continue;
    const ms = done - first;
    if (ms < GEN_MS_MIN) continue;
    out += o;
    genMs += ms;
  }
  if (genMs <= 0 || out <= 0) return null;
  return Math.round((out / genMs) * 1000);
}

export function buildStatus(input) {
  const { turns, steps, tokPerSec, totalTokens, cacheRead, inputTokens, sessionId, turnId, requests } = input;
  // 左组与参考图一致:「N turns M steps」相邻空格分隔,速率另起一段
  const left = [`${turns} turns ${steps} steps`];
  if (tokPerSec != null) left.push(`${tokPerSec} tok/s`);
  const right = [`${fmtCompact(totalTokens)} tok`];
  const hit = inputTokens > 0 ? Math.round((cacheRead / inputTokens) * 100) : null;
  if (hit != null) right.push(`Cache hit ${hit}%`);
  return {
    line: `⟳ ${left.join(" · ")} ｜ ${right.join(" · ")}`,
    turns,
    steps,
    tokPerSec,
    totalTokens,
    cacheHitPercent: hit,
    sessionId,
    turnId,
    requests,
  };
}

// ---------- 数据库 ----------

export function collect({ dbPath = process.env.ZCODE_USAGE_DB || DEFAULT_DB, sessionId = null } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sid = sessionId || latestSessionId(db);
    if (!sid) return null;

    // 主对话优先:有 main_turn 数据时只统计 main_turn(子代理/后台请求不混入)
    const hasMain = db
      .prepare("SELECT 1 FROM model_usage WHERE session_id = ? AND status = 'completed' AND query_source = 'main_turn' LIMIT 1")
      .get(sid);
    const scope = hasMain
      ? "status = 'completed' AND query_source = 'main_turn'"
      : "status = 'completed'";
    const where = `session_id = ? AND ${scope}`;

    const turns = db
      .prepare(`SELECT COUNT(DISTINCT turn_id) n FROM model_usage WHERE ${where} AND turn_id IS NOT NULL`)
      .get(sid).n ?? 0;
    const totals = db
      .prepare(
        `SELECT COUNT(*) requests, SUM(input_tokens) inp, SUM(output_tokens) out,` +
          ` SUM(cache_read_input_tokens) cache, SUM(computed_total_tokens) total FROM model_usage WHERE ${where}`
      )
      .get(sid);
    if (!totals || !totals.requests) return null; // 会话尚无已完成请求 → 不输出任何行

    const turnId = latestTurnId(db, sid);
    let steps = 0;
    let tokPerSec = null;
    let requests = 0;
    if (turnId) {
      const rows = db
        .prepare(
          `SELECT output_tokens, input_tokens, tool_call_count, first_token_at, completed_at` +
            ` FROM model_usage WHERE ${where} AND turn_id = ?`
        )
        .all(sid, turnId);
      requests = rows.length;
      tokPerSec = turnRate(rows);
      steps = countSteps(db, sid, turnId, rows);
    }

    const inputTokens = totals.inp ?? 0;
    const totalTokens =
      totals.total != null ? totals.total : (totals.inp ?? 0) + (totals.out ?? 0);
    return buildStatus({
      turns,
      steps,
      tokPerSec,
      totalTokens,
      cacheRead: totals.cache ?? 0,
      inputTokens,
      sessionId: sid,
      turnId,
      requests,
    });
  } finally {
    db.close();
  }
}

// 本轮步数:tool_usage 每次调用一行(含失败),优先用它;老库无该表时退回段内 tool_call_count 之和
function countSteps(db, sid, turnId, turnRows) {
  try {
    const n = db
      .prepare("SELECT COUNT(*) n FROM tool_usage WHERE session_id = ? AND turn_id = ?")
      .get(sid, turnId).n;
    if (Number.isFinite(n)) return n;
  } catch {}
  return turnRows.reduce((s, r) => s + (r.tool_call_count ?? 0), 0);
}

function latestTurnId(db, sid) {
  try {
    const row = db
      .prepare(
        "SELECT turn_id FROM model_usage WHERE session_id = ? AND turn_id IS NOT NULL ORDER BY completed_at DESC LIMIT 1"
      )
      .get(sid);
    return row ? row.turn_id : null;
  } catch {
    return null;
  }
}

function latestSessionId(db) {
  const row = db
    .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
    .get();
  return row ? row.session_id : null;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { json: false, session: null, debug: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--debug") out.debug = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--session") out.session = argv[++i] ?? null;
    else if (a.startsWith("--session=")) out.session = a.slice(10);
    else if (a.startsWith("sess_")) out.session = a;
  }
  return out;
}

function isMain() {
  try {
    return import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "zcode-statusline — 从 ZCode usage 库生成一行用量状态栏",
        "",
        "  node statusline.mjs [--session sess_xxx] [--json] [--debug]",
        "",
        "  --session  指定会话(默认 ZCODE_SESSION_ID,再退回库中最近会话)",
        "  --json     输出 JSON",
        "  --debug    出错时把原因打印到 stderr",
        "  ZCODE_USAGE_DB  覆盖数据库路径(默认 ~/.zcode/cli/db/db.sqlite)",
      ].join("\n")
    );
    process.exit(0);
  }
  try {
    const sessionId = args.session || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
    const r = collect({ sessionId });
    if (r) {
      if (args.json) console.log(JSON.stringify(r, null, 2));
      else console.log(r.line);
    } else if (args.debug) {
      console.error("statusline: 库中没有任何已完成的请求记录");
    }
  } catch (err) {
    if (args.debug) console.error("statusline:", err?.message ?? err);
  }
  process.exit(0);
}
