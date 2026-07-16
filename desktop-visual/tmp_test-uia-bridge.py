"""直接测试 _handle_uia_query,模拟 bridge 调用。"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json
from desktop_visual.stdio_worker import _handle_uia_query

# 测试 1: query 模式 - 查找微信窗口
print("=== Test 1: query mode ===")
result = _handle_uia_query({
    "mode": "query",
    "selector": {"name_contains": "微信", "control_type": "Window"},
    "topOnly": True,
    "limit": 100,
})
print(json.dumps(result, ensure_ascii=False, indent=2, default=str)[:2000])

# 测试 2: read_children 模式 - 读取微信窗口子控件
print("\n=== Test 2: read_children mode ===")
result2 = _handle_uia_query({
    "mode": "read_children",
    "selector": {"name_contains": "微信", "control_type": "Window"},
    "limit": 50,
})
print(json.dumps(result2, ensure_ascii=False, indent=2, default=str)[:3000])

# 测试 3: query 模式 - 用 name 精确匹配
print("\n=== Test 3: query with exact name ===")
result3 = _handle_uia_query({
    "mode": "query",
    "selector": {"name": "微信", "control_type": "Window"},
    "topOnly": True,
    "limit": 10,
})
print(json.dumps(result3, ensure_ascii=False, indent=2, default=str)[:2000])
