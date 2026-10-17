#!/usr/bin/env node
"use strict";
/**
 * ZCode 用量计数器（页内版）。
 *
 * 把统计条注入 ZCode 自己的界面（输入框正下方），样式跟随 ZCode 主题，
 * 就像内置组件一样。数据来自会话日志 ~/.zcode/cli/rollout/model-io-*.jsonl。
 *
 * 运行方式：
 *   node token_bar_cdp.js            前台运行（Ctrl+C 退出）
 *   node token_bar_cdp.js --spawn    脱离终端后台运行后立即返回（hook 入口）
 *   node token_bar_cdp.js --dump     只打印当前统计，不连接界面
 *
 * 工作逻辑：
 *   1. 连接 ZCode 的远程调试端口（默认 9333，可用 ZCTB_CDP_PORT 覆盖）。
 *   2. 端口可用时向页面注入统计条（单例：内嵌控制器端口 9334 防止重复）。
 *   3. 启动后 ZCTB_PORT_WAIT_MS（默认 20s）内连不上端口，则回退为悬浮小窗
 *      （pythonw token_bar.py）；之后端口出现会自动切换回页内并关掉悬浮窗。
 *
 * 数据口径与 ZCode「Context windows」弹窗一致（2026-10-03 对齐；2026-10-07 修订范围与 tok/s）：
 *   统计范围 = 界面**当前显示的会话**：注入时从页面读 `data-session-id`（只认 sess_<uuid> 形式；
 *     新任务首页那个面板的值是字面量 "draft"；同时挂着多个面板时优先「包含输入框」的那个），
 *     钉住对应的 model-io-sess_<id>.jsonl。**认不出会话就显示 waiting，不退回「最近写入的文件」**
 *     —— 那个启发式在多个会话同时跑时会互相串数据（2026-10-07 的教训）。
 *   轮次 = 不同 turnId 数；步数 = 模型请求数；
 *   tok/s = 当前会话**最后一轮**的平均输出速度（按 turnId 分组，Σ输出 / Σ时长），
 *     不再是跨轮次的「最近 5 次」；
 *   累计 tok = Σ(输入 + 输出)，输入已含缓存命中部分（inputTokens ≥ cacheReadTokens，
 *   代理侧统一语义），不重复计 cacheRead；
 *   缓存命中 = ΣcacheRead / Σinput（即 ZCode 的 Average cache hit rate）；
 *   百分比 = 最后一次请求的 inputTokens / 模型上下文窗口。
 *   第三段展示为环形占用圈（SVG 圆弧，弧长按占用比例，满圈=100%，超窗也只画满圈）
 *   + 百分比文字，与模型选择器旁的圈同式；口径不变，只换展示层。
 */
const http = require("http");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const HOME = os.homedir();
const ROLLOUT_DIR = path.join(HOME, ".zcode", "cli", "rollout");
const TOOL_DIR = __dirname;
const CDP_PORT = Number(process.env.ZCTB_CDP_PORT || 9333);
const SINGLETON_PORT = Number(process.env.ZCTB_SINGLETON_PORT || 9334);
const PORT_WAIT_MS = Number(process.env.ZCTB_PORT_WAIT_MS || 20000);
const POLL_MS = Number(process.env.ZCTB_POLL_MS || 800);
const FLOAT_FALLBACK = process.env.ZCTB_FLOAT !== "0";
const ALIVE_CHECK_EVERY = 10; // 每 ~8 秒检查一次 ZCode 是否还在运行
const HEAL_MS = 5 * 60 * 1000; // 端口连不上时，多久重试一次「修快捷方式」
const LOG_FILE = path.join(TOOL_DIR, "controller.log");
const LOG_MAX_BYTES = 512 * 1024;

function logLine(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    }
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ---------------------------------------------------------------- 数据层

function newestSessionFile() {
  let best = null;
  let bestM = 0;
  try {
    for (const name of fs.readdirSync(ROLLOUT_DIR)) {
      if (!name.startsWith("model-io-") || !name.endsWith(".jsonl")) continue;
      const p = path.join(ROLLOUT_DIR, name);
      const m = fs.statSync(p).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = p;
      }
    }
  } catch {}
  return best;
}

// 页面里的会话 id（sess_<uuid> 或裸 uuid）→ 对应的 model-io 文件路径。
// 文件可能尚不存在（会话还没发过请求）：照样返回路径，poll() 打不开就先显示 waiting。
function sessionFile(sid) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(sid || ""));
  if (!m) return null;
  return path.join(ROLLOUT_DIR, `model-io-sess_${m[1]}.jsonl`);
}

function loadContextLimits() {
  const limits = new Map();
  const files = [
    path.join(HOME, ".zcode", "v2", "provider_config.json"),
    path.join(HOME, ".zcode", "v2", "config.json"),
  ];
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    const rules = d?.config?.modelConfigRules?.providerModelRules || [];
    for (const r of rules) {
      const cw = r?.config?.properties?.contextWindow;
      if (cw && r.modelId && !limits.has(r.modelId)) limits.set(r.modelId, Number(cw));
    }
    for (const prov of Object.values(d?.provider || {})) {
      for (const [mid, m] of Object.entries(prov?.models || {})) {
        const cw = m?.limit?.context;
        if (cw) {
          if (!limits.has(mid)) limits.set(mid, Number(cw));
          const short = mid.split("/").pop();
          if (!limits.has(short)) limits.set(short, Number(cw));
        }
      }
    }
  }
  return limits;
}

class Tracker {
  constructor(fileOverride) {
    this.limits = loadContextLimits();
    this.override = fileOverride ? path.resolve(fileOverride) : null;
    this.pinnedFile = null; // 控制器按「界面当前会话」钉住的文件；null = 用最新写入的
    this.reset(null);
  }

  reset(file) {
    if (this.fd) {
      try {
        fs.closeSync(this.fd);
      } catch {}
    }
    this.file = file;
    this.fd = null;
    this.buf = "";
    this.offset = 0;
    if (file) {
      try {
        this.fd = fs.openSync(file, "r");
      } catch {}
    }
    this.reqs = 0;
    this.turns = new Set();
    this.inp = 0;
    this.cr = 0;
    this.cw = 0;
    this.out = 0;
    this.turnSpeeds = [];
    this.curTurn = null;
    this.last = null;
  }
  poll() {
    // 只看两个来源：面板钉住的会话文件（可能还没生成）、或 --dump 指定的文件。
    // 故意**不**退回「最近写入的文件」：多会话同时跑时会串数据，
    // 认不出当前会话时宁可显示 waiting。
    const target = this.override || this.pinnedFile;
    if (target !== this.file) this.reset(target);
    if (!this.fd && this.file) {
      // 文件可能刚刚才出现（会话的第一次请求），每次轮询都补一次打开
      try {
        this.fd = fs.openSync(this.file, "r");
      } catch {}
    }
    if (!this.fd) return;
    let chunk;
    try {
      const size = fs.fstatSync(this.fd).size;
      if (size < this.offset) {
        // 日志被截断（ZCode 重开了会话日志）：从头重算，避免旧偏移量把统计卡死
        this.reset(this.file);
        return;
      }
      if (size === this.offset) return;
      chunk = Buffer.alloc(size - this.offset);
      fs.readSync(this.fd, chunk, 0, chunk.length, this.offset);
      this.offset = size;
    } catch {
      return;
    }
    this.buf += chunk.toString("utf8");
    const lines = this.buf.split("\n");
    this.buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      this.consume(obj);
    }
  }

  consume(obj) {
    const u = obj?.response?.usage || {};
    const inp = Number(u.inputTokens || 0);
    const out = Number(u.outputTokens || 0);
    const cr = Number(u.cacheReadTokens || 0);
    const cw = Number(u.cacheWriteTokens || 0);
    const dur = Number(obj.durationMs || 0);
    this.reqs += 1;
    this.inp += inp;
    this.out += out;
    this.cr += cr;
    this.cw += cw;
    if (typeof obj.turnId === "string" && obj.turnId) this.turns.add(obj.turnId);
    // tok/s 只统计当前这一轮（turnId 变了就重新开组），轮内的所有请求合在一起求平均
    if (typeof obj.turnId === "string" && obj.turnId && obj.turnId !== this.curTurn) {
      this.curTurn = obj.turnId;
      this.turnSpeeds = [];
    }
    if (dur > 0 && out > 0) this.turnSpeeds.push([out, dur]);
    // 偶发的空请求（usage 全 0，例如上游报错重试）会把「上下文占用」带成 0，
    // 只让真正带输入的请求更新「最后一次请求」，其余字段照常累计
    if (inp > 0) {
      this.last = {
        inp,
        out,
        cr,
        cw,
        prompt: inp + cr + cw,
        model: obj?.model?.modelId || null,
        session: obj?.request?.headers?.["x-session-id"] || null,
        completed: obj?.completedAt || null,
      };
    }
  }

  metrics() {
    const m = { reqs: this.reqs, turns: this.reqs ? this.turns.size : null };
    // 口径对齐 ZCode「Context windows」弹窗：
    // - inputTokens 已包含缓存命中部分（deepseek/GLM 代理均如此），累计只加一次
    // - 命中率 = ΣcacheRead / Σinput（即 ZCode 的 Average cache hit rate）
    // - 上下文占用 = 最后一次请求的 inputTokens / 上下文窗口
    m.total = this.inp + this.out;
    m.hit = this.inp ? (this.cr / this.inp) * 100 : null;
    if (this.turnSpeeds.length) {
      const o = this.turnSpeeds.reduce((a, s) => a + s[0], 0);
      const d = this.turnSpeeds.reduce((a, s) => a + s[1], 0);
      m.tps = d ? o / (d / 1000) : null;
    } else m.tps = null;
    m.in = this.inp;
    m.cached = this.cr;
    m.out = this.out;
    if (this.last) {
      const used = this.last.inp;
      const model = this.last.model || "";
      const size =
        this.limits.get(model) ||
        this.limits.get(model.split("/").pop()) ||
        (model.startsWith("deepseek") ? 1000000 : null);
      m.ctxUsed = used;
      m.ctxSize = size;
      m.ctxPct = size ? Math.min(999, (used / size) * 100) : null;
      m.model = model || null;
      m.session = this.last.session;
      m.ts = this.last.completed;
    }
    m.file = this.file;
    return m;
  }
}

function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e5) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  if (n >= 1e4) return Math.round(n / 1000) + "K";
  if (n >= 1e3) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function fmtTps(v) {
  if (!v) return "--";
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

const ICON1 = "\u27f3"; // ⟳ 轮次/速度
const ICON2 = "\u26c1"; // ⛁ 累计 token/缓存
// 第三段不再用字符图标：注入端画 SVG 环形占用圈（见 SNIPPET）

function buildState(m) {
  if (!m.reqs) return { a: `${ICON1}  waiting for a session…`, b: "", ring: null, title: "" };
  const turns = m.turns ?? 0;
  const a = `${ICON1}  ${turns} turn${turns === 1 ? "" : "s"} ${m.reqs} steps · ${fmtTps(m.tps)} tok/s`;
  const hit = m.hit === null ? "" : ` · Cache hit ${m.hit.toFixed(1)}%`;
  const b =
    m.ctxSize !== null && m.ctxSize !== undefined
      ? `${ICON2}  ${fmtTok(m.ctxUsed)}/${fmtTok(m.ctxSize)} tok${hit}`
      : `${ICON2}  ${fmtTok(m.total)} tok${hit}`;
  // 环形占用圈：只传 0..1 的比例（超窗钳到 1），SVG 渲染在注入端
  const ring =
    m.ctxPct === null || m.ctxPct === undefined
      ? null
      : { frac: Math.max(0, Math.min(1, m.ctxPct / 100)), label: `${m.ctxPct.toFixed(1)}%` };
  const title = [
    `prompt ${fmtTok(m.in)} (cached ${fmtTok(m.cached)}) · out ${fmtTok(m.out)}`,
    m.ctxSize ? `ctx ${fmtTok(m.ctxUsed)}/${fmtTok(m.ctxSize)}` : null,
    m.model || null,
    m.session ? `sess ${String(m.session).slice(0, 8)}` : null,
    m.ts || null,
  ]
    .filter(Boolean)
    .join("  ·  ");
  return { a, b, ring, title };
}

// ---------------------------------------------------------------- 页内注入

const SNIPPET = `(() => {
  const S = @@STATE@@;
  const root = document.querySelector('[data-testid="v4-composer"]');
  let host = document.getElementById('zctb-host');
  if (!root) { if (host) host.remove(); return { ok: 0, sid: null }; }
  if (!host || host.parentElement !== root) {
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'zctb-host';
    host.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:16px;height:16px;margin:2px 0 0;font:11px/16px inherit;color:var(--color-foreground-subtle);white-space:nowrap;overflow:hidden;user-select:none;font-variant-numeric:tabular-nums;cursor:default;';
    host.innerHTML = '<span data-zctb="a"></span><span data-zctb="b"></span><span data-zctb="c" style="display:inline-flex;align-items:center;gap:4px;"></span>';
    root.appendChild(host);
  }
  const set = (k, v) => {
    const el = host.querySelector('[data-zctb="' + k + '"]');
    if (el && el.textContent !== v) el.textContent = v;
  };
  set('a', S.a); set('b', S.b);
  // 环形占用圈：与模型选择器旁的圈同式。外径 12px，轨道用弱化色，进度弧用前景色，
  // 从 12 点钟方向顺时针描（rotate(-90)），弧长 = 2πr × frac；无数据时整段留空
  const cEl = host.querySelector('[data-zctb="c"]');
  const ringKey = S.ring ? S.ring.frac.toFixed(4) + '|' + S.ring.label : '';
  if (cEl && cEl.getAttribute('data-ring') !== ringKey) {
    cEl.setAttribute('data-ring', ringKey);
    if (!S.ring) {
      cEl.innerHTML = '';
    } else {
      const R = 5, CIRC = 2 * Math.PI * R;
      const arc = (CIRC * S.ring.frac).toFixed(2);
      const esc = String(S.ring.label).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      cEl.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
        '<circle cx="6" cy="6" r="' + R + '" fill="none" stroke="var(--color-foreground-subtle,rgba(127,127,127,.35))" stroke-width="1.6" opacity=".45"/>' +
        '<circle cx="6" cy="6" r="' + R + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
        'stroke-dasharray="' + arc + ' ' + CIRC.toFixed(2) + '" transform="rotate(-90 6 6)"/>' +
        '</svg><span>' + esc + '</span>';
    }
  }
  if (host.title !== S.title) host.title = S.title;
  // 报告这个窗口正在显示的会话，规则：
  //   1. 只认 sess_<uuid>：新任务首页的面板值是字面量 "draft"，不是会话
  //   2. 面板可能同时挂着多个，优先「包含输入框」的那个（用户就在那儿打字），其次消息多的
  //   3. 认不出会话时返回 null —— 上游会显示 waiting，而不是拿别的会话的数字顶上
  let sid = null, best = -1;
  const cr = root.getBoundingClientRect();
  for (const el of document.querySelectorAll('[data-session-id]')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const raw = el.getAttribute('data-session-id') || '';
    if (!/^sess_/i.test(raw)) continue;
    const inside = cr.left >= r.left - 2 && cr.top >= r.top - 2 && cr.right <= r.right + 2 && cr.bottom <= r.bottom + 2;
    const score = (inside ? 1000 : 0) + el.querySelectorAll('[data-turn-id], [data-turn-key]').length;
    if (score > best) { best = score; sid = raw; }
  }
  return { ok: 1, sid: sid };
})()`;

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

class CDP {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
  }

  get connected() {
    return this.ws && this.ws.readyState === 1;
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("cdp timeout: " + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r?.result?.value;
  }
}

// ---------------------------------------------------------------- 悬浮窗回退

function findPythonw() {
  const cands = [];
  if (process.env.ZCTB_PYTHONW) cands.push(process.env.ZCTB_PYTHONW);
  // 安装器写入的 paths.ini（与脚本同目录）
  try {
    const ini = fs.readFileSync(path.join(TOOL_DIR, "paths.ini"), "utf8");
    for (const line of ini.split(/\r?\n/)) {
      const m = /^\s*pythonw\s*=\s*(.+?)\s*$/.exec(line);
      if (m && m[1]) cands.push(m[1]);
    }
  } catch {}
  const base = process.env.LOCALAPPDATA || "";
  if (base) {
    for (const d of ["Python313", "Python312", "Python311"]) {
      cands.push(path.join(base, "Programs", "Python", d, "pythonw.exe"));
    }
    try {
      const root = path.join(base, "Programs", "Python");
      for (const d of fs.readdirSync(root).filter((x) => /^Python3/i.test(x)).sort().reverse()) {
        cands.push(path.join(root, d, "pythonw.exe"));
      }
    } catch {}
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return "pythonw"; // 交给 PATH 解析，最后兜底
}

function spawnFloat() {
  const exe = findPythonw();
  try {
    const child = spawn(exe, [path.join(TOOL_DIR, "token_bar.py")], {
      cwd: TOOL_DIR,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {}); // 找不到 pythonw 时不致崩
    child.unref();
    return child.pid || null;
  } catch {
    return null;
  }
}

// 结束悬浮窗进程前先核对进程名，避免 pid 复用误杀
function killFloat(pid) {
  if (!pid) return;
  execFile(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/NH"],
    { windowsHide: true, timeout: 5000 },
    (err, stdout) => {
      if (!err && /pythonw\.exe/i.test(stdout || "")) {
        try {
          process.kill(pid);
        } catch {}
      }
    }
  );
}

// ---------------------------------------------------------------- 主流程

function acquireSingleton() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.listen(SINGLETON_PORT, "127.0.0.1", () => resolve(server));
  });
}

function zcodeRunning() {
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", "IMAGENAME eq ZCode.exe", "/NH"],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(true); // 查询失败时不误退出
        resolve(/ZCode\.exe/i.test(stdout || ""));
      }
    );
  });
}

// The ZCode updater may rewrite the Start Menu shortcut back to a plain ZCode.exe
// launch, which drops the Chromium debug port. Without it the in-page counter
// cannot attach. While the port stays unreachable, repair the shortcut (idempotent)
// so the next Start Menu launch restores it automatically.
const HEAL_SCRIPT = path.join(TOOL_DIR, "ensure-shortcut.vbs");
let healWarned = false;
function healShortcut() {
  try {
    if (!fs.existsSync(HEAL_SCRIPT)) {
      if (!healWarned) {
        healWarned = true;
        logLine(`shortcut heal script missing: ${HEAL_SCRIPT}`);
      }
      return;
    }
    const child = spawn("wscript.exe", [HEAL_SCRIPT], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

function detachSelf() {
  const child = spawn(process.execPath, [__filename], {
    cwd: TOOL_DIR,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--spawn")) {
    detachSelf();
    return;
  }

  const dump = argv.includes("--dump");
  // --dump 不给文件参数时才用「最新写入的文件」兜底；常驻模式一律由页面报告的会话决定
  const dumpFile = argv.find((a) => !a.startsWith("--")) || newestSessionFile();
  const tracker = new Tracker(dump ? dumpFile || null : null);
  if (dump) {
    tracker.poll();
    const m = tracker.metrics();
    console.log("file      :", m.file);
    console.log("session   :", m.session || "-");
    console.log(`turns     : ${m.turns}   steps: ${m.reqs}`);
    console.log(`in/cached/out : ${m.in} / ${m.cached} / ${m.out}`);
    console.log("total     :", m.total);
    console.log("cache hit :", m.hit === null ? "-" : m.hit.toFixed(1) + "%");
    console.log("tok/s     :", fmtTps(m.tps), "(last turn avg)");
    console.log("ctx       :", `${m.ctxUsed}/${m.ctxSize} = ${m.ctxPct}%`);
    console.log("model     :", m.model);
    return;
  }

  const guard = await acquireSingleton();
  if (!guard) return; // 已有实例在运行

  const cdp = new CDP(CDP_PORT);
  let floatPid = null;
  let graceDeadline = Date.now() + PORT_WAIT_MS;
  let mode = "waiting"; // waiting | page | float
  const snippet = SNIPPET;

  const tryConnect = async () => {
    if (cdp.connected) return true;
    let targets;
    try {
      targets = await httpJson(CDP_PORT, "/json/list");
    } catch {
      return false;
    }
    const page = targets.find((t) => t.type === "page" && (t.url || "").includes("index.html"));
    if (!page) return false;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const ok = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 4000);
      ws.onopen = () => {
        clearTimeout(to);
        resolve(true);
      };
      ws.onerror = () => {
        clearTimeout(to);
        resolve(false);
      };
    });
    if (!ok) {
      try {
        ws.close();
      } catch {}
      return false;
    }
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const entry = cdp.pending.get(msg.id);
      if (entry) {
        cdp.pending.delete(msg.id);
        msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
      }
    };
    ws.onclose = () => {
      if (cdp.ws === ws) cdp.ws = null;
      for (const [id, entry] of cdp.pending) {
        entry.reject(new Error("page connection closed"));
        cdp.pending.delete(id);
      }
    };
    cdp.ws = ws;
    return true;
  };

  let tickCount = 0;
  let pageSid = null; // 页面报告的「正在显示的会话」（sess_<uuid>）
  let pinnedSid = null; // 已据此钉住数据文件的会话
  let lastTimeoutLog = 0; // evaluate 超时日志限流
  let timeoutStreak = 0; // 连续超时次数：连接可能被别的 CDP 客户端顶掉了
  let lastHealAttempt = 0; // 上次尝试修快捷方式的时间（端口连不上时才动）
  let lastInjected = null; // 上次注入是否找到注入点（变化时记一行日志）

  const loop = async () => {
    tracker.poll();
    const m = tracker.metrics();
    const state = buildState(m);

    if (++tickCount % ALIVE_CHECK_EVERY === 0) {
      const running = await zcodeRunning();
      if (!running) {
        // ZCode 已退出：收起悬浮窗，回到等待；ZCode 再次启动（带调试端口）后自动接管
        if (floatPid) {
          killFloat(floatPid);
          floatPid = null;
          logLine("ZCode closed - float window removed, waiting for next launch");
        }
        if (mode === "page") {
          cdp.disconnect();
          mode = "waiting";
          graceDeadline = Date.now() + PORT_WAIT_MS;
        }
        if (mode === "float") {
          mode = "waiting";
          graceDeadline = Date.now() + PORT_WAIT_MS;
        }
      }
    }

    if (mode !== "page") {
      if (await tryConnect()) {
        if (floatPid) {
          killFloat(floatPid);
          logLine("CDP port found - switching to in-page bar, closing float window");
          floatPid = null;
        } else {
          logLine(`connected to ZCode UI on port ${CDP_PORT} - in-page bar active`);
        }
        mode = "page";
      } else {
        // 端口连不上：ZCode 可能压根没带调试端口启动（更新器改回了快捷方式）→ 自愈
        if (Date.now() - lastHealAttempt > HEAL_MS) {
          lastHealAttempt = Date.now();
          healShortcut();
        }
        if (mode === "waiting" && Date.now() > graceDeadline) {
          if (await zcodeRunning()) {
            if (FLOAT_FALLBACK) {
              floatPid = spawnFloat();
              if (floatPid) logLine("ZCode running without debug port - fell back to floating window");
              else logLine("no debug port and no pythonw - floating fallback unavailable");
            }
            mode = "float";
          } else {
            graceDeadline = Date.now() + PORT_WAIT_MS; // ZCode 未运行，安静等待
          }
        }
      }
    }

    if (mode === "page") {
      try {
        const expr = snippet.replace("@@STATE@@", JSON.stringify(state));
        const r = await cdp.evaluate(expr);
        timeoutStreak = 0;
        // 页面会顺带报告它正在显示的会话；钉住对应的数据文件。
        // 认不出会话（新任务首页 "draft"、面板还没建立等）→ 不显示任何统计，等它出现。
        if (r && typeof r === "object") {
          // 注入点是否找到：找不到多半是 ZCode 升级改了界面（选择器要跟着改）
          const ok = r.ok === 1;
          if (ok !== lastInjected) {
            lastInjected = ok;
            logLine(
              ok
                ? "injection point found - bar is live"
                : "no [data-testid=v4-composer] in page - bar hidden (ZCode UI changed? update the SNIPPET selector)"
            );
          }
          pageSid = r.sid || null;
          if (pageSid !== pinnedSid) {
            pinnedSid = pageSid;
            const f = pageSid ? sessionFile(pageSid) : null;
            tracker.pinnedFile = f;
            if (f) {
              logLine(
                `following visible session ${pageSid} -> ${path.basename(f)}` +
                  (fs.existsSync(f) ? "" : " (no data yet)")
              );
            } else if (pageSid) {
              logLine(`visible session ${pageSid} has no model-io mapping - waiting`);
            } else {
              logLine("page shows no session (new-task panel?) - waiting, no stats");
            }
          }
        }
      } catch (e) {
        if (/cdp timeout/.test(e.message)) {
          // 页面一时忙不过来（长会话重渲染、流式输出）时不值得断线；
          // 但一个页面目标同时只允许一个调试客户端，被别的客户端（调试脚本、
          // DevTools）顶掉后也会表现为超时——所以连续几次没回应就重连。
          timeoutStreak += 1;
          const now = Date.now();
          if (now - lastTimeoutLog > 30000) {
            lastTimeoutLog = now;
            logLine(`evaluate timeout x${timeoutStreak} - page busy or another CDP client took over`);
          }
          if (timeoutStreak >= 3) {
            timeoutStreak = 0;
            cdp.disconnect();
            mode = "waiting";
            graceDeadline = Date.now() + PORT_WAIT_MS;
            logLine("no response after 3 tries - reconnecting");
          }
        } else {
          timeoutStreak = 0;
          cdp.disconnect();
          mode = "waiting";
          graceDeadline = Date.now() + PORT_WAIT_MS;
          logLine("page connection lost: " + e.message);
        }
      }
    }
  };

  const tick = async () => {
    try {
      await loop();
    } catch (e) {
      logLine("loop error: " + e.message);
    }
    setTimeout(tick, POLL_MS);
  };

  process.on("SIGINT", () => {
    killFloat(floatPid);
    cdp.disconnect();
    process.exit(0);
  });

  logLine(`token bar controller started (port ${CDP_PORT}, singleton ${SINGLETON_PORT})`);
  tick();
}

main();
