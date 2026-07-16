"""测试 run_automation 在记事本上工作。
全程零鼠标、零截图:open → run_automation(set_value) → get_value 验证。
"""
import sys
import os
import json
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from desktop_visual.stdio_worker import _handle_open, _handle_run_automation, _handle_uia_query


def dump(name, r):
    s = json.dumps(r, ensure_ascii=False, indent=2, default=str)
    print(f"\n--- {name} ---\n{s[:2000]}")


def main():
    # Step 1: 打开记事本(标准 Win32,UIA 完全支持)
    print("=" * 60)
    print("Step 1: 打开记事本")
    print("=" * 60)
    r = _handle_open({"target": "app", "path": "notepad.exe"})
    dump("open", r)
    if not r.get("ok"):
        print("[FAIL] 打开失败")
        return
    print("[OK] 记事本窗口已出现")
    time.sleep(1)

    # Step 2: 用 UIA 探查窗口(用 Notepad 匹配,英文系统标题是 "无标题 - Notepad")
    print("\n" + "=" * 60)
    print("Step 2: UIA 查记事本窗口 + Edit 控件")
    print("=" * 60)
    r = _handle_uia_query({
        "mode": "query",
        "selector": {"name_contains": "Notepad", "control_type": "Window"},
        "topOnly": True, "limit": 3,
    })
    dump("uia window", r)
    win_count = r.get("count", 0)
    if win_count == 0:
        print("[INFO] UIA 按窗口名未命中,继续直接测 Edit 控件(topOnly=False 递归)")

    # Step 3: 用 run_automation set_value 直接设置 Edit 内容(零鼠标!)
    print("\n" + "=" * 60)
    print("Step 3: run_automation set_value('仙逆 第1集 测试')")
    print("=" * 60)
    # 注意 topOnly=False 因为 Edit 是 Window 的子控件
    # 先试 index=0,失败再试 index=1(Win11 记事本第一个 Edit 是搜索框,第二个是文本区)
    for idx in [0, 1]:
        r = _handle_run_automation({
            "action_name": "set_value",
            "selector": {"control_type": "Edit"},
            "value": f"仙逆 第1集 测试 (index={idx}) - run_automation 原生控件操作成功",
            "topOnly": False,
            "index": idx,
        })
        dump(f"run_automation set_value index={idx}", r)
        if r.get("ok"):
            print(f"[OK] set_value 成功! index={idx} matchedCount={r.get('matchedCount')}")
            print(f"     matchedElement: bbox={r['matchedElement'].get('bbox')}, patterns={r['matchedElement'].get('patterns')}")
            break
        print(f"[INFO] index={idx} 失败,试下一个")
    else:
        print("[FAIL] 所有 Edit 都不支持 set_value(Win11 记事本是 WinUI 3,非标准 Win32 Edit)")
        return

    # Step 4: get_value 读回来验证
    print("\n" + "=" * 60)
    print("Step 4: run_automation get_value 验证内容")
    print("=" * 60)
    r = _handle_run_automation({
        "action_name": "get_value",
        "selector": {"control_type": "Edit"},
        "topOnly": False,
    })
    dump("run_automation get_value", r)
    if not r.get("ok"):
        print("[FAIL] get_value 失败")
        return
    val = r.get("value", "")
    print(f"\n[OK] 读回内容:\n{val}")
    if "仙逆" in (val or ""):
        print("\n✅ 验证通过:run_automation set_value 成功写入,全程零鼠标零键盘")
    else:
        print("\n⚠ 内容不匹配")


if __name__ == "__main__":
    main()
