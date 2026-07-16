"""离线验证 _find_exe / _find_start_menu_shortcut 对 D 盘 + 开始菜单的匹配逻辑。

不依赖真实 Windows 环境:用 tmp 目录模拟文件系统,直接 import 目标模块函数并 monkey-patch 搜索目录。
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# 让 stdio_worker 可被 import
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "desktop_visual"))

# 必须在 import stdio_worker 之前,否则 _APP_SEARCH_DIRS 已经被冻结
import desktop_visual.stdio_worker as sw  # noqa: E402


def _build_fake_fs(root: Path) -> dict[str, list[str]]:
    """构造一个仿真 Windows 文件系统,返回各测试场景期望命中的相对路径列表。"""
    # D:\豆包\豆包.exe        ← 裸 exe,深度 2
    (root / "D" / "豆包").mkdir(parents=True)
    (root / "D" / "豆包" / "豆包.exe").write_text("")

    # D:\tools\WeChat\Weixin.exe   ← 别名命中
    (root / "D" / "tools" / "WeChat").mkdir(parents=True)
    (root / "D" / "tools" / "WeChat" / "Weixin.exe").write_text("")

    # C:\Program Files\Tencent\QQ\Bin\QQ.exe
    (root / "C" / "Program Files" / "Tencent" / "QQ" / "Bin").mkdir(parents=True)
    (root / "C" / "Program Files" / "Tencent" / "QQ" / "Bin" / "QQ.exe").write_text("")

    # 开始菜单嵌套: C:\Users\me\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\豆包\豆包桌面版.lnk
    sm_user = root / "Users" / "me" / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    (sm_user / "豆包").mkdir(parents=True)
    (sm_user / "豆包" / "豆包桌面版.lnk").write_text("")

    # 系统级开始菜单: C:\ProgramData\Microsoft\Windows\Start Menu\Programs\WPS Office.lnk
    sm_sys = root / "C" / "ProgramData" / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    sm_sys.mkdir(parents=True)
    (sm_sys / "WPS Office.lnk").write_text("")

    return {
        "豆包_exe":        [str(root / "D" / "豆包" / "豆包.exe")],
        "doubao_exe":      [str(root / "D" / "豆包" / "豆包.exe")],
        "WeChat_alias":    [str(root / "D" / "tools" / "WeChat" / "Weixin.exe")],
        "wechat_alias":    [str(root / "D" / "tools" / "WeChat" / "Weixin.exe")],
        "QQ_exe":          [str(root / "C" / "Program Files" / "Tencent" / "QQ" / "Bin" / "QQ.exe")],
        "豆包_startmenu":  [str(root / "Users" / "me" / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "豆包" / "豆包桌面版.lnk")],
        "WPS_startmenu":   [str(root / "C" / "ProgramData" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "WPS Office.lnk")],
    }


def test_expand_variants():
    print("\n=== _expand_name_variants ===")
    cases = {
        "豆包":     {"豆包", "doubao", "doubao_talk", "doubaotalk", "doubao-desktop"},
        "doubao":   {"豆包", "doubao", "doubao_talk", "doubaotalk", "doubao-desktop"},
        "WeChat":   {"wechat", "weixin"},
        "Weixin":   {"wechat", "weixin"},
        "QQ":       {"qq", "tencentqq", "qqpc"},
        "WPS":      {"wps", "wpp", "kingsoft"},
    }
    for inp, expected in cases.items():
        got = sw._expand_name_variants(inp)
        ok = got == expected
        print(f"  {inp!r:12s} → {sorted(got)}  {'PASS' if ok else 'FAIL (expected ' + str(sorted(expected)) + ')'}")
        assert ok, f"variants mismatch for {inp!r}: got {got}, expected {expected}"


def test_find_exe_and_shortcut():
    print("\n=== _find_exe / _find_start_menu_shortcut (mocked fs) ===")
    with tempfile.TemporaryDirectory(prefix="find_exe_test_") as tmp:
        root = Path(tmp)
        expected = _build_fake_fake_fs_results = _build_fake_fs(root)

        # Monkey-patch 搜索目录(只指向我们造的 tmp 路径,避免污染真实系统)
        fake_c_drive = root / "C"
        fake_d_drive = root / "D"
        sm_user = root / "Users" / "me" / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs"
        sm_sys = root / "C" / "ProgramData" / "Microsoft" / "Windows" / "Start Menu" / "Programs"

        sw._APP_SEARCH_DIRS = [
            str(fake_c_drive / "Program Files"),
            str(fake_c_drive / "Program Files (x86)"),
            str(fake_c_drive / "ProgramData" / "Microsoft" / "Windows" / "Start Menu" / "Programs"),
            str(sm_user),
            str(fake_d_drive / "豆包"),
            str(fake_d_drive / "tools" / "WeChat"),
        ]
        # 写一个 start menu 专用列表给 start_menu 函数用
        sw._find_start_menu_shortcut.__globals__  # noop touch

        # Patch expanduser / ProgramData env 给 _find_start_menu_shortcut 用
        os.environ["ProgramData"] = str(fake_c_drive / "ProgramData")
        # expanduser 没法 monkey patch,但传 path 时不走它;这里 _find_start_menu_shortcut 内部用
        # 了 os.path.expanduser("~\\AppData\\..."),需要覆盖 HOME/USERPROFILE
        os.environ["USERPROFILE"] = str(root / "Users" / "me")
        os.environ["HOME"] = str(root / "Users" / "me")

        cases = [
            # (input, search_kind, expected_path_substr)
            ("豆包",      "exe",  "豆包" + os.sep + "豆包.exe"),
            ("doubao",    "exe",  "豆包" + os.sep + "豆包.exe"),
            ("WeChat",    "exe",  "WeChat" + os.sep + "Weixin.exe"),
            ("wechat",    "exe",  "WeChat" + os.sep + "Weixin.exe"),
            ("QQ",        "exe",  "QQ.exe"),
            ("豆包",      "lnk",  "豆包桌面版.lnk"),
            ("WPS",       "lnk",  "WPS Office.lnk"),
            ("wps",       "lnk",  "WPS Office.lnk"),
        ]

        for inp, kind, expect_substr in cases:
            if kind == "exe":
                got = sw._find_exe(inp)
            else:
                got = sw._find_start_menu_shortcut(inp)
            ok = got is not None and expect_substr in got
            tag = "PASS" if ok else "FAIL"
            print(f"  {inp!r:10s} ({kind}) → {got!r}  {tag}")
            if not ok:
                raise AssertionError(f"expected substring {expect_substr!r} in result, got {got!r}")


if __name__ == "__main__":
    test_expand_variants()
    test_find_exe_and_shortcut()
    print("\nAll tests passed.")
