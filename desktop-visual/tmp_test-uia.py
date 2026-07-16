"""快速诊断 uia_query 查询微信窗口的实际结果。"""
import sys
sys.path.insert(0, r"E:\ws-project\Private-Agent\desktop-visual")
from desktop_visual.runtime.uia_controller import get_uia_controller

ctrl = get_uia_controller()
print("UIA available:", ctrl.is_available())
if not ctrl.is_available():
    sys.exit(1)

# 1. 查所有顶层 Window
elements = ctrl.query({}, top_only=True, limit=80)
print(f"\n=== Top-level windows: {len(elements)} ===")
wechat_found = []
for e in elements:
    name = e.get("name", "")
    ct = e.get("control_type", "")
    cls = e.get("class_name", "")
    if "微信" in name or "WeChat" in name or "Weixin" in name or "wechat" in name.lower():
        wechat_found.append(e)
        print(f"  [MATCH] name={name!r} type={ct} class={cls} bbox={e.get('bbox')} patterns={e.get('patterns')}")

if not wechat_found:
    print("\n--- 微信窗口未找到,打印前 15 个窗口 ---")
    for e in elements[:15]:
        print(f"  name={e.get('name','')!r} type={e.get('control_type','')} class={e.get('class_name','')}")

# 2. 用 selector {name:"微信", control_type:"Window"} 查询(复现 LLM 的查询)
print("\n=== Query {name:'微信', control_type:'Window'} ===")
r1 = ctrl.query({"name": "微信", "control_type": "Window"}, top_only=True, limit=10)
print(f"count={len(r1)}")
for e in r1:
    print(f"  name={e.get('name','')!r} type={e.get('control_type','')} bbox={e.get('bbox')}")

# 3. 用 name_contains 查询(如果支持)
print("\n=== Query {name_contains:'微信'} ===")
r2 = ctrl.query({"name_contains": "微信"}, top_only=True, limit=10)
print(f"count={len(r2)}")
for e in r2:
    print(f"  name={e.get('name','')!r} type={e.get('control_type','')} bbox={e.get('bbox')}")

# 4. 如果找到微信窗口,读它的子控件
if wechat_found:
    parent = wechat_found[0]
    print(f"\n=== read_children of {parent.get('name','')!r} ===")
    children = ctrl.read_children(parent.get("__ref"), limit=30)
    print(f"children count={len(children)}")
    for c in children:
        print(f"  name={c.get('name','')!r} type={c.get('control_type','')} class={c.get('class_name','')} bbox={c.get('bbox')} patterns={c.get('patterns')}")
