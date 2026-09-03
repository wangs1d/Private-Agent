"""
桌面端事件订阅模块：通过 SetWinEventHook 监听多种桌面事件，
并通过 bridge_ws_client.send_event 主动推送到 server。

订阅的事件类型
--------------
- EVENT_SYSTEM_FOREGROUND (0x0003) → focus_change（Task 2：窗口焦点变化）
- EVENT_OBJECT_CREATE (0x8000)     → window_open  （Task 3：新窗口打开）
- EVENT_OBJECT_DESTROY (0x8001)    → window_close （Task 3：窗口关闭）

设计要点
--------
- 用 ctypes 实现 SetWinEventHook（无额外依赖；pywin32 可能未安装）
- 三种事件共享同一条「消息循环线程」，减少线程开销（WinEvent OUTOFCONTEXT
  机制允许在同一线程注册多个 hook，回调均在该线程消息循环中触发）
- 窗口打开事件的 ControlType 通过 pywinauto/comtypes 的 UIA ElementFromHandle
  获取（若环境已装 pywinauto，降级返回 "Window"）
- send_event 线程安全（内部 run_coroutine_threadsafe），可在回调线程直接调用
- 节流：focus_change 同 (title, process) 5s 内不重复；window_open 同 pid 10s 内不重复
- 非 Windows 平台：模块可正常导入，start_* 直接返回 False

集成入口
--------
- bridge_ws_client.main() 启动时调用 start_focus_listener() / start_window_listener()
- bridge 退出时调用 stop_focus_listener() / stop_window_listener()

消息格式（与 send_event 协议一致）
---------------------------------
    {
        "type": "desktop.event",
        "event_type": "focus_change" | "window_open" | "window_close",
        "payload": { "title": ..., "process": ..., ... },
        "timestamp": <epoch seconds>
    }
"""
from __future__ import annotations

import ctypes
import logging
import threading
import time
from ctypes import wintypes

# 仅 Windows 下 ctypes.windll 存在；非 Windows 模块仍可导入但 start 返回 False
_IS_WINDOWS = hasattr(ctypes, "windll")

if _IS_WINDOWS:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    ole32 = ctypes.windll.ole32
else:
    user32 = None  # type: ignore[assignment]
    kernel32 = None  # type: ignore[assignment]
    ole32 = None  # type: ignore[assignment]

# ============================================================
# WinEvent / 窗口消息常量
# ============================================================
EVENT_SYSTEM_FOREGROUND = 0x0003  # 前台窗口切换（focus_change）
EVENT_OBJECT_CREATE = 0x8000      # 对象创建（window_open）
EVENT_OBJECT_DESTROY = 0x8001     # 对象销毁（window_close）

WINEVENT_OUTOFCONTEXT = 0x0000   # 回调在调用方线程消息循环中触发（不需 DLL 注入）
OBJID_WINDOW = 0                  # 仅处理窗口本身的事件，忽略子对象

# OpenProcess 访问权限（QueryFullProcessImageNameW 仅需 LIMITED_INFORMATION，
# 比 GetModuleBaseNameW 更宽松——后者需 PROCESS_VM_READ，对高权限进程会失败）
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

# 消息循环退出消息
WM_QUIT = 0x0012

# COM 初始化标志（STA，消息循环线程已有 message pump）
COINIT_APARTMENTTHREADED = 0x2

# 节流窗口（秒）
FOCUS_THROTTLE_SECONDS = 5.0          # focus_change：同 (title, process) 5s
WINDOW_OPEN_THROTTLE_SECONDS = 10.0   # window_open：同 pid 10s

# WinEventProc 回调函数类型
# HRESULT 在 OUTOFCONTEXT 模式下不需要；签名按官方文档
WinEventProcType = ctypes.WINFUNCTYPE(
    None,
    wintypes.HANDLE,  # hWinEventHook
    wintypes.DWORD,   # event
    wintypes.HWND,    # hwnd
    wintypes.LONG,    # idObject
    wintypes.LONG,    # idChild
    wintypes.DWORD,   # dwEventThread
    wintypes.DWORD,   # dwmsEventTime
)

_signatures_set = False


def _setup_signatures() -> None:
    """为 ctypes 调用设置 argtypes/restype，避免 64 位下默认 c_int 截断指针。"""
    global _signatures_set
    if _signatures_set or not _IS_WINDOWS:
        return
    _signatures_set = True

    user32.SetWinEventHook.argtypes = [
        wintypes.DWORD,        # eventMin
        wintypes.DWORD,        # eventMax
        wintypes.HMODULE,      # hmodWinEventProc（OUTOFCONTEXT 时为 0）
        WinEventProcType,      # pfnWinEventProc
        wintypes.DWORD,        # idProcess（0=所有进程）
        wintypes.DWORD,        # idThread（0=所有线程）
        wintypes.DWORD,        # dwFlags
    ]
    user32.SetWinEventHook.restype = ctypes.c_void_p  # HWINEVENTHOOK

    user32.UnhookWinEvent.argtypes = [ctypes.c_void_p]
    user32.UnhookWinEvent.restype = wintypes.BOOL

    user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD

    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = wintypes.INT

    user32.GetWindowTextW.argtypes = [
        wintypes.HWND,
        wintypes.LPWSTR,
        wintypes.INT,
    ]
    user32.GetWindowTextW.restype = wintypes.INT

    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL

    user32.GetForegroundWindow.argtypes = []
    user32.GetForegroundWindow.restype = wintypes.HWND

    user32.GetMessageW.argtypes = [
        ctypes.POINTER(wintypes.MSG),
        wintypes.HWND,
        wintypes.UINT,
        wintypes.UINT,
    ]
    user32.GetMessageW.restype = wintypes.LONG  # -1=错误, 0=WM_QUIT, >0=正常

    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.TranslateMessage.restype = wintypes.BOOL

    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.restype = wintypes.LPARAM

    user32.PostThreadMessageW.argtypes = [
        wintypes.DWORD,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.PostThreadMessageW.restype = wintypes.BOOL

    kernel32.OpenProcess.argtypes = [
        wintypes.DWORD,
        wintypes.BOOL,
        wintypes.DWORD,
    ]
    kernel32.OpenProcess.restype = wintypes.HANDLE

    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    kernel32.GetCurrentThreadId.argtypes = []
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD

    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL

    ole32.CoInitializeEx.argtypes = [wintypes.LPVOID, wintypes.DWORD]
    ole32.CoInitializeEx.restype = ctypes.HRESULT


# ============================================================
# 模块级状态
# ============================================================
_state_lock = threading.Lock()
_state: dict = {
    "thread": None,         # 消息循环线程
    "thread_id": 0,         # 消息循环线程 ID（供 PostThreadMessageW 终止）
    "hooks": [],            # SetWinEventHook 返回的句柄列表（多事件共享回调）
    "callback_ref": None,   # 保持对回调的引用，防 GC 回收导致崩溃
    "running": False,
    "focus_active": False,  # focus_change 订阅是否激活（控制回调是否处理+是否保活线程）
    "window_active": False, # window_open/close 订阅是否激活
}

# focus_change 节流表：{ (title, process): last_send_epoch }
_focus_throttle_lock = threading.Lock()
_focus_throttle: dict[tuple[str, str], float] = {}

# window_open 节流表：{ pid: last_send_epoch }
_window_open_throttle_lock = threading.Lock()
_window_open_throttle: dict[int, float] = {}


# ============================================================
# UIA ControlType 查询（可选增强，懒加载）
# ============================================================
_uia_lock = threading.Lock()
_uia_singleton = None       # pywinauto.uia_defines.IUIA().iuia（IUIAutomation COM 接口）
_uia_control_type_map: dict[int, str] = {}  # {control_type_id: name}
_uia_init_attempted = False


def _init_uia_for_controltype() -> bool:
    """懒加载 UIA（用于 window_open 的 ControlType 查询）。

    通过 pywinauto.uia_defines.IUIA 获取 IUIAutomation 单例（comtypes 包装）。
    需在消息循环线程调用（COM 需线程内初始化）。失败返回 False，调用方降级为 "Window"。
    """
    global _uia_singleton, _uia_control_type_map, _uia_init_attempted
    if _uia_init_attempted:
        return _uia_singleton is not None
    with _uia_lock:
        if _uia_init_attempted:
            return _uia_singleton is not None
        _uia_init_attempted = True
        try:
            # COM 初始化（消息循环线程，STA 保证 UIA 跨套间调用可靠；
            # 已初始化时返回 S_FALSE，RPC_E_CHANGED_MODE 说明其他套间已存在，均可忽略）
            ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            from pywinauto.uia_defines import IUIA  # type: ignore[import-not-found]

            singleton = IUIA()
            _uia_singleton = singleton.iuia
            _uia_control_type_map = dict(singleton.known_control_type_ids)
            logging.info("UIA ControlType 查询已就绪 (%d 类型)", len(_uia_control_type_map))
        except Exception as exc:
            logging.debug("UIA 不可用，ControlType 将降级为 'Window': %s", exc)
    return _uia_singleton is not None


def _get_control_type(hwnd: int) -> str:
    """通过 UIA ElementFromHandle 获取窗口的 ControlType。失败返回 'Window'。"""
    if not _init_uia_for_controltype():
        return "Window"
    try:
        elem = _uia_singleton.ElementFromHandle(hwnd)
        if elem is None:
            return "Window"
        ct_id = int(elem.CurrentControlType)
        return _uia_control_type_map.get(ct_id, "Window")
    except Exception:
        return "Window"


# ============================================================
# 信息提取
# ============================================================
def _get_window_title(hwnd: int) -> str:
    """GetWindowTextW 取窗口标题。"""
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def _get_window_pid(hwnd: int) -> int:
    """GetWindowThreadProcessId 取窗口所属进程 PID。失败返回 0。"""
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def _get_process_name(pid: int) -> str:
    """取进程名：优先 psutil（若环境已装），降级 QueryFullProcessImageNameW 取 basename。"""
    # 优先 psutil（不在 requirements.txt，但环境可能已装；导入失败即降级）
    try:
        import psutil  # type: ignore

        return psutil.Process(pid).name()
    except Exception:
        pass

    # 降级：QueryFullProcessImageNameW → 取 basename
    if not kernel32:
        return ""
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(260)
        buf = ctypes.create_unicode_buffer(size.value)
        ok = kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size))
        if not ok:
            return ""
        full = buf.value
        # basename：Windows 路径用 \\，但也容错 /
        if "\\" in full:
            return full.rsplit("\\", 1)[-1]
        if "/" in full:
            return full.rsplit("/", 1)[-1]
        return full
    finally:
        kernel32.CloseHandle(handle)


# ============================================================
# 节流
# ============================================================
def _should_send_focus(title: str, process: str) -> bool:
    """focus_change 节流：同 (title, process) 5s 内不重复发送。

    顺手清理过期项，避免长期累积（节流表只增不减会泄漏）。
    """
    key = (title, process)
    now = time.time()
    with _focus_throttle_lock:
        if len(_focus_throttle) > 200:
            for k in list(_focus_throttle.keys()):
                if now - _focus_throttle[k] > FOCUS_THROTTLE_SECONDS:
                    del _focus_throttle[k]
        last = _focus_throttle.get(key)
        if last is not None and now - last < FOCUS_THROTTLE_SECONDS:
            return False
        _focus_throttle[key] = now
        return True


def _should_send_window_open(pid: int) -> bool:
    """window_open 节流：同 pid 10s 内不重复发送（同进程多窗口不重复推）。"""
    now = time.time()
    with _window_open_throttle_lock:
        if len(_window_open_throttle) > 200:
            for k in list(_window_open_throttle.keys()):
                if now - _window_open_throttle[k] > WINDOW_OPEN_THROTTLE_SECONDS:
                    del _window_open_throttle[k]
        last = _window_open_throttle.get(pid)
        if last is not None and now - last < WINDOW_OPEN_THROTTLE_SECONDS:
            return False
        _window_open_throttle[pid] = now
        return True


# ============================================================
# WinEvent 回调（在消息循环线程中触发）
# ============================================================
def _win_event_callback(
    hWinEventHook,
    event,
    hwnd,
    idObject,
    idChild,
    dwEventThread,
    dwmsEventTime,
):
    """WinEvent 回调：按 event 类型分派到 focus_change / window_open / window_close。"""
    try:
        # 仅处理窗口本身的事件（忽略子对象/控件层事件）
        if idObject != OBJID_WINDOW:
            return
        if not hwnd:
            return

        if event == EVENT_SYSTEM_FOREGROUND:
            _handle_focus_change(hwnd)
        elif event == EVENT_OBJECT_CREATE:
            _handle_window_open(hwnd)
        elif event == EVENT_OBJECT_DESTROY:
            _handle_window_close(hwnd)
    except Exception as e:
        logging.warning("WinEvent 回调处理失败 (event=0x%04X): %s", event, e)


def _handle_focus_change(hwnd: int) -> None:
    """处理前台窗口切换事件 → focus_change。"""
    # 读取订阅状态（布尔读取原子，无需锁；最坏多处理一个事件）
    if not _state.get("focus_active"):
        return
    title = _get_window_title(hwnd)
    pid = _get_window_pid(hwnd)
    process = _get_process_name(pid) if pid else ""
    if not _should_send_focus(title, process):
        return
    # 延迟导入避免循环依赖（bridge_ws_client 不会反向依赖本模块，
    # 但保持延迟导入可使本模块独立单测）
    from desktop_visual.bridge_ws_client import send_event

    send_event(
        "focus_change",
        {
            "title": title,
            "process": process,
            "hwnd": int(hwnd),
        },
    )


def _handle_window_open(hwnd: int) -> None:
    """处理窗口创建事件 → window_open（含 ControlType）。"""
    if not _state.get("window_active"):
        return
    # 过滤不可见窗口（tooltips/隐藏辅助窗口等噪声）
    if not user32.IsWindowVisible(hwnd):
        return
    pid = _get_window_pid(hwnd)
    if not pid:
        return
    # 节流：同进程 10s 内不重复发
    if not _should_send_window_open(pid):
        return
    title = _get_window_title(hwnd)
    process = _get_process_name(pid)
    control_type = _get_control_type(hwnd)
    from desktop_visual.bridge_ws_client import send_event

    send_event(
        "window_open",
        {
            "title": title,
            "process": process,
            "control_type": control_type,
            "hwnd": int(hwnd),
        },
    )


def _handle_window_close(hwnd: int) -> None:
    """处理窗口销毁事件 → window_close（无 ControlType，无节流）。"""
    if not _state.get("window_active"):
        return
    title = _get_window_title(hwnd)
    pid = _get_window_pid(hwnd)
    process = _get_process_name(pid) if pid else ""
    # window_close 无节流需求：每个窗口的 DESTROY 仅触发一次
    from desktop_visual.bridge_ws_client import send_event

    send_event(
        "window_close",
        {
            "title": title,
            "process": process,
            "hwnd": int(hwnd),
        },
    )


# ============================================================
# 消息循环线程
# ============================================================
def _message_loop() -> None:
    """消息循环线程：注册 hook、跑 GetMessageW 循环、退出时 UnhookWinEvent。

    同时注册三种事件的 hook（focus + window create + destroy），共享同一个
    WinEventProc 回调；回调内按 event 类型分派。OUTOFCONTEXT 模式下回调均在
    本线程消息循环中触发，因此一条线程即可服务所有事件。
    """
    _setup_signatures()

    cb = WinEventProcType(_win_event_callback)

    # 注册三种事件的 hook（eventMin=eventMax 单事件范围）
    hook_specs = [
        (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
        (EVENT_OBJECT_CREATE, EVENT_OBJECT_CREATE),
        (EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY),
    ]
    hooks: list = []
    for event_min, event_max in hook_specs:
        h = user32.SetWinEventHook(
            event_min,
            event_max,
            0,  # hmodWinEventProc（OUTOFCONTEXT 时为 0）
            cb,
            0,  # idProcess（0=所有进程）
            0,  # idThread（0=所有线程）
            WINEVENT_OUTOFCONTEXT,
        )
        if h:
            hooks.append(h)
        else:
            logging.warning("SetWinEventHook 注册失败 (event=0x%04X)", event_min)

    if not hooks:
        logging.error("所有 SetWinEventHook 注册失败，桌面事件监听未启动")
        with _state_lock:
            _state["running"] = False
        return

    thread_id = kernel32.GetCurrentThreadId()
    with _state_lock:
        _state["hooks"] = hooks
        _state["callback_ref"] = cb  # 防 GC
        _state["thread_id"] = thread_id

    logging.info(
        "桌面事件监听已启动 thread_id=%s hooks=%d (focus+window_open+window_close)",
        thread_id,
        len(hooks),
    )

    # GetMessageW: -1=错误, 0=WM_QUIT, >0=正常
    msg = wintypes.MSG()
    while True:
        ret = user32.GetMessageW(ctypes.byref(msg), 0, 0, 0)
        if ret <= 0:
            break
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))

    # 清理所有 hook
    for h in hooks:
        try:
            user32.UnhookWinEvent(h)
        except Exception as e:
            logging.warning("UnhookWinEvent 失败: %s", e)

    # 仅当本线程仍是当前活动线程时清理状态（避免 clobber 新接替的线程）
    with _state_lock:
        if _state.get("thread") is threading.current_thread():
            _state["hooks"] = []
            _state["callback_ref"] = None
            _state["thread_id"] = 0
            _state["running"] = False
            _state["thread"] = None

    logging.info("桌面事件监听已停止")


# ============================================================
# 对外 API
# ============================================================
def _ensure_loop() -> bool:
    """启动消息循环线程（若未运行或已退出）。

    focus / window 监听共享同一条线程：任一 start_* 调用时若线程未存活则拉起，
    线程内会注册全部三种事件的 hook。
    """
    with _state_lock:
        t = _state.get("thread")
        if _state.get("running") and t is not None and t.is_alive():
            return True
        # 线程不存在或已退出 → 拉起新线程
        t = threading.Thread(
            target=_message_loop,
            name="desktop-event-listener",
            daemon=True,
        )
        _state["thread"] = t
        _state["running"] = True
    t.start()
    return True


def _maybe_stop_loop() -> None:
    """若 focus / window 均不再订阅，则停止消息循环线程。

    通过向线程投递 WM_QUIT 使 GetMessageW 返回 0 退出循环；
    线程退出前会 UnhookWinEvent 清理所有 hook。
    """
    with _state_lock:
        # 仍有订阅者则保持运行
        if _state.get("focus_active") or _state.get("window_active"):
            return
        thread = _state.get("thread")
        thread_id = _state.get("thread_id", 0)
        # 标记停止中，使并发 _ensure_loop 能拉起新线程接替
        _state["running"] = False

    if not thread or not thread_id:
        return

    # 向消息循环线程投递 WM_QUIT
    try:
        user32.PostThreadMessageW(thread_id, WM_QUIT, 0, 0)
    except Exception as e:
        logging.warning("PostThreadMessageW 失败: %s", e)

    thread.join(timeout=2.0)


def start_focus_listener() -> bool:
    """启动焦点监听（EVENT_SYSTEM_FOREGROUND → focus_change）。

    与 start_window_listener 共享同一条消息循环线程。
    返回 True 表示已启动（或已在运行）；False 表示平台不支持。
    """
    if not _IS_WINDOWS:
        logging.info("非 Windows 平台，焦点监听不可用")
        return False

    with _state_lock:
        _state["focus_active"] = True
    return _ensure_loop()


def stop_focus_listener() -> None:
    """停止焦点监听。

    若 window 监听仍在运行则保持消息循环线程；否则投递 WM_QUIT 终止线程。
    """
    with _state_lock:
        _state["focus_active"] = False
    _maybe_stop_loop()


def start_window_listener() -> bool:
    """启动窗口开闭监听（EVENT_OBJECT_CREATE/DESTROY → window_open/window_close）。

    与 start_focus_listener 共享同一条消息循环线程。
    返回 True 表示已启动（或已在运行）；False 表示平台不支持。
    """
    if not _IS_WINDOWS:
        logging.info("非 Windows 平台，窗口监听不可用")
        return False

    with _state_lock:
        _state["window_active"] = True
    return _ensure_loop()


def stop_window_listener() -> None:
    """停止窗口开闭监听。

    若 focus 监听仍在运行则保持消息循环线程；否则投递 WM_QUIT 终止线程。
    """
    with _state_lock:
        _state["window_active"] = False
    _maybe_stop_loop()


# ============================================================
# 场景心跳上报（scene_tick）
# 每 interval 秒上报一次前台窗口（title/process/hwnd），供 server 端
# 情境感知做「停留时长」计算——focus_change 只在前台切换时触发，
# 用户停在某一窗口不动时没有事件，心跳补足时间维度。
# ============================================================
_scene_state: dict = {"thread": None, "stop": None}
_scene_lock = threading.Lock()


def _scene_reporter_loop(interval: float) -> None:
    logging.info("场景心跳上报已启动 interval=%.0fs", interval)
    while True:
        stop_event = _scene_state.get("stop")
        if stop_event is not None:
            if stop_event.is_set():
                break
            stop_event.wait(interval)
        else:
            time.sleep(interval)
            stop_event = _scene_state.get("stop")
            if stop_event is not None and stop_event.is_set():
                break
        try:
            hwnd = user32.GetForegroundWindow()
            if not hwnd:
                continue
            title = _get_window_title(hwnd)
            pid = _get_window_pid(hwnd)
            process = _get_process_name(pid) if pid else ""
            if not title and not process:
                continue
            from desktop_visual.bridge_ws_client import send_event

            send_event("scene_tick", {"title": title, "process": process, "hwnd": int(hwnd)})
        except Exception as e:
            logging.debug("scene_tick 上报失败: %s", e)
    logging.info("场景心跳上报已停止")


def start_scene_reporter(interval_seconds: float = 30.0) -> bool:
    """启动场景心跳上报线程。非 Windows 返回 False。"""
    if not _IS_WINDOWS:
        logging.info("非 Windows 平台，场景心跳上报不可用")
        return False
    interval = max(10.0, min(float(interval_seconds or 30.0), 300.0))
    with _scene_lock:
        t = _scene_state.get("thread")
        if t is not None and t.is_alive():
            return True
        stop_event = threading.Event()
        t = threading.Thread(
            target=_scene_reporter_loop,
            args=(interval,),
            name="desktop-scene-reporter",
            daemon=True,
        )
        _scene_state["thread"] = t
        _scene_state["stop"] = stop_event
    t.start()
    return True


def stop_scene_reporter() -> None:
    with _scene_lock:
        stop_event = _scene_state.get("stop")
        _scene_state["thread"] = None
        _scene_state["stop"] = None
    if stop_event is not None:
        stop_event.set()


__all__ = [
    "start_focus_listener",
    "stop_focus_listener",
    "start_window_listener",
    "stop_window_listener",
    "start_scene_reporter",
    "stop_scene_reporter",
]
