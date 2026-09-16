"""今日足迹悬浮窗 — 纯 Win32 API 原生实现（ctypes 直调，零第三方依赖）。

定位：主动性模块在后台代办/盯梢结果的**独立**桌面常驻展示——与桌宠
（sphere-overlay-py / QtWebEngine / Three.js 框架）完全无关，也不依赖任何
Python 第三方库：窗口/绘制走 user32/gdi32/dwmapi，数据走 urllib 轮询
server 的 GET /agent/activities（与主应用「代办足迹」卡同源）。

形态（与主应用足迹卡同一套配色语义，深色原生面板）：
  - 冒泡态（264x46）：最新一条代办（类别字标 + 标题 + 状态 pill + 呼吸点），
    无数据时常驻「今日足迹」标题；点击冒泡展开
  - 展开态：今日足迹列表（最多 6 条）；标题栏「—」收起，空白处拖动
  - 右键菜单：展开/收起、退出；置顶工具窗口，不进任务栏

环境变量：
  PAI_HTTP_BASE   默认 http://127.0.0.1:3000
  PAI_ACTOR_ID    与主应用 USER_ID 一致（默认 session-mvp-001），否则查不到台账
  PAI_POLL_SEC    轮询间隔（默认 20）
  PAI_X/PAI_Y     初始位置（默认右下角工作区）；PAI_STATE=expanded 初始展开
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import os
import struct
import re
import sys
import threading
import time
import urllib.parse
import urllib.request

# ===== Win32 =====
user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
dwmapi = ctypes.windll.dwmapi
kernel32 = ctypes.windll.kernel32

# 64 位参数宽度：WPARAM/HINSTANCE/LRESULT 都是指针宽，必须显式声明，
# 否则 ctypes 默认按 32 位 c_int 转换会 OverflowError/截断
user32.DefWindowProcW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
user32.DefWindowProcW.restype = ctypes.c_ssize_t
user32.CreateWindowExW.argtypes = [
    ctypes.c_uint32, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
user32.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]

WS_POPUP = 0x80000000
WS_EX_TOPMOST = 0x8
WS_EX_TOOLWINDOW = 0x80
WS_EX_LAYERED = 0x80000
WM_PAINT = 0x000F
WM_DESTROY = 0x0002
WM_TIMER = 0x0113
WM_LBUTTONDOWN = 0x0201
WM_RBUTTONUP = 0x0205
WM_APP_DATA = 0x8000  # WM_APP：数据线程 → UI 刷新
WM_APP_TICK = 0x8001  # 呼吸点动画
CS_HREDRAW, CS_VREDRAW = 0x0002, 0x0001
HTCAPTION = 0x2
SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_FRAMECHANGED = 0x1, 0x2, 0x4, 0x20
SW_SHOW = 5
DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND = 33, 1
LWA_ALPHA = 0x2
SPI_GETWORKAREA = 0x0030
SRCCOPY = 0x00CC
TRANSPARENT = 2
DT_SINGLELINE, DT_END_ELLIPSIS, DT_VCENTER = 0x20, 0x8000, 0x4
DT_LEFT, DT_RIGHT = 0x0, 0x2
FW_SEMIBOLD, FW_BOLD, FW_NORMAL = 600, 700, 400
CLEARTYPE_QUALITY = 5

# ===== 主题（与主应用 agent_activity_section.dart 状态色对齐，深色原生面板）=====
COLOR_BG = (0x0B, 0x0B, 0x0E)
COLOR_TITLE = (0xF5, 0xF5, 0xF5)
COLOR_TEXT = (0xE5, 0xE5, 0xE5)
COLOR_MUTED = (0x88, 0x88, 0x88)
COLOR_OFFLINE = (0xFF, 0x9D, 0x9D)
COLOR_LINE = (0x22, 0x22, 0x28)
STATUS_COLORS = {
    "pending": (0x18, 0xD6, 0xF3),
    "done": (0x1E, 0xD7, 0xA6),
    "changed": (0xD7, 0xB8, 0x5A),
    "failed": (0xFF, 0x9D, 0x9D),
}
STATUS_LABELS = {"pending": "进行中", "done": "已完成", "changed": "已调整", "failed": "未办成"}
CATEGORY_COLORS = {
    "purchase": (0x18, 0xD6, 0xF3),
    "payment": (0x1E, 0xD7, 0xA6),
    "schedule": (0xD7, 0xB8, 0x5A),
    "booking": (0x18, 0xD6, 0xF3),
    "message": (0x18, 0xD6, 0xF3),
    "generic": (0x18, 0xD6, 0xF3),
}
CATEGORY_GLYPHS = {"purchase": "购", "payment": "缴", "schedule": "程",
                   "booking": "约", "message": "信", "generic": "办"}

WIDTH = 264
BUBBLE_H = 46
HEADER_H = 38
ENTRY_H = 52
MAX_ENTRIES = 6


class PAINTSTRUCT(ctypes.Structure):
    _fields_ = [
        ("hdc", ctypes.c_void_p), ("fErase", ctypes.c_int),
        ("rcPaint", wt.RECT), ("fRestore", ctypes.c_int),
        ("fIncUpdate", ctypes.c_int), ("rgbReserved", ctypes.c_byte * 32),
    ]


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", ctypes.c_uint), ("lpfnWndProc", ctypes.c_void_p),
        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
        ("hInstance", ctypes.c_void_p), ("hIcon", ctypes.c_void_p),
        ("hCursor", ctypes.c_void_p), ("hbrBackground", ctypes.c_void_p),
        ("lpszMenuName", ctypes.c_wchar_p), ("lpszClassName", ctypes.c_wchar_p),
    ]


def blend(fg, ratio=0.16):
    """前景色按 ratio 混入黑底 → pill/图标盒底色（GDI 无 alpha 填充，预先合成）。"""
    return tuple(int(c * ratio) for c in fg)


def rgb(c):
    return c[0] | (c[1] << 8) | (c[2] << 16)


def lparam_xy(lp: int) -> tuple[int, int]:
    x = ctypes.c_short(lp & 0xFFFF).value
    y = ctypes.c_short((lp >> 16) & 0xFFFF).value
    return x, y


# ===== 数据层（后台线程轮询）=====
class Ledger:
    def __init__(self, http_base: str, actor_id: str, poll_sec: int, hwnd: int):
        self.http_base = http_base.rstrip("/")
        self.actor_id = actor_id
        self.poll_sec = max(5, poll_sec)
        self.hwnd = hwnd
        self.lock = threading.Lock()
        self.entries: list[dict] = []
        self.online = False

    @staticmethod
    def _norm(raw: dict) -> dict:
        kind = str(raw.get("kind", ""))
        rest = kind[7:] if kind.startswith("action.") else kind
        head = re.split(r"[._-]", rest)[0].strip().lower() if rest else ""
        category = str(raw.get("category") or head or "generic").lower()
        if category not in CATEGORY_COLORS:
            category = "generic"
        status = str(raw.get("status", "done"))
        label = str(raw.get("statusLabel") or STATUS_LABELS.get(status, "已完成"))
        return {
            "id": str(raw.get("id", "")),
            "title": str(raw.get("title", "")),
            "category": category,
            "status": status,
            "label": label,
            "createdAt": int(raw.get("createdAt", 0) or 0),
        }

    def snapshot(self) -> tuple[list[dict], dict | None, bool]:
        with self.lock:
            latest = dict(self.entries[0]) if self.entries else None
            return list(self.entries), latest, self.online

    def poll_once(self) -> None:
        url = (f"{self.http_base}/agent/activities"
               f"?actorId={urllib.parse.quote(self.actor_id)}&limit=20")
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            lt = time.localtime()
            day_start = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
            entries = [self._norm(x) for x in (data.get("activities") or [])]
            entries = [e for e in entries if e["createdAt"] >= day_start]
            entries.sort(key=lambda e: e["createdAt"], reverse=True)
            with self.lock:
                self.entries, self.online = entries[:MAX_ENTRIES], True
        except Exception as exc:  # noqa: BLE001
            print(f"[footprint] 拉取失败（{exc.__class__.__name__}），稍后重试")
            with self.lock:
                self.online = False
        user32.PostMessageW(self.hwnd, WM_APP_DATA, 0, 0)

    def loop(self) -> None:
        while True:
            self.poll_once()
            time.sleep(self.poll_sec)


# ===== 渲染 =====
class Painter:
    def __init__(self) -> None:
        self.scale = 1.0
        self._fonts: dict[tuple[int, int], int] = {}

    def set_scale(self, scale: float) -> None:
        self.scale = scale

    def font(self, hdc: int, px: int, weight: int = FW_NORMAL) -> None:
        px = max(9, round(px * self.scale))
        key = (px, weight)
        if key not in self._fonts:
            self._fonts[key] = gdi32.CreateFontW(
                -px, 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, CLEARTYPE_QUALITY, 0,
                "Microsoft YaHei UI")
        gdi32.SelectObject(hdc, self._fonts[key])

    def text(self, hdc: int, s: str, x: int, y: int, w: int, h: int, color,
             right: bool = False) -> None:
        gdi32.SetTextColor(hdc, rgb(color))
        gdi32.SetBkMode(hdc, TRANSPARENT)
        rect = wt.RECT(x, y, x + w, y + h)
        flags = DT_SINGLELINE | DT_END_ELLIPSIS | DT_VCENTER | (DT_RIGHT if right else DT_LEFT)
        user32.DrawTextW(hdc, s, -1, ctypes.byref(rect), flags)

    def fill(self, hdc: int, color, x: int, y: int, w: int, h: int, radius: int = 0) -> None:
        brush = gdi32.CreateSolidBrush(rgb(color))
        pen = gdi32.CreatePen(0, 1, rgb(color))
        old_brush = gdi32.SelectObject(hdc, brush)
        old_pen = gdi32.SelectObject(hdc, pen)
        if radius > 0:
            gdi32.RoundRect(hdc, x, y, x + w, y + h, radius, radius)
        else:
            gdi32.Rectangle(hdc, x, y, x + w, y + h)
        gdi32.SelectObject(hdc, old_brush)
        gdi32.SelectObject(hdc, old_pen)
        gdi32.DeleteObject(brush)
        gdi32.DeleteObject(pen)

    def dot(self, hdc: int, color, cx: int, cy: int, r: int) -> None:
        brush = gdi32.CreateSolidBrush(rgb(color))
        pen = gdi32.CreatePen(0, 1, rgb(color))
        old_brush = gdi32.SelectObject(hdc, brush)
        old_pen = gdi32.SelectObject(hdc, pen)
        gdi32.Ellipse(hdc, cx - r, cy - r, cx + r, cy + r)
        gdi32.SelectObject(hdc, old_brush)
        gdi32.SelectObject(hdc, old_pen)
        gdi32.DeleteObject(brush)
        gdi32.DeleteObject(pen)

    def hline(self, hdc: int, color, y: int, w: int) -> None:
        pen = gdi32.CreatePen(0, 1, rgb(color))
        old_pen = gdi32.SelectObject(hdc, pen)
        gdi32.MoveToEx(hdc, 0, y, None)
        gdi32.LineTo(hdc, w, y)
        gdi32.SelectObject(hdc, old_pen)
        gdi32.DeleteObject(pen)


_DEBUG_SHOT = os.environ.get("PAI_DEBUG_SHOT", "")


def _save_dc_bmp(dc: int, bmp: int, w: int, h: int) -> None:
    """调试口：PAI_DEBUG_SHOT=path 时把最近一次绘制内容存为 BMP（覆盖写）。"""

    class BMIH(ctypes.Structure):
        _fields_ = [("size", ctypes.c_uint32), ("w", ctypes.c_int32), ("h", ctypes.c_int32),
                    ("planes", ctypes.c_uint16), ("bpp", ctypes.c_uint16),
                    ("compress", ctypes.c_uint32), ("sizeImage", ctypes.c_uint32),
                    ("xppm", ctypes.c_int32), ("yppm", ctypes.c_int32),
                    ("used", ctypes.c_uint32), ("important", ctypes.c_uint32)]

    bmi = BMIH(40, w, -h, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(dc, bmp, 0, h, buf, ctypes.byref(bmi), 0)
    header = (b"BM" + struct.pack("<IHHI", 54 + w * h * 4, 0, 0, 54)
             + struct.pack("<IiiHHIIiiII", 40, w, -h, 1, 32, 0, w * h * 4, 0, 0, 0, 0))
    with open(_DEBUG_SHOT, "wb") as f:
        f.write(header)
        f.write(buf.raw)



class App:
    def __init__(self) -> None:
        self.http_base = os.environ.get("PAI_HTTP_BASE", "http://127.0.0.1:3000")
        self.actor_id = os.environ.get("PAI_ACTOR_ID", "session-mvp-001")
        self.poll_sec = int(os.environ.get("PAI_POLL_SEC", "20") or "20")
        self.start_expanded = os.environ.get("PAI_STATE", "") == "expanded"
        self.expanded = self.start_expanded
        self.breath_on = True
        self.hwnd = 0
        self.entries: list[dict] = []
        self.latest: dict | None = None
        self.online = False
        self.painter = Painter()
        self.ledger: Ledger | None = None

    # ---- 窗口 ----
    def create_window(self) -> None:
        try:  # Per-Monitor DPI
            user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:  # noqa: BLE001
            pass
        hinstance = kernel32.GetModuleHandleW(None)
        wc = WNDCLASSW()
        wc.style = CS_HREDRAW | CS_VREDRAW
        wc.lpfnWndProc = ctypes.cast(wndproc_ref, ctypes.c_void_p)
        wc.hInstance = hinstance
        wc.hCursor = user32.LoadCursorW(None, ctypes.c_void_p(32512))
        wc.hbrBackground = gdi32.CreateSolidBrush(rgb(COLOR_BG))
        wc.lpszClassName = "FootprintFloatingWnd"
        if not user32.RegisterClassW(ctypes.byref(wc)):
            raise OSError("RegisterClassW failed")

        self.hwnd = user32.CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            "FootprintFloatingWnd", "今日足迹", WS_POPUP,
            0, 0, WIDTH, BUBBLE_H, None, None, hinstance, None)
        if not self.hwnd:
            raise OSError("CreateWindowExW failed")

        user32.SetLayeredWindowAttributes(self.hwnd, 0, 244, LWA_ALPHA)
        pref = ctypes.c_int(DWMWCP_ROUND)
        dwmapi.DwmSetWindowAttribute(self.hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                                     ctypes.byref(pref), ctypes.sizeof(pref))
        dpi = user32.GetDpiForWindow(self.hwnd) or 96
        self.painter.set_scale(dpi / 96.0)

        self.ledger = Ledger(self.http_base, self.actor_id, self.poll_sec, self.hwnd)
        self.move_to_corner()
        threading.Thread(target=self.ledger.loop, daemon=True).start()
        user32.SetTimer(self.hwnd, 1, 700, None)  # 呼吸点
        user32.ShowWindow(self.hwnd, SW_SHOW)

    def move_to_corner(self) -> None:
        x0 = os.environ.get("PAI_X", "")
        y0 = os.environ.get("PAI_Y", "")
        if x0 and y0:  # 测试指定位置
            user32.SetWindowPos(self.hwnd, 0, int(x0), int(y0), 0, 0, SWP_NOSIZE)
            return
        area = self.work_area()
        x = area[2] - WIDTH - 16
        y = area[3] - self.current_height() - 16
        user32.SetWindowPos(self.hwnd, 0, x, y, 0, 0, SWP_NOSIZE)

    @staticmethod
    def work_area() -> tuple[int, int, int, int]:
        rect = wt.RECT()
        user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0)
        return rect.left, rect.top, rect.right, rect.bottom

    def current_height(self) -> int:
        if not self.expanded:
            return BUBBLE_H
        n = max(1, min(len(self.entries), MAX_ENTRIES))
        return HEADER_H + n * ENTRY_H + 12

    def apply_size(self) -> None:
        h = self.current_height()
        if self.expanded:  # 展开不越出工作区底边
            left, top, right, bottom = self.work_area()
            rect = wt.RECT()
            user32.GetWindowRect(self.hwnd, ctypes.byref(rect))
            if rect.top + h > bottom - 8:
                user32.SetWindowPos(self.hwnd, 0, rect.left, max(top + 8, bottom - 8 - h),
                                    WIDTH, h, SWP_NOZORDER | SWP_FRAMECHANGED)
            else:
                user32.SetWindowPos(self.hwnd, 0, 0, 0, WIDTH, h,
                                    SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED)
        else:
            user32.SetWindowPos(self.hwnd, 0, 0, 0, WIDTH, h,
                                SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED)
        user32.InvalidateRect(self.hwnd, None, True)

    # ---- 绘制 ----
    def on_paint(self) -> None:
        assert self.ledger is not None
        self.entries, self.latest, self.online = self.ledger.snapshot()
        ps = PAINTSTRUCT()
        hdc = user32.BeginPaint(self.hwnd, ctypes.byref(ps))
        rect = wt.RECT()
        user32.GetClientRect(self.hwnd, ctypes.byref(rect))
        w, h = rect.right, rect.bottom

        mem = gdi32.CreateCompatibleDC(hdc)
        bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
        old_bmp = gdi32.SelectObject(mem, bmp)
        p = self.painter
        p.fill(mem, COLOR_BG, 0, 0, w, h)
        if self.expanded:
            self.draw_expanded(mem, p, w)
        else:
            self.draw_bubble(mem, p, w, h)

        gdi32.BitBlt(hdc, 0, 0, w, h, mem, 0, 0, SRCCOPY)
        gdi32.SelectObject(mem, old_bmp)  # 取消选择后 GetDIBits 才有效
        _save_dc_bmp(mem, bmp, w, h)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem)
        user32.EndPaint(self.hwnd, ctypes.byref(ps))

    def draw_bubble(self, hdc, p: Painter, w: int, h: int) -> None:
        entry = self.latest
        s = p.scale
        if self.online and entry:
            color = STATUS_COLORS.get(entry["status"], STATUS_COLORS["done"])
            p.dot(hdc, color if self.breath_on else blend(color, 0.35),
                  round(13 * s), h // 2, 3)
            cat = CATEGORY_COLORS.get(entry["category"], CATEGORY_COLORS["generic"])
            box = round(24 * s)
            p.fill(hdc, blend(cat, 0.18), round(22 * s), (h - box) // 2, box, box,
                   radius=round(7 * s))
            p.font(hdc, 11, FW_SEMIBOLD)
            p.text(hdc, CATEGORY_GLYPHS.get(entry["category"], "办"),
                   round(22 * s), (h - box) // 2, box, box, cat)
            tx = round(22 * s) + box + round(8 * s)
            p.font(hdc, 12, FW_SEMIBOLD)
            p.text(hdc, entry["title"], tx, 0, w - tx - round(58 * s), h, COLOR_TITLE)
            pw, ph = round(44 * s), round(15 * s)
            p.fill(hdc, blend(color), w - pw - round(10 * s), (h - ph) // 2, pw, ph,
                   radius=ph // 2)
            p.font(hdc, 9, FW_SEMIBOLD)
            p.text(hdc, entry["label"], w - pw - round(10 * s), (h - ph) // 2, pw, ph, color)
        else:
            dot = COLOR_OFFLINE if not self.online else (0x18, 0xD6, 0xF3)
            p.dot(hdc, dot if self.breath_on else blend(dot, 0.35),
                  round(13 * s), h // 2, 3)
            p.font(hdc, 12, FW_SEMIBOLD)
            title = "今日足迹" if self.online else "足迹离线重试中"
            p.text(hdc, title, round(22 * s), 0, w - round(80 * s), h,
                   COLOR_TITLE if self.online else COLOR_OFFLINE)
            if self.online:
                p.font(hdc, 10, FW_NORMAL)
                p.text(hdc, f"{len(self.entries)} 条今日", w - round(74 * s), 0,
                       round(64 * s), h, COLOR_MUTED, right=True)

    def draw_expanded(self, hdc, p: Painter, w: int) -> None:
        s = p.scale
        p.font(hdc, 13, FW_BOLD)
        p.text(hdc, "✨ 今日足迹", round(12 * s), 0, round(120 * s), HEADER_H, COLOR_TITLE)
        p.font(hdc, 10, FW_NORMAL)
        count = f"{len(self.entries)} 条" if self.online else "离线重试中"
        p.text(hdc, count, w - round(56 * s), 0, round(46 * s), HEADER_H,
               COLOR_MUTED if self.online else COLOR_OFFLINE, right=True)
        p.text(hdc, "—", w - round(30 * s), 0, round(20 * s), HEADER_H, COLOR_MUTED)
        p.hline(hdc, COLOR_LINE, HEADER_H, w)

        if not self.entries:
            p.font(hdc, 11, FW_NORMAL)
            msg = "今天还没有足迹" if self.online else "暂时连不上管家服务"
            p.text(hdc, msg, 0, HEADER_H + 24, w, 20, COLOR_MUTED)
            return

        y = HEADER_H + 8
        for e in self.entries[:MAX_ENTRIES]:
            cat = CATEGORY_COLORS.get(e["category"], CATEGORY_COLORS["generic"])
            box = round(26 * s)
            x0 = round(12 * s)
            p.fill(hdc, blend(cat, 0.18), x0, y + 4, box, box, radius=round(8 * s))
            p.font(hdc, 12, FW_SEMIBOLD)
            p.text(hdc, CATEGORY_GLYPHS.get(e["category"], "办"), x0, y + 4, box, box, cat)
            tx = x0 + box + round(9 * s)
            p.font(hdc, 12, FW_NORMAL)
            p.text(hdc, e["title"], tx, y, w - tx - round(12 * s), round(20 * s), COLOR_TEXT)
            color = STATUS_COLORS.get(e["status"], STATUS_COLORS["done"])
            pw, ph = round(44 * s), round(15 * s)
            p.fill(hdc, blend(color), tx, y + round(24 * s), pw, ph, radius=ph // 2)
            p.font(hdc, 9, FW_SEMIBOLD)
            p.text(hdc, e["label"], tx, y + round(24 * s), pw, ph, color)
            lt = time.localtime(e["createdAt"] / 1000)
            p.font(hdc, 10, FW_NORMAL)
            p.text(hdc, f"{lt.tm_hour:02d}:{lt.tm_min:02d}", w - round(14 * s),
                   y + round(24 * s), round(40 * s), ph, COLOR_MUTED, right=True)
            y += ENTRY_H

    # ---- 交互 ----
    def on_lbutton_down(self, lp: int) -> int:
        x, y = lparam_xy(lp)
        if self.expanded and y < HEADER_H:
            rect = wt.RECT()
            user32.GetClientRect(self.hwnd, ctypes.byref(rect))
            if x >= rect.right - round(30 * self.painter.scale):
                self.expanded = False  # 「—」收起
                self.apply_size()
                return 0
        elif not self.expanded:
            self.expanded = True  # 点冒泡展开
            self.apply_size()
            return 0
        user32.ReleaseCapture()
        user32.SendMessageW(self.hwnd, 0xA1, HTCAPTION, 0)  # 其余区域拖动
        return 0

    def on_context_menu(self) -> int:
        menu = user32.CreatePopupMenu()
        user32.AppendMenuW(menu, 0, 2, "收起" if self.expanded else "展开")
        user32.AppendMenuW(menu, 0, 3, "退出")
        pt = wt.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        user32.SetForegroundWindow(self.hwnd)
        cmd = user32.TrackPopupMenu(menu, 0x0180, pt.x, pt.y, 0, self.hwnd, None)
        user32.DestroyMenu(menu)
        if cmd == 2:
            self.expanded = not self.expanded
            self.apply_size()
        elif cmd == 3:
            user32.PostQuitMessage(0)
        return 0


# ---- WndProc（模块级引用，防回调被 GC）----
_app: App | None = None

WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_longlong, ctypes.c_longlong, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t)


@WNDPROC
def wndproc_ref(hwnd, msg, wparam, lparam):
    app = _app
    if app is None:
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)
    if msg == WM_PAINT:
        app.on_paint()
        return 0
    if msg == WM_APP_DATA:
        user32.InvalidateRect(hwnd, None, True)
        return 0
    if msg == WM_TIMER:
        app.breath_on = not app.breath_on
        if not app.expanded:
            user32.InvalidateRect(hwnd, None, False)
        return 0
    if msg == WM_LBUTTONDOWN:
        return app.on_lbutton_down(lparam)
    if msg == WM_RBUTTONUP:
        return app.on_context_menu()
    if msg == WM_DESTROY:
        user32.PostQuitMessage(0)
        return 0
    return user32.DefWindowProcW(hwnd, msg, wparam, lparam)


def main() -> int:
    global _app
    _app = App()
    _app.create_window()
    msg = wt.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))
    return 0


if __name__ == "__main__":
    sys.exit(main())
