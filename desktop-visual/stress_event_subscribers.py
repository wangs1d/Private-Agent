"""event_subscribers 模块稳定性压测脚本。

验证 desktop_visual.event_subscribers 在多次启动/停止循环、高频事件模拟下的稳定性，
确保无线程残留、无资源泄漏、无崩溃。

运行方式（在 desktop-visual 目录下）：
    python stress_event_subscribers.py

注意：
- Windows 下 SetWinEventHook 需要消息循环，start/stop 会创建/销毁共享消息循环线程。
- 非 Windows 下 _IS_WINDOWS=False，start_*_listener 返回 False，场景 1-4 记录为 SKIP（不算失败）。
- 场景 5（幂等停止）和场景 6（节流）与平台无关，均可运行。
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time

# 确保能 import desktop_visual.event_subscribers（脚本位于 desktop-visual/ 下）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from desktop_visual import event_subscribers as es  # noqa: E402

# 压测期间屏蔽模块自身的 info/warning 日志，保持输出干净；错误仍会抛出
logging.basicConfig(level=logging.CRITICAL, format="[%(levelname)s] %(name)s: %(message)s")

IS_WINDOWS = es._IS_WINDOWS


def _state_thread():
    """读取共享消息循环线程对象。"""
    with es._state_lock:
        return es._state.get("thread")


def _wait_thread_dead(thread, timeout=3.0):
    """等待线程退出，返回是否已死亡。"""
    if thread is None:
        return True
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not thread.is_alive():
            return True
        time.sleep(0.005)
    return not thread.is_alive()


# ============================================================
# 场景 1：启动/停止循环（50 次）
# ============================================================
def scenario1_start_stop_loop_50():
    name = "场景1: 启停循环 50 次"
    print(f"\n[{name}]")
    if not IS_WINDOWS:
        print("  SKIP: 非 Windows 平台")
        return name, True, {"note": "非 Windows，跳过"}

    failures = []
    t0 = time.time()
    for i in range(50):
        try:
            es.start_focus_listener()
            es.start_window_listener()
            time.sleep(0.05)
            es.stop_window_listener()
            es.stop_focus_listener()
        except Exception as e:  # noqa: BLE001
            failures.append((i, f"exception: {e!r}"))
            continue
        # 验证 stop 后 _state["thread"] 为 None
        th = _state_thread()
        if th is not None:
            failures.append((i, f"thread 残留: {th} alive={th.is_alive()}"))

    elapsed = time.time() - t0
    final_thread = _state_thread()
    # 最终无残留 + 无失败 + 耗时 < 10s
    ok = (not failures) and (final_thread is None) and (elapsed < 10.0)
    print(f"  耗时: {elapsed:.3f}s (< 10s 要求)")
    print(f"  失败数: {len(failures)}")
    print(f"  最终 _state['thread']: {final_thread}")
    if failures:
        for f in failures[:5]:
            print(f"    失败样例: iter={f[0]} {f[1]}")
    return name, ok, {
        "elapsed": round(elapsed, 3),
        "iterations": 50,
        "failures": len(failures),
        "final_thread_is_none": final_thread is None,
        "under_10s": elapsed < 10.0,
    }


# ============================================================
# 场景 2：单独启动/停止焦点监听（30 次）
# ============================================================
def scenario2_focus_only_30():
    name = "场景2: 单独 focus 启停 30 次"
    print(f"\n[{name}]")
    if not IS_WINDOWS:
        print("  SKIP: 非 Windows 平台")
        return name, True, {"note": "非 Windows，跳过"}

    failures = []
    t0 = time.time()
    for i in range(30):
        try:
            es.start_focus_listener()
            time.sleep(0.02)
            es.stop_focus_listener()
        except Exception as e:  # noqa: BLE001
            failures.append((i, f"exception: {e!r}"))
            continue
        th = _state_thread()
        if th is not None:
            failures.append((i, f"thread 残留: alive={th.is_alive()}"))

    elapsed = time.time() - t0
    final_thread = _state_thread()
    ok = (not failures) and (final_thread is None)
    print(f"  耗时: {elapsed:.3f}s, 失败数: {len(failures)}, 最终 thread: {final_thread}")
    return name, ok, {
        "elapsed": round(elapsed, 3),
        "iterations": 30,
        "failures": len(failures),
        "final_thread_is_none": final_thread is None,
    }


# ============================================================
# 场景 3：单独启动/停止窗口监听（30 次）
# ============================================================
def scenario3_window_only_30():
    name = "场景3: 单独 window 启停 30 次"
    print(f"\n[{name}]")
    if not IS_WINDOWS:
        print("  SKIP: 非 Windows 平台")
        return name, True, {"note": "非 Windows，跳过"}

    failures = []
    t0 = time.time()
    for i in range(30):
        try:
            es.start_window_listener()
            time.sleep(0.02)
            es.stop_window_listener()
        except Exception as e:  # noqa: BLE001
            failures.append((i, f"exception: {e!r}"))
            continue
        th = _state_thread()
        if th is not None:
            failures.append((i, f"thread 残留: alive={th.is_alive()}"))

    elapsed = time.time() - t0
    final_thread = _state_thread()
    ok = (not failures) and (final_thread is None)
    print(f"  耗时: {elapsed:.3f}s, 失败数: {len(failures)}, 最终 thread: {final_thread}")
    return name, ok, {
        "elapsed": round(elapsed, 3),
        "iterations": 30,
        "failures": len(failures),
        "final_thread_is_none": final_thread is None,
    }


# ============================================================
# 场景 4：并发启动（线程安全）
# ============================================================
def scenario4_concurrent_start():
    name = "场景4: 5 线程并发启动"
    print(f"\n[{name}]")
    if not IS_WINDOWS:
        print("  SKIP: 非 Windows 平台")
        return name, True, {"note": "非 Windows，跳过"}

    errors = []

    def worker():
        try:
            es.start_focus_listener()
            es.start_window_listener()
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))

    threads = [threading.Thread(target=worker, name=f"starter-{k}") for k in range(5)]
    t0 = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 给消息循环线程一点时间稳定
    time.sleep(0.1)

    th = _state_thread()
    live_count = 1 if (th is not None and th.is_alive()) else 0

    # 统计存活的名为 desktop-event-listener 的线程数（应 <= 1）
    alive_named = [
        t.name for t in threading.enumerate() if t.name == "desktop-event-listener" and t.is_alive()
    ]

    # 清理
    try:
        es.stop_focus_listener()
        es.stop_window_listener()
    except Exception as e:  # noqa: BLE001
        errors.append(f"cleanup: {e!r}")
    time.sleep(0.1)
    final_thread = _state_thread()
    elapsed = time.time() - t0

    ok = (not errors) and (live_count <= 1) and (len(alive_named) <= 1) and (final_thread is None)
    print(f"  并发错误数: {len(errors)}")
    print(f"  _state['thread'] 存活数: {live_count} (期望 <=1)")
    print(f"  存活 desktop-event-listener 线程数: {len(alive_named)} (期望 <=1)")
    print(f"  清理后 _state['thread']: {final_thread}")
    print(f"  耗时: {elapsed:.3f}s")
    return name, ok, {
        "errors": len(errors),
        "live_state_thread": live_count,
        "alive_named_threads": len(alive_named),
        "final_thread_is_none": final_thread is None,
        "elapsed": round(elapsed, 3),
    }


# ============================================================
# 场景 5：重复停止（幂等性）
# ============================================================
def scenario5_repeat_stop_idempotent():
    name = "场景5: 重复停止幂等性"
    print(f"\n[{name}]")
    # 确保未启动状态下连续停止不崩溃（平台无关）
    errors = []
    try:
        for _ in range(5):
            es.stop_focus_listener()
        for _ in range(5):
            es.stop_window_listener()
        # 交错再各 5 次
        for _ in range(5):
            es.stop_focus_listener()
            es.stop_window_listener()
    except Exception as e:  # noqa: BLE001
        errors.append(repr(e))
    final_thread = _state_thread()
    ok = (not errors) and (final_thread is None)
    print(f"  错误数: {len(errors)}, 最终 thread: {final_thread}")
    return name, ok, {"errors": len(errors), "final_thread_is_none": final_thread is None}


# ============================================================
# 场景 6：节流逻辑压测
# ============================================================
def scenario6_throttle():
    name = "场景6: 节流逻辑压测"
    print(f"\n[{name}]")

    # --- 6.1 focus 节流：同 key 调用 1000 次 ---
    with es._focus_throttle_lock:
        es._focus_throttle.clear()
    title, process = "Notepad", "notepad.exe"
    focus_true = 0
    for _ in range(1000):
        if es._should_send_focus(title, process):
            focus_true += 1
    with es._focus_throttle_lock:
        focus_size = len(es._focus_throttle)

    # --- 6.2 window_open 节流：同 pid 调用 1000 次 ---
    with es._window_open_throttle_lock:
        es._window_open_throttle.clear()
    pid = 12345
    win_true = 0
    for _ in range(1000):
        if es._should_send_window_open(pid):
            win_true += 1
    with es._window_open_throttle_lock:
        win_size = len(es._window_open_throttle)

    # --- 6.3 节流表不无限增长：300 个不同 key（均未过期，size=300，不触发清理） ---
    with es._focus_throttle_lock:
        es._focus_throttle.clear()
    for i in range(300):
        es._should_send_focus(f"t{i}", f"p{i}")
    with es._focus_throttle_lock:
        size_300_fresh = len(es._focus_throttle)

    # --- 6.4 清理逻辑：注入 250 条已过期 + 5 条未过期，触发清理后应只剩未过期 + 新增 1 ---
    with es._focus_throttle_lock:
        es._focus_throttle.clear()
    now = time.time()
    with es._focus_throttle_lock:
        # 250 条过期（> 5s）
        for i in range(250):
            es._focus_throttle[(f"old_t{i}", f"old_p{i}")] = now - es.FOCUS_THROTTLE_SECONDS - 1
        # 5 条未过期
        for i in range(5):
            es._focus_throttle[(f"new_t{i}", f"new_p{i}")] = now - 0.1
    # 调用一次（新 key），len>200 触发清理 → 过期项被删除
    es._should_send_focus("trigger_key", "trigger_proc")
    with es._focus_throttle_lock:
        size_after_cleanup = len(es._focus_throttle)
    # 期望：5 未过期 + 1 新增 = 6（清理掉 250 过期）
    cleanup_ok = size_after_cleanup == 6

    # --- 6.5 window_open 清理逻辑同样验证 ---
    with es._window_open_throttle_lock:
        es._window_open_throttle.clear()
    now = time.time()
    with es._window_open_throttle_lock:
        for i in range(250):
            es._window_open_throttle[10000 + i] = now - es.WINDOW_OPEN_THROTTLE_SECONDS - 1
        for i in range(5):
            es._window_open_throttle[20000 + i] = now - 0.1
    es._should_send_window_open(99999)
    with es._window_open_throttle_lock:
        win_size_after_cleanup = len(es._window_open_throttle)
    win_cleanup_ok = win_size_after_cleanup == 6

    focus_throttle_ok = (focus_true == 1) and (focus_size == 1)
    window_throttle_ok = (win_true == 1) and (win_size == 1)
    growth_ok = size_300_fresh == 300  # 未过期不清理，符合预期

    ok = focus_throttle_ok and window_throttle_ok and growth_ok and cleanup_ok and win_cleanup_ok
    print(f"  6.1 focus 1000 次同 key: True 次数={focus_true} (期望 1), 表大小={focus_size} (期望 1)")
    print(f"  6.2 window 1000 次同 pid: True 次数={win_true} (期望 1), 表大小={win_size} (期望 1)")
    print(f"  6.3 300 不同 key (未过期): 表大小={size_300_fresh} (期望 300, 不清理)")
    print(f"  6.4 focus 清理: 250 过期+5 未过期+1 新增 → 表大小={size_after_cleanup} (期望 6) {'OK' if cleanup_ok else 'FAIL'}")
    print(f"  6.5 window 清理: 250 过期+5 未过期+1 新增 → 表大小={win_size_after_cleanup} (期望 6) {'OK' if win_cleanup_ok else 'FAIL'}")
    return name, ok, {
        "focus_true_count": focus_true,
        "focus_size": focus_size,
        "window_true_count": win_true,
        "window_size": win_size,
        "size_300_fresh": size_300_fresh,
        "focus_size_after_cleanup": size_after_cleanup,
        "window_size_after_cleanup": win_size_after_cleanup,
    }


def main():
    print("=" * 64)
    print("event_subscribers 稳定性压测")
    print(f"平台: {'Windows' if IS_WINDOWS else '非 Windows'}")
    print(f"Python: {sys.version.split()[0]}")
    print(f"_IS_WINDOWS = {IS_WINDOWS}")
    print("=" * 64)

    results = [
        scenario1_start_stop_loop_50(),
        scenario2_focus_only_30(),
        scenario3_window_only_30(),
        scenario4_concurrent_start(),
        scenario5_repeat_stop_idempotent(),
        scenario6_throttle(),
    ]

    print("\n" + "=" * 64)
    print("压测总结")
    print("=" * 64)
    all_pass = True
    for name, ok, data in results:
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {name}")
        print(f"         {data}")
        if not ok:
            all_pass = False
    print("=" * 64)
    print(f"总体验收: {'通过' if all_pass else '未通过'}")
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
