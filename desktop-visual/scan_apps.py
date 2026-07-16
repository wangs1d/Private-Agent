"""快速扫描本机已安装应用。

数据源(按可靠性):
1. 用户/系统两级开始菜单 .lnk(99% 的桌面应用都在这里留入口)
2. 各盘根目录下"看起来像软件"的目录(基于 _build_search_dirs 的优先级 + 排除列表)
3. 系统盘 Program Files / Program Files (x86) / AppData\Local\Programs

不做全盘 os.walk(太慢);只扫上面 3 类"应用安装区",深度限制 4 层。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "desktop_visual"))

from desktop_visual.stdio_worker import (  # noqa: E402
    _build_search_dirs,
    _is_start_menu_dir,
)


def _scan_start_menu() -> list[tuple[str, str, str]]:
    """扫两个 Start Menu 目录(用户级 + 系统级),返回 (name, path, source)。"""
    home = os.path.expanduser("~")
    sm_dirs = [
        os.path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
        os.path.join(
            os.environ.get("ProgramData", "C:\\ProgramData"),
            "Microsoft", "Windows", "Start Menu", "Programs",
        ),
    ]
    out: list[tuple[str, str, str]] = []
    for d in sm_dirs:
        if not os.path.isdir(d):
            continue
        base_depth = d.count(os.sep)
        for root, _dirs, files in os.walk(d):
            depth = root.count(os.sep) - base_depth
            if depth > 4:
                _dirs.clear()
                continue
            for f in files:
                if f.lower().endswith(".lnk"):
                    out.append((os.path.splitext(f)[0], os.path.join(root, f), "StartMenu"))
    return out


def _scan_dir(d: str, max_depth: int, source: str) -> list[tuple[str, str, str]]:
    """扫一个根目录,只取 .exe,返回 (name, path, source)。"""
    if not os.path.isdir(d):
        return []
    out: list[tuple[str, str, str]] = []
    base_depth = d.count(os.sep)
    for root, _dirs, files in os.walk(d):
        depth = root.count(os.sep) - base_depth
        if depth > max_depth:
            _dirs.clear()
            continue
        for f in files:
            if f.lower().endswith(".exe"):
                out.append((os.path.splitext(f)[0], os.path.join(root, f), source))
    return out


def main() -> None:
    if os.name != "nt":
        print("本扫描器仅在 Windows 上有意义。")
        return

    print("=" * 78)
    print("开始扫描本机已安装应用(基于 _find_exe 修复后的代码)")
    print("=" * 78)

    # 1) Start Menu
    print("\n[1/3] 扫描开始菜单(用户级 + 系统级)...")
    sm_apps = _scan_start_menu()
    print(f"  → 找到 {len(sm_apps)} 个 .lnk 快捷方式")

    # 2) 各盘根目录下的"软件目录" + 系统盘常规位置
    print("\n[2/3] 扫描各盘根目录 + Program Files/AppData ...")
    search_dirs = _build_search_dirs()
    fs_apps: list[tuple[str, str, str]] = []
    for d in search_dirs:
        # start menu 已经在 [1] 扫过,这里跳过
        if _is_start_menu_dir(d):
            continue
        base = os.path.basename(d).lower()
        # 系统盘常规位置:深度 3(QQ/微信类典型 3 层)
        # 非系统盘根目录子目录:深度 2(豆包等扁平安装)
        max_depth = 3 if base in {"program files", "program files (x86)"} else 2
        source = "ProgramFiles" if "program files" in base else (
            "AppData\\Local\\Programs" if "appdata" in base.lower() and "local" in d.lower() and "programs" in base else
            f"DriveRoot/{os.path.basename(os.path.dirname(d))}"
        )
        if not os.path.isdir(d):
            continue
        before = len(fs_apps)
        fs_apps.extend(_scan_dir(d, max_depth, source))
        added = len(fs_apps) - before
        if added > 0:
            print(f"  {d}  →  +{added} .exe")

    # 3) 合并去重(按 (name.lower(), path) 去重,优先保留 StartMenu 源)
    print("\n[3/3] 合并去重 ...")
    all_apps = sm_apps + fs_apps
    seen: set[tuple[str, str]] = set()
    deduped: list[tuple[str, str, str]] = []
    # StartMenu 排前面,fs_apps 排后面 → 第一次出现优先
    for name, path, src in all_apps:
        key = (name.lower(), path.lower())
        if key in seen:
            continue
        seen.add(key)
        deduped.append((name, path, src))

    # 按名称排序展示
    deduped.sort(key=lambda x: x[0].lower())

    print(f"\n{'=' * 78}")
    print(f"共找到 {len(deduped)} 个应用条目  (按名称排序)")
    print(f"{'=' * 78}\n")
    for i, (name, path, src) in enumerate(deduped, 1):
        # 缩短路径显示
        try:
            display = path.replace(os.path.expanduser("~"), "~")
        except Exception:
            display = path
        print(f"  {i:3d}. {name:<32s}  [{src}]")
        print(f"        {display}")

    # 按盘符 / 源 统计
    print(f"\n{'=' * 78}")
    print("按来源统计:")
    by_source: dict[str, int] = {}
    for _, _, src in deduped:
        by_source[src] = by_source.get(src, 0) + 1
    for src, n in sorted(by_source.items(), key=lambda x: -x[1]):
        print(f"  {src:<35s}  {n}")


if __name__ == "__main__":
    main()
