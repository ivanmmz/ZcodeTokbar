#!/usr/bin/env python3
"""ZCode 悬浮 Token 计数器 —— 贴在 ZCode 窗口（对话框）下方的实时用量条。

数据来源: ~/.zcode/cli/rollout/model-io-<session>.jsonl
每次模型请求一行，含 response.usage / durationMs / turnId。
默认自动跟随最近活动的会话文件；默认跟随 ZCode 窗口位置（拖动后转为手动）。

用法:
  pythonw token_bar.py                 正常启动（无控制台）
  python  token_bar.py --dump          只打印统计，不开窗口
  python  token_bar.py --pos 100,100   指定初始位置（并转为手动模式）
  python  token_bar.py --file <path>   固定读取某个会话日志
  python  token_bar.py --auto-quit-ms N   N 毫秒后自动退出（测试用）

显示口径（与 DeepSeek Harness 一致）:
  轮次 = 不同 turnId 数量（你发了几轮）；步数 = 模型请求次数（含工具循环）；
  tok/s = 最近 5 次请求的输出速度；缓存命中 = 缓存读取 / 输入侧总量；
  百分比 = 最近一次请求的（输入侧+输出）/ 模型上下文窗口。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

ROLLOUT_DIR = Path.home() / ".zcode" / "cli" / "rollout"
STATE_PATH = Path(__file__).with_name("state.json")

BG = "#1f2023"
BORDER = "#3a3d43"
FG = "#d8d9dd"
DIM = "#8f9196"
ICON1, ICON2, ICON3 = "\u27f3", "\u26c1", "\u25c9"  # ⟳ ⛁ ◉
FONT = ("Segoe UI", 9)
FONT_SMALL = ("Segoe UI", 8)

GAP_BELOW_WINDOW = 6   # 计数条与 ZCode 窗口底边的间距
SCREEN_MARGIN = 4


# ---------------------------------------------------------------- 数据层

def newest_session_file() -> Path | None:
    if not ROLLOUT_DIR.is_dir():
        return None
    files = sorted(
        ROLLOUT_DIR.glob("model-io-*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    return files[0] if files else None


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    try:
        STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception:
        pass


def load_context_limits() -> dict:
    """从 ZCode 配置里收集 模型 -> 上下文窗口 的映射。"""
    limits: dict[str, int] = {}
    paths = [
        Path.home() / ".zcode" / "v2" / "provider_config.json",
        Path.home() / ".zcode" / "v2" / "config.json",
    ]
    for p in paths:
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        rules = ((d.get("config") or {}).get("modelConfigRules") or {}).get(
            "providerModelRules"
        ) or []
        for r in rules:
            cw = ((r.get("config") or {}).get("properties") or {}).get("contextWindow")
            if cw and r.get("modelId"):
                limits.setdefault(r["modelId"], int(cw))
        for prov in (d.get("provider") or {}).values():
            for mid, m in (prov.get("models") or {}).items():
                cw = (m.get("limit") or {}).get("context")
                if cw:
                    limits.setdefault(mid, int(cw))
                    limits.setdefault(mid.split("/")[-1], int(cw))
    return limits


class Tracker:
    """增量 tail 会话日志，累计本会话的 token 统计。"""

    def __init__(self, pinned: Path | None, ctx_override: int | None = None):
        self.pinned = pinned
        self.limits = load_context_limits()
        self.ctx_override = ctx_override
        self.path: Path | None = None
        self.fh = None
        self.buf = b""
        self._reset(None)

    def _reset(self, path: Path | None) -> None:
        if self.fh:
            try:
                self.fh.close()
            except Exception:
                pass
        self.path = path
        self.fh = None
        self.buf = b""
        if path:
            try:
                self.fh = open(path, "rb")
            except Exception:
                self.fh = None
        self.reqs = 0
        self.turn_ids: set[str] = set()
        self.inp = self.cr = self.cw = self.out = 0
        self.speeds: deque = deque(maxlen=5)
        self.last: dict | None = None

    def poll(self) -> None:
        target = self.pinned or newest_session_file()
        if target != self.path:
            self._reset(target)
        if not self.fh:
            return
        try:
            data = self.fh.read()
        except Exception:
            return
        if not data:
            return
        self.buf += data
        parts = self.buf.split(b"\n")
        self.buf = parts.pop()
        for raw in parts:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            self._consume(obj)

    def _consume(self, obj: dict) -> None:
        usage = (obj.get("response") or {}).get("usage") or {}
        inp = int(usage.get("inputTokens") or 0)
        out = int(usage.get("outputTokens") or 0)
        cr = int(usage.get("cacheReadTokens") or 0)
        cw = int(usage.get("cacheWriteTokens") or 0)
        dur = float(obj.get("durationMs") or 0)
        self.reqs += 1
        self.inp += inp
        self.out += out
        self.cr += cr
        self.cw += cw
        tid = obj.get("turnId")
        if isinstance(tid, str) and tid:
            self.turn_ids.add(tid)
        if dur > 0 and out > 0:
            self.speeds.append((out, dur))
        headers = (obj.get("request") or {}).get("headers") or {}
        self.last = {
            "in": inp,
            "out": out,
            "cached": cr,
            "prompt": inp + cr + cw,
            "dur": dur,
            "model": (obj.get("model") or {}).get("modelId"),
            "session": headers.get("x-session-id"),
            "completed": obj.get("completedAt"),
        }

    # ---- 派生指标 ----
    def metrics(self) -> dict:
        m: dict = {"reqs": self.reqs, "turns": len(self.turn_ids) if self.reqs else None}
        m["total"] = self.inp + self.cr + self.cw + self.out
        prompt_side = self.inp + self.cr + self.cw
        m["hit"] = (self.cr / prompt_side * 100) if prompt_side else None
        if self.speeds:
            o = sum(s[0] for s in self.speeds)
            d = sum(s[1] for s in self.speeds)
            m["tps"] = o / (d / 1000) if d else None
        else:
            m["tps"] = None
        m["model"] = self.last and self.last["model"]
        m["in"], m["cached"], m["out"] = self.inp, self.cr, self.out
        if self.last:
            used = self.last["prompt"] + self.last["out"]
            size = (
                self.ctx_override
                or (self.limits.get(self.last["model"] or "") if self.last["model"] else None)
                or (self.limits.get((self.last["model"] or "").split("/")[-1]) if self.last["model"] else None)
            )
            if not size and (self.last["model"] or "").startswith("deepseek"):
                size = 1_000_000  # ZCode 未配置 deepseek 窗口时的经验默认值
            m["ctx_used"], m["ctx_size"] = used, size
            if size:
                m["ctx_pct"] = min(999, round(used / size * 100))
        m["last_ts"] = self.last and self.last["completed"]
        m["session"] = self.last and self.last["session"]
        m["file"] = str(self.path) if self.path else None
        return m


def fmt_tok(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M".replace(".0M", "M")
    if n >= 10_000:
        return f"{round(n/1000)}K"
    if n >= 1_000:
        return f"{n/1000:.1f}K"
    return str(n)


def fmt_tps(v: float | None) -> str:
    if not v:
        return "--"
    return str(round(v)) if v >= 100 else f"{v:.1f}"


# ---------------------------------------------------------------- 定位

def find_zcode_rect():
    """找到可见的 ZCode 主窗口矩形，返回 (left, top, right, bottom) 或 None。"""
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        class RECT(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                        ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

        best = [0, None]
        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

        def cb(hwnd, _):
            if not user32.IsWindowVisible(hwnd):
                return True
            pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            h = kernel32.OpenProcess(0x1000, False, pid)
            if not h:
                return True
            try:
                size = ctypes.c_ulong(1024)
                name = ctypes.create_unicode_buffer(1024)
                if kernel32.QueryFullProcessImageNameW(h, 0, name, ctypes.byref(size)):
                    low = name.value.lower()
                    if low.endswith("zcode.exe") and "\\glm\\" not in low:
                        r = RECT()
                        if user32.GetWindowRect(hwnd, ctypes.byref(r)):
                            w, hh = r.right - r.left, r.bottom - r.top
                            if w > 400 and hh > 300 and w * hh > best[0]:
                                best[0], best[1] = w * hh, (r.left, r.top, r.right, r.bottom)
            finally:
                kernel32.CloseHandle(h)
            return True

        user32.EnumWindows(WNDENUMPROC(cb), 0)
        return best[1]
    except Exception:
        return None


# ---------------------------------------------------------------- 界面

def run_gui(args) -> None:
    import tkinter as tk

    state = load_state()
    tracker = Tracker(Path(args.file) if args.file else None, state.get("contextWindow"))
    pinned_file = state.get("sessionFile") or args.file
    if pinned_file and not args.file:
        tracker.pinned = Path(pinned_file)

    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    try:
        root.attributes("-alpha", 0.94)
    except Exception:
        pass
    root.configure(bg=BG)

    outer = tk.Frame(root, bg=BG, highlightthickness=1,
                     highlightbackground=BORDER, highlightcolor=BORDER)
    outer.pack(fill="both", expand=True)

    row1 = tk.Frame(outer, bg=BG)
    row1.pack(anchor="w", padx=10, pady=(5, 0))
    row2 = tk.Frame(outer, bg=BG)
    row2.pack(anchor="w", padx=10, pady=(0, 6))

    seg1 = tk.Label(row1, text="", bg=BG, fg=FG, font=FONT)
    seg1.pack(side="left")
    tk.Frame(row1, bg=BG, width=18, height=1).pack(side="left")
    seg2 = tk.Label(row1, text="", bg=BG, fg=FG, font=FONT)
    seg2.pack(side="left")
    tk.Frame(row1, bg=BG, width=18, height=1).pack(side="left")
    seg3 = tk.Label(row1, text="", bg=BG, fg=FG, font=FONT)
    seg3.pack(side="left")

    detail = tk.Label(row2, text="", bg=BG, fg=DIM, font=FONT_SMALL, justify="left")

    follow = {"on": bool(state.get("follow", True)) and not args.pos}
    if args.pos:
        start = args.pos
    elif not follow["on"]:
        start = (int(state.get("x", 60)), int(state.get("y", 60)))
    else:
        start = None
    win = {"x": 0, "y": 0, "w": 0, "h": 0}
    drag = {"dx": 0, "dy": 0, "moved": False}
    placed = {"done": False}

    def measure():
        root.update_idletasks()
        return root.winfo_reqwidth(), root.winfo_reqheight()

    def place():
        """按当前模式重新计算位置：跟随 ZCode 窗口或用户手动位置。"""
        w, h = measure()
        win["w"], win["h"] = w, h
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        x, y = win["x"], win["y"]
        if start is not None and not placed["done"]:
            x, y = start
        rect = find_zcode_rect() if follow["on"] else None
        if rect:
            left, top, right, bottom = rect
            x = left + max(0, (right - left - w) // 2)
            y = bottom + GAP_BELOW_WINDOW
        elif follow["on"]:
            x = max(0, (sw - w) // 2)          # 找不到窗口时兜底：屏幕底部居中
            y = sh - h - 60
        x = min(max(0, x), max(0, sw - w))
        y = min(max(0, y), max(0, sh - h - SCREEN_MARGIN))
        win["x"], win["y"] = x, y
        placed["done"] = True
        root.geometry(f"{w}x{h}+{x}+{y}")

    # ---- 拖动 ----
    def on_press(e):
        drag["dx"], drag["dy"] = e.x_root - win["x"], e.y_root - win["y"]
        drag["moved"] = False

    def on_move(e):
        if follow["on"]:
            follow["on"] = False
            follow_var.set(False)
        win["x"], win["y"] = e.x_root - drag["dx"], e.y_root - drag["dy"]
        drag["moved"] = True
        root.geometry(f"+{win['x']}+{win['y']}")

    def on_release(_):
        if drag["moved"]:
            state["x"], state["y"] = win["x"], win["y"]
            state["follow"] = follow["on"]
            save_state(state)

    root.bind("<Button-1>", on_press)
    root.bind("<B1-Motion>", on_move)
    root.bind("<ButtonRelease-1>", on_release)
    root.bind("<Escape>", lambda e: root.destroy())

    # ---- 详情行 & 菜单 ----
    def toggle_detail(_=None):
        if detail.winfo_ismapped():
            detail.pack_forget()
        else:
            detail.pack(anchor="w", padx=10, pady=(0, 6))
        place()

    root.bind("<Double-Button-1>", toggle_detail)

    def copy_stats():
        m = tracker.metrics()
        if m["reqs"]:
            turns = m.get("turns") or 0
            text = f"{turns} turns {m['reqs']} steps | {fmt_tok(m['total'])} tok"
            if m.get("hit") is not None:
                text += f" | cache hit {m['hit']:.0f}%"
            if m.get("ctx_pct") is not None:
                text += f" | ctx {m['ctx_pct']}%"
        else:
            text = "no session data"
        root.clipboard_clear()
        root.clipboard_append(text)

    def reload_session():
        tracker.pinned = None
        tracker._reset(None)

    def toggle_follow():
        follow["on"] = not follow["on"]
        follow_var.set(follow["on"])
        state["follow"] = follow["on"]
        save_state(state)
        place()

    menu = tk.Menu(root, tearoff=0)
    follow_var = tk.BooleanVar(value=follow["on"])
    menu.add_checkbutton(label="跟随 ZCode 窗口", variable=follow_var, command=toggle_follow)
    menu.add_command(label="会话详情", command=toggle_detail)
    menu.add_command(label="复制统计", command=copy_stats)
    menu.add_command(label="重新载入会话", command=reload_session)
    menu.add_separator()
    menu.add_command(label="退出", command=root.destroy)
    root.bind("<Button-3>", lambda e: menu.tk_popup(e.x_root, e.y_root))

    ticks = {"n": 0}

    def tick():
        try:
            tracker.poll()
            m = tracker.metrics()
            if m["reqs"]:
                turns = m["turns"] if m.get("turns") is not None else 0
                seg1.config(text=f"{ICON1}  {turns} turn{'s' if turns != 1 else ''} "
                                 f"{m['reqs']} steps · {fmt_tps(m.get('tps'))} tok/s")
                hit = f" · Cache hit {m['hit']:.0f}%" if m.get("hit") is not None else ""
                seg2.config(text=f"{ICON2}  {fmt_tok(m['total'])} tok{hit}")
                seg3.config(text=f"{ICON3}  {m['ctx_pct']}%" if m.get("ctx_pct") is not None else "")
                detail.config(text=(
                    f"in {fmt_tok(m['in'])} · cached {fmt_tok(m['cached'])} · out {fmt_tok(m['out'])}"
                    f" · ctx {fmt_tok(m.get('ctx_used') or 0)}/{fmt_tok(m.get('ctx_size') or 0)}"
                    f" · {m.get('model') or '?'} · sess {(m.get('session') or '?')[:8]}"
                    f" · {m.get('last_ts') or ''}"
                ))
            else:
                seg1.config(text=f"{ICON1}  waiting for a session…")
                seg2.config(text="")
                seg3.config(text="")
            place()
            ticks["n"] += 1
            if ticks["n"] % 12 == 0:
                root.attributes("-topmost", True)  # 偶尔重申置顶，防止被挤到后面
        except Exception as exc:  # 界面永不因数据异常崩溃
            seg1.config(text=f"error: {exc}")
        root.after(800, tick)

    place()
    tick()
    if args.auto_quit_ms:
        root.after(args.auto_quit_ms, root.destroy)
    root.mainloop()

    state["follow"] = follow["on"]
    if not follow["on"]:
        state["x"], state["y"] = win["x"], win["y"]
    save_state(state)


# ---------------------------------------------------------------- CLI

def set_dpi_awareness() -> None:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


_mutex_handle = None


def acquire_singleton() -> bool:
    """命名互斥体，保证同时只有一个计数条实例（hook 可能多次启动它）。"""
    global _mutex_handle
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        _mutex_handle = kernel32.CreateMutexW(None, False, "Local\\ZCodeTokenBar")
        if not _mutex_handle:
            return True
        ERROR_ALREADY_EXISTS = 183
        return ctypes.get_last_error() != ERROR_ALREADY_EXISTS
    except Exception:
        return True


def spawn_detached() -> None:
    """hook 入口：脱离父进程启动 GUI 后立即返回，不阻塞会话启动。"""
    script = Path(__file__).resolve()
    exe = Path(sys.executable)
    if exe.name.lower() == "python.exe":
        alt = exe.with_name("pythonw.exe")
        if alt.exists():
            exe = alt
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    subprocess.Popen(
        [str(exe), str(script)],
        cwd=str(script.parent),  # 不继承会话的工作目录
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true", help="打印统计后退出")
    ap.add_argument("--pos", help="初始位置 x,y（转为手动模式）")
    ap.add_argument("--file", help="固定读取的会话日志")
    ap.add_argument("--auto-quit-ms", type=int, default=0)
    ap.add_argument("--spawn", action="store_true", help="脱离启动 GUI 后立即退出（hook 入口）")
    ap.add_argument("--allow-multiple", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()
    if args.pos:
        try:
            args.pos = tuple(int(v) for v in args.pos.split(","))
        except Exception:
            args.pos = None
    else:
        args.pos = None

    if args.dump:
        tracker = Tracker(Path(args.file) if args.file else None)
        tracker.poll()
        m = tracker.metrics()
        print(f"file      : {m['file']}")
        print(f"turns     : {m.get('turns')}   steps: {m['reqs']}")
        print(f"in/cached/out : {m['in']} / {m['cached']} / {m['out']}")
        print(f"total     : {m['total']}")
        print(f"cache hit : {m['hit']:.1f}%" if m.get("hit") is not None else "cache hit : -")
        print(f"tok/s     : {fmt_tps(m.get('tps'))}")
        print(f"ctx       : {m.get('ctx_used')}/{m.get('ctx_size')} = {m.get('ctx_pct')}%")
        print(f"model     : {m.get('model')}")
        return

    if args.spawn:
        spawn_detached()
        return

    if not args.allow_multiple and not acquire_singleton():
        return

    set_dpi_awareness()
    run_gui(args)


if __name__ == "__main__":
    main()
