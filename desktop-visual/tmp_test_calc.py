"""验证 run_automation click(InvokePattern) 在计算器上工作。
计算器按钮通常支持 InvokePattern。
"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from desktop_visual.stdio_worker import _handle_open, _handle_run_automation, _handle_uia_query

def dump(name, r):
    print(f"\n--- {name} ---\n{json.dumps(r, ensure_ascii=False, indent=2, default=str)[:1800]}")

print("=" * 60)
print("Step 1: 打开计算器")
print("=" * 60)
r = _handle_open({"target": "app", "path": "calc.exe"})
dump("open", r)
if not r.get("ok"):
    # Win11 计算器可能不是 calc.exe
    r = _handle_open({"target": "app", "path": "计算器"})
    dump("open fallback", r)
    if not r.get("ok"):
        print("[FAIL] 打不开计算器")
        sys.exit(1)
time.sleep(2)

print("\n" + "=" * 60)
print("Step 2: UIA 查计算器按钮(支持 Invoke 的)")
print("=" * 60)
# Win11 计算器是 WinUI 3,但按钮可能支持 InvokePattern
r = _handle_uia_query({
    "mode": "query",
    "selector": {"control_type": "Button"},
    "topOnly": False,
    "limit": 20,
})
dump("uia buttons", r)
btn_count = r.get("count", 0)
if btn_count == 0:
    print("[FAIL] UIA 读不到计算器按钮(WinUI 3 可能也不支持)")
    sys.exit(1)

# 找支持 Invoke 的按钮
buttons = r.get("elements", [])
invoke_btn = None
for b in buttons:
    if "Invoke" in (b.get("patterns") or []):
        invoke_btn = b
        break
if not invoke_btn:
    # 没标 Invoke 但可能有,直接试第一个
    invoke_btn = buttons[0]
    print(f"[INFO] 没有标记 Invoke 的按钮,试第一个: name={invoke_btn.get('name')!r}")

print(f"\n选定按钮: name={invoke_btn.get('name')!r} bbox={invoke_btn.get('bbox')} patterns={invoke_btn.get('patterns')}")

print("\n" + "=" * 60)
print(f"Step 3: run_automation click 按钮 {invoke_btn.get('name')!r}")
print("=" * 60)
# 用 name 精确匹配
btn_name = invoke_btn.get("name", "")
r = _handle_run_automation({
    "action_name": "click",
    "selector": {"name": btn_name, "control_type": "Button"},
    "topOnly": False,
})
dump("run_automation click", r)
if r.get("ok"):
    print(f"\n✅ InvokePattern click 成功! 按钮={btn_name!r} 不抢鼠标不模拟键盘")
else:
    print(f"\n[FAIL] click 失败: {r.get('error')}")
