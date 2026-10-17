// 状态栏计算口径测试(临时库夹具,不触碰真实数据)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collect, fmtCompact, turnRate, buildStatus } from "../scripts/statusline.mjs";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-test-"));
  const file = path.join(dir, "db.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE model_usage (
      id TEXT, session_id TEXT, turn_id TEXT, query_source TEXT, status TEXT,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_read_input_tokens INTEGER, computed_total_tokens INTEGER,
      tool_call_count INTEGER, first_token_at INTEGER, completed_at INTEGER
    );
    CREATE TABLE tool_usage (
      id TEXT, session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER
    );
  `);
  return { db, file, dir };
}

function addModel(db, { id, session, turn, source = "main_turn", status = "completed", in: inp = 0, out = 0, cache = 0, total = null, tools = 0, first = 1000, done = 2000 }) {
  db.prepare(
    "INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(id, session, turn, source, status, inp, out, 0, cache, total ?? inp + out, tools, first, done);
}

function addTool(db, { id, session, turn, name = "Bash", status = "completed" }) {
  db.prepare("INSERT INTO tool_usage VALUES (?,?,?,?,?,?,?)").run(id, session, turn, name, status, 1000, 2000);
}

test("fmtCompact 分级单位", () => {
  assert.equal(fmtCompact(999), "999");
  assert.equal(fmtCompact(1000), "1.0k");
  assert.equal(fmtCompact(9999), "10.0k");
  assert.equal(fmtCompact(10_500), "11k");
  assert.equal(fmtCompact(576_900), "577k");
  assert.equal(fmtCompact(1_350_000), "1.4M");
});

test("turnRate:按段加权,排除首字等待与工具等待,剔除过短样本", () => {
  const rate = turnRate([
    { output_tokens: 1000, first_token_at: 0, completed_at: 1000 }, // 1.0s → 1000 tok/s
    { output_tokens: 500, first_token_at: 0, completed_at: 1000 }, // 1.0s → 500 tok/s
    { output_tokens: 9999, first_token_at: 0, completed_at: 50 }, // 50ms < 200ms 下限,剔除
    { output_tokens: 0, first_token_at: 0, completed_at: 5000 }, // 无产出,不计入时长
  ]);
  assert.equal(rate, Math.round((1500 / 2000) * 1000)); // 750
});

test("collect:轮数/步数/速率/总量/缓存命中", () => {
  const { db, file } = makeDb();
  const S = "sess_test";
  // 第 1 轮:两段,无工具
  addModel(db, { id: "1", session: S, turn: "t1", in: 1000, out: 100, cache: 800, first: 1000, done: 2000 });
  addModel(db, { id: "2", session: S, turn: "t1", in: 1100, out: 100, cache: 900, first: 2100, done: 3100 });
  // 第 2 轮(最新):两段 + 3 次工具调用
  addModel(db, { id: "3", session: S, turn: "t2", in: 2000, out: 600, cache: 1800, tools: 2, first: 4000, done: 5000 });
  addModel(db, { id: "4", session: S, turn: "t2", in: 2600, out: 400, cache: 2400, tools: 1, first: 5100, done: 6100 });
  addTool(db, { id: "a", session: S, turn: "t2" });
  addTool(db, { id: "b", session: S, turn: "t2", name: "Read" });
  addTool(db, { id: "c", session: S, turn: "t2", name: "Read", status: "failed" });
  db.close();

  const r = collect({ dbPath: file, sessionId: S });
  assert.equal(r.turns, 2);
  assert.equal(r.steps, 3); // 含失败调用
  assert.equal(r.tokPerSec, 500); // (600+400)/2000ms
  assert.equal(r.totalTokens, 1000 + 100 + 1100 + 100 + 2000 + 600 + 2600 + 400);
  assert.equal(r.cacheHitPercent, Math.round(((800 + 900 + 1800 + 2400) / (1000 + 1100 + 2000 + 2600)) * 100));
  assert.match(r.line, /^⟳ 2 turns 3 steps · 500 tok\/s ｜ 7\.9k tok · Cache hit 88%$/);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("collect:优先 main_turn,子代理请求不混入", () => {
  const { db, file } = makeDb();
  const S = "sess_mixed";
  addModel(db, { id: "1", session: S, turn: "t1", in: 1000, out: 100, cache: 900 });
  addModel(db, { id: "2", session: S, turn: "t1", source: "subagent", in: 99999, out: 9999, cache: 0 });
  addModel(db, { id: "3", session: S, turn: "t1", source: "subagent", in: 1, out: 1, cache: 0 });
  db.close();
  const r = collect({ dbPath: file, sessionId: S });
  assert.equal(r.turns, 1);
  assert.equal(r.totalTokens, 1100);
  assert.equal(r.cacheHitPercent, 90);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("collect:未完成行不计入,库为空时返回 null", () => {
  const { db, file } = makeDb();
  assert.equal(collect({ dbPath: file, sessionId: "none" }), null);
  addModel(db, { id: "1", session: "s", turn: "t1", in: 10, out: 5, status: "failed" });
  db.close();
  assert.equal(collect({ dbPath: file, sessionId: "s" }), null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("buildStatus:无速率样本时省略 tok/s,无输入时省略命中率", () => {
  const r = buildStatus({
    turns: 1,
    steps: 0,
    tokPerSec: null,
    totalTokens: 512,
    cacheRead: 0,
    inputTokens: 0,
    sessionId: "s",
    turnId: "t",
    requests: 1,
  });
  assert.equal(r.line, "⟳ 1 turns 0 steps ｜ 512 tok");
});
