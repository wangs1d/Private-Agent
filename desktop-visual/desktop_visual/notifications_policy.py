"""系统通知勿扰（set_dnd action 的实现）。

Best-effort 实现：写注册表主开关 NOC_GLOBAL_SETTING_TOASTS_ENABLED
（HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings），
控制所有应用的 toast 弹窗。开启前把原值记到临时状态文件，关闭时恢复——
即使 Python 进程重启，恢复依然成立。

这是「尽力而为」：不同 Windows 版本对该键的即时生效程度不同；写失败时
返回 ok=False 让上层如实告知用户，绝不谎报成功。
"""
from __future__ import annotations

import json
import logging
import tempfile
from pathlib import Path

_IS_WINDOWS = __import__("platform").system() == "Windows"

DND_REGISTRY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings"
DND_VALUE_NAME = "NOC_GLOBAL_SETTING_TOASTS_ENABLED"

STATE_FILE = Path(tempfile.gettempdir()) / "desktop_visual_dnd_state.json"

VALID_OPS = ("enable", "disable", "query")


def _read_toasts_enabled() -> int | None:
    """读当前 toast 主开关（1=开 0=关）；读不到返回 None。"""
    if not _IS_WINDOWS:
        return None
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, DND_REGISTRY_PATH, 0, winreg.KEY_QUERY_VALUE
        ) as key:
            value, _type = winreg.QueryValueEx(key, DND_VALUE_NAME)
            return int(value)
    except FileNotFoundError:
        # 键不存在时 Windows 默认视为开启
        return 1
    except Exception as exc:
        logging.debug("读取通知开关失败: %s", exc)
        return None


def _write_toasts_enabled(value: int) -> bool:
    if not _IS_WINDOWS:
        return False
    try:
        import winreg

        with winreg.CreateKeyEx(
            winreg.HKEY_CURRENT_USER, DND_REGISTRY_PATH, 0, winreg.KEY_SET_VALUE
        ) as key:
            winreg.SetValueEx(key, DND_VALUE_NAME, 0, winreg.REG_DWORD, int(value))
        return True
    except Exception as exc:
        logging.warning("写入通知开关失败: %s", exc)
        return False


def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(state: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
    except Exception as exc:
        logging.debug("保存勿扰状态文件失败: %s", exc)


def _clear_state() -> None:
    try:
        STATE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def set_dnd(op: str) -> dict:
    """set_dnd action 主入口。

    op=enable：关掉 toast 通知（记录原值供恢复）
    op=disable：恢复原值（无记录时默认恢复为 1=开）
    op=query：只查当前状态
    """
    if op not in VALID_OPS:
        return {"ok": False, "error": f"dndOp 必须是 {'/'.join(VALID_OPS)}，收到 {op!r}"}

    current = _read_toasts_enabled()
    if op == "query":
        if current is None:
            return {"ok": False, "op": op, "error": "无法读取系统通知状态（仅支持 Windows）"}
        return {"ok": True, "op": op, "enabled": current == 1}

    if current is None:
        return {"ok": False, "op": op, "error": "勿扰开关仅支持 Windows（注册表不可用）"}

    if op == "enable":
        state = _load_state()
        if current == 0:
            # 已是静音状态：不覆盖已有恢复记录
            return {"ok": True, "op": op, "enabled": True, "previous": state.get("previous"), "already": True}
        if not _write_toasts_enabled(0):
            return {"ok": False, "op": op, "error": "写入系统通知开关失败（权限或策略限制）"}
        # 只记录第一次开启时的原值；重复 enable 不覆盖
        if state.get("previous") is None:
            state["previous"] = current
            _save_state(state)
        return {"ok": True, "op": op, "enabled": True, "previous": current}

    # disable：恢复原值
    state = _load_state()
    previous = state.get("previous")
    restore = int(previous) if isinstance(previous, (int, float)) and 0 <= previous <= 1 else 1
    if current == restore:
        _clear_state()
        return {"ok": True, "op": op, "enabled": current == 1, "already": True}
    if not _write_toasts_enabled(restore):
        return {"ok": False, "op": op, "error": "恢复系统通知开关失败（权限或策略限制）"}
    _clear_state()
    return {"ok": True, "op": op, "enabled": restore == 1, "previous": previous}
