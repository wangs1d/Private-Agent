"""端到端测试：打开腾讯视频 → 搜索仙逆 → 播放。
直接调用 desktop_visual 内部 handler,绕过 server/LLM。
"""
import sys
import os
import json
import asyncio
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from desktop_visual.stdio_worker import (
    _handle_open, _handle_uia_query, _handle_run_input, _handle_screenshot
)


def banner(title: str):
    print(f"\n{'=' * 60}\n{title}\n{'=' * 60}")


def dump(name: str, result):
    print(f"\n--- {name} ---")
    s = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    print(s[:2500])


def save_screenshot(b64: str, name: str) -> str:
    import base64
    out = os.path.join(os.path.dirname(__file__), f"tmp_{name}.png")
    with open(out, "wb") as f:
        f.write(base64.b64decode(b64))
    return out


def click_and_type(x: int, y: int, text: str, desc: str):
    """点击坐标 → 清空 → 输入文本。"""
    banner(f"{desc}: 点击 ({x},{y})")
    r = _handle_run_input({"action": "click", "x": x, "y": y, "button": "left"})
    dump("click", r)
    if not r.get("ok"):
        return False
    time.sleep(0.6)
    # 全选清空(防止有默认文本)
    banner(f"{desc}: 全选清空")
    r = _handle_run_input({"action": "shortcut", "keys": "ctrl+a"})
    dump("ctrl+a", r)
    time.sleep(0.2)
    _handle_run_input({"action": "key", "key": "delete"})
    time.sleep(0.2)
    # 输入
    banner(f"{desc}: 输入 {text!r}")
    r = _handle_run_input({"action": "type", "text": text, "interval": 0.05})
    dump("type", r)
    if not r.get("ok"):
        return False
    time.sleep(0.5)
    return True


def main():
    # ===== Step 1: 打开腾讯视频 =====
    banner("Step 1: desktop.open 腾讯视频")
    r = _handle_open({"target": "app", "path": "腾讯视频"})
    dump("open", r)
    if not r.get("ok"):
        print("[FAIL] 打开失败,终止")
        return
    print(f"[OK] windowVerified={r.get('windowVerified')}")
    # 等应用完全加载(腾讯视频启动慢,给 5s)
    print("[等待 5s 让腾讯视频完全加载...]")
    time.sleep(5)

    # ===== Step 2: UIA 查询(验证 pywinauto 是否工作 + 能否读控件) =====
    banner("Step 2: UIA 查腾讯视频窗口")
    r = _handle_uia_query({
        "mode": "query",
        "selector": {"name_contains": "腾讯视频", "control_type": "Window"},
        "topOnly": True, "limit": 5,
    })
    dump("uia_query window", r)
    win_count = r.get("count", 0)
    if win_count > 0:
        # 读子控件看能否定位搜索框
        r2 = _handle_uia_query({
            "mode": "read_children",
            "selector": {"name_contains": "腾讯视频", "control_type": "Window"},
            "limit": 50,
        })
        dump("uia read_children", r2)

    # ===== Step 3: 截图看当前界面 =====
    banner("Step 3: 截图(打开后主界面)")
    r = asyncio.run(_handle_screenshot({}))
    if r.get("ok"):
        path = save_screenshot(r["imageBase64"], "qqlive_main")
        print(f"[OK] 截图: {path} ({r['width']}x{r['height']})")
    else:
        dump("screenshot fail", r)

    # ===== Step 4: 点击搜索框 =====
    # 腾讯视频主界面:顶部导航栏右侧有搜索框
    # 1920x1080 经验坐标:搜索框中心约 (1350, 65)
    # 若不对,后续截图会显示没聚焦,再调整
    banner("Step 4: 点击搜索框 (经验坐标 1350,65)")
    if not click_and_type(1350, 65, "仙逆", "搜索框"):
        print("[FAIL] 搜索框操作失败")
        # 截图看实际情况
        r = asyncio.run(_handle_screenshot({}))
        if r.get("ok"):
            save_screenshot(r["imageBase64"], "qqlive_after_fail")
        return

    # ===== Step 5: 回车搜索 =====
    banner("Step 5: 回车搜索")
    r = _handle_run_input({"action": "key", "key": "enter"})
    dump("enter", r)
    # 等搜索结果加载
    print("[等待 3s 搜索结果加载...]")
    time.sleep(3)

    # ===== Step 6: 截图看搜索结果 =====
    banner("Step 6: 截图(搜索结果页)")
    r = asyncio.run(_handle_screenshot({}))
    if r.get("ok"):
        path = save_screenshot(r["imageBase64"], "qqlive_search_result")
        print(f"[OK] 截图: {path}")

    # ===== Step 7: 点击仙逆搜索结果 =====
    # 搜索结果页:第一个卡片是 ZHANSHEN(斩神),仙逆在第二个位置(右侧)
    # 仙逆卡片约在 (1100, 300)
    banner("Step 7: 点击仙逆搜索结果 (坐标 1100,300)")
    r = _handle_run_input({"action": "click", "x": 1100, "y": 300, "button": "left"})
    dump("click result", r)
    if not r.get("ok"):
        return
    # 等播放页加载
    print("[等待 5s 播放页加载...]")
    time.sleep(5)

    # ===== Step 8: 截图看是否进入播放页 =====
    banner("Step 8: 截图(播放页)")
    r = asyncio.run(_handle_screenshot({}))
    if r.get("ok"):
        path = save_screenshot(r["imageBase64"], "qqlive_playing")
        print(f"[OK] 截图: {path}")
        print("\n[完成] 请查看 tmp_qqlive_playing.png 确认是否正在播放仙逆")


if __name__ == "__main__":
    main()
