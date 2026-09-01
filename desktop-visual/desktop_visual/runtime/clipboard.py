"""剪贴板读写（CF_UNICODETEXT）。

Windows 用 ctypes（零第三方依赖）；macOS/Linux 回退 pbcopy/xclip/xsel
命令行工具；均不可用时 get 返回 None、set 返回 False，调用方自行降级。

剪贴板可能被其他进程短暂锁住，统一带 3 次重试（50ms 间隔）。

Windows ctypes 注意：所有返回 HANDLE/HGLOBAL 的 API 必须显式声明
restype = c_void_p——64 位进程下默认 restype 是 c_int，会把 64 位指针
截断成 32 位导致句柄无效（GlobalAlloc 返回值 >4GB 时必现）。
"""
from __future__ import annotations

import logging
import subprocess
import sys
import time

logger = logging.getLogger(__name__)

_CF_UNICODETEXT = 13
_GMEM_MOVEABLE = 0x0002
_RETRY_TIMES = 3
_RETRY_DELAY_S = 0.05


def get_text() -> str | None:
    """读取剪贴板文本；无文本 / 剪贴板忙 / 平台不支持时返回 None。"""
    for _ in range(_RETRY_TIMES):
        try:
            if sys.platform == "win32":
                return _get_text_win32()
            if sys.platform == "darwin":
                out = subprocess.run(["pbpaste"], capture_output=True, timeout=2)  # noqa: S603
                return out.stdout.decode("utf-8", errors="replace") if out.returncode == 0 else None
            for cmd in (["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]):
                try:
                    out = subprocess.run(cmd, capture_output=True, timeout=2)  # noqa: S603
                    if out.returncode == 0:
                        return out.stdout.decode("utf-8", errors="replace")
                except FileNotFoundError:
                    continue
            return None
        except Exception as exc:
            logger.debug("读取剪贴板失败（重试）: %s", exc)
            time.sleep(_RETRY_DELAY_S)
    return None


def set_text(text: str) -> bool:
    """写入剪贴板文本；成功返回 True。"""
    for _ in range(_RETRY_TIMES):
        try:
            if sys.platform == "win32":
                return _set_text_win32(text)
            if sys.platform == "darwin":
                out = subprocess.run(["pbcopy"], input=text.encode("utf-8"), timeout=2)  # noqa: S603
                return out.returncode == 0
            for cmd in (["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
                try:
                    out = subprocess.run(cmd, input=text.encode("utf-8"), timeout=2)  # noqa: S603
                    if out.returncode == 0:
                        return True
                except FileNotFoundError:
                    continue
            return False
        except Exception as exc:
            logger.debug("写入剪贴板失败（重试）: %s", exc)
            time.sleep(_RETRY_DELAY_S)
    return False


# ---- Windows ctypes 实现 ----

def _win32_libs():
    """加载 user32/kernel32 并显式声明句柄相关签名（见模块 docstring）。"""
    import ctypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    user32.OpenClipboard.restype = ctypes.c_bool
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.CloseClipboard.restype = ctypes.c_bool
    user32.CloseClipboard.argtypes = []
    user32.EmptyClipboard.restype = ctypes.c_bool
    user32.EmptyClipboard.argtypes = []
    user32.GetClipboardData.restype = ctypes.c_void_p
    user32.GetClipboardData.argtypes = [ctypes.c_uint]
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.restype = ctypes.c_bool
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalFree.restype = ctypes.c_void_p
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
    return user32, kernel32


def _get_text_win32() -> str | None:
    user32, kernel32 = _win32_libs()
    if not user32.OpenClipboard(None):
        raise OSError("OpenClipboard 失败（被其他进程占用）")
    try:
        handle = user32.GetClipboardData(_CF_UNICODETEXT)
        if not handle:
            return None
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return None
        try:
            import ctypes

            return ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def _set_text_win32(text: str) -> bool:
    import ctypes

    user32, kernel32 = _win32_libs()
    if not user32.OpenClipboard(None):
        raise OSError("OpenClipboard 失败（被其他进程占用）")
    try:
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        handle = kernel32.GlobalAlloc(_GMEM_MOVEABLE, len(data))
        if not handle:
            return False
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            kernel32.GlobalFree(handle)
            return False
        try:
            ctypes.memmove(ptr, data, len(data))
        finally:
            kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(_CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)
            return False
        return True  # 成功后所有权归系统，不再 GlobalFree
    finally:
        user32.CloseClipboard()
