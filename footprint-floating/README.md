# 今日足迹悬浮窗（footprint-floating）

独立的纯 Win32 原生桌面悬浮窗：实时展示主动性模块在后台**代办/盯梢**的结果。
与桌宠（`sphere-overlay-py`）完全无关——单独进程、单独托盘逻辑、单独停靠位，
也不依赖任何 Python 第三方库（仅标准库 ctypes + urllib）。

## 启动

```powershell
# 默认连 http://127.0.0.1:3000、actorId=session-mvp-001
powershell -File start-footprint.ps1

# 自定义
$env:PAI_HTTP_BASE = "http://127.0.0.1:3000"
$env:PAI_ACTOR_ID  = "你的USER_ID"   # 必须与主应用 USER_ID 一致，否则查不到台账
python footprint_win32.py
```

## 交互

| 操作 | 行为 |
| --- | --- |
| 常驻冒泡（右下角） | 显示最新一条代办：类别字标 + 标题 + 状态 pill + 呼吸点 |
| 点击冒泡 | 展开今日足迹列表（最多 6 条） |
| 点标题栏「—」 | 收起回冒泡 |
| 按住拖动 / 右键 | 移动位置 / 展开收起与退出菜单 |

数据每 `PAI_POLL_SEC`（默认 20s）轮询一次 `GET /agent/activities`；状态色与
主应用「代办足迹」卡同源：pending 青 `#18D6F3` / done 绿 `#1ED7A6` /
changed 琥珀 `#D7B85A` / failed 红 `#FF9D9D`（告知类固定显示「已告知」）。
已读/未读语义归主应用面板，本悬浮窗不置已读。
