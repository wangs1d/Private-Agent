"""Windows UIAutomation 封装（pywinauto）。

仅 Windows 可用；其他平台 / import 失败时所有方法安全降级。
UiaController 采取懒加载策略：首次调用 UIA API 时才 import pywinauto。

设计要点：
- 坐标兜底：element_at(x, y) 用 IUIAutomation.ElementFromPoint 拿元素
- 结构化查询：query(selector) 按 name/automation_id/control_type 组合查询
- 坐标系：进程为 Per-Monitor V2 DPI aware，输入输出均为屏幕物理像素
  （与截图、鼠标一致；快照额外输出 path 供 run_automation 复用）
- 异常隔离：所有 UIA 调用 try/except，失败返回 None/[]，不阻塞视觉循环
"""
from __future__ import annotations

import ctypes
import logging
import os
from ctypes import wintypes
from typing import Any, Optional, TypedDict

logger = logging.getLogger(__name__)


class ElementInfo(TypedDict, total=False):
    """UIA 元素信息快照（序列化友好，可直传 JSON）。"""
    name: str
    automation_id: str
    control_type: str
    class_name: str
    bbox: list[int]  # [left, top, right, bottom] 屏幕物理坐标
    patterns: list[str]  # 支持的 pattern 名：Invoke / SelectionItem / Value / ...
    is_enabled: bool
    is_offscreen: bool
    process_name: str
    # 内部用：保留 UIA 元素引用供 invoke() 复用（不序列化，仅本进程内调用）
    __ref: Any


class UiaController:
    """pywinauto UIA 封装，懒加载 + 安全降级。

    单例风格：建议在 visual_loop / stdio_worker 中复用同一实例。
    """

    def __init__(self) -> None:
        self._uia: Any = None  # pywinauto.uia_defines.iuia 实例
        self._initialized = False
        self._available = False
        self._dpi_scale: float = 1.0
        # known_control_type_ids 实际是 {id: name}，反向得 {name: id} 用于 selector 查询
        self._control_type_id_by_name: dict[str, int] = {}
        self._control_type_name_map: dict[int, str] = {}

    # ---- 可用性 ----------------------------------------------------------
    def is_available(self) -> bool:
        if not self._initialized:
            self._initialize()
        return self._available

    def _initialize(self) -> None:
        self._initialized = True
        if os.name != "nt":
            logger.info("UIA 不可用：非 Windows 环境")
            return
        try:
            # pywinauto 0.6.x 顶层 IUIA 单例，self.iuia 即 comtypes 包装的 IUIAutomation
            from pywinauto.uia_defines import IUIA  # type: ignore[import-not-found]
            singleton = IUIA()
            self._uia = singleton.iuia
            # known_control_type_ids 是 {id: name}，反向得 {name: id} 用于 selector 查询
            self._control_type_name_map = dict(singleton.known_control_type_ids)
            self._control_type_id_by_name = {v: k for k, v in self._control_type_name_map.items()}
            self._available = True
            self._dpi_scale = self._query_dpi_scale()
            logger.info(
                "UIA 初始化成功 (DPI scale=%.2f, %d 控件类型)",
                self._dpi_scale,
                len(self._control_type_name_map),
            )
        except Exception as exc:
            logger.warning("UIA 初始化失败（pywinauto 未安装或 comtypes 异常）: %s", exc)
            self._available = False

    def _query_dpi_scale(self) -> float:
        """获取系统 DPI 缩放比（1.0 = 96 DPI）。仅 Windows。"""
        try:
            user32 = ctypes.windll.user32
            # GetDpiForWindow(0) 在 Win10 1607+ 可用，返回系统 DPI
            dpi = user32.GetDpiForWindow(0)
            if dpi > 0:
                return dpi / 96.0
        except Exception:
            pass
        return 1.0

    def _to_logical_point(self, x: int, y: int) -> tuple[int, int]:
        """坐标换算：进程已声明 Per-Monitor V2 DPI aware（stdio_worker 启动时），
        UIA ElementFromPoint 直接接受屏幕物理坐标，无需再除以缩放比。
        保留方法签名以兼容既有调用点。"""
        return int(x), int(y)

    # ---- 坐标兜底 --------------------------------------------------------
    def element_at(self, x: int, y: int) -> Optional[ElementInfo]:
        """获取 (x, y) 处的 UIA 元素。失败返回 None。"""
        if not self.is_available():
            return None
        try:
            lx, ly = self._to_logical_point(x, y)
            # IUIAutomation.ElementFromPoint(POINT)
            elem = self._uia.ElementFromPoint(ctypes.wintypes.POINT(lx, ly))
            if elem is None:
                return None
            return self._snapshot(elem)
        except Exception as exc:
            logger.warning("element_at(%d,%d) 失败: %s", x, y, exc)
            return None

    def invoke(self, element_info: ElementInfo) -> bool:
        """对元素调用 InvokePattern。失败返回 False。

        注意：element_info 必须是最近 element_at/query 的返回值，
        内部用缓存引用调 pattern。若元素已失效会抛异常。
        """
        if not self.is_available():
            return False
        ref = element_info.get("__ref")
        if ref is None:
            return False
        try:
            # comtypes 用 GetCurrentPattern(不是 GetPattern),返回 IUnknown 指针
            unk = ref.GetCurrentPattern(10000)  # UIA_InvokePatternId = 10000
            if not unk:
                return False
            # QueryInterface 到 IUIAutomationInvokePattern
            from comtypes.gen.UIAutomationClient import IUIAutomationInvokePattern
            invoke_pat = unk.QueryInterface(IUIAutomationInvokePattern)
            invoke_pat.Invoke()
            return True
        except Exception as exc:
            logger.warning("invoke 失败: %s", exc)
        return False

    def set_value(self, element_info: ElementInfo, value: str) -> bool:
        """对元素调用 ValuePattern.SetValue。失败返回 False。

        用于直接设置文本框内容,不模拟键盘输入,不抢焦点,不要求窗口在前台。
        适用于 Win32 Edit / WPF TextBox / WinForms TextBox 等。
        Electron 内部控件通常不支持 ValuePattern。
        """
        if not self.is_available():
            return False
        ref = element_info.get("__ref")
        if ref is None:
            return False
        try:
            unk = ref.GetCurrentPattern(10002)  # UIA_ValuePatternId = 10002
            if not unk:
                return False
            from comtypes.gen.UIAutomationClient import IUIAutomationValuePattern
            value_pat = unk.QueryInterface(IUIAutomationValuePattern)
            value_pat.SetValue(value)
            return True
        except Exception as exc:
            logger.warning("set_value 失败: %s", exc)
        return False

    def get_value(self, element_info: ElementInfo) -> str | None:
        """读取元素当前值(ValuePattern.CurrentValue)。失败返回 None。"""
        if not self.is_available():
            return None
        ref = element_info.get("__ref")
        if ref is None:
            return None
        try:
            unk = ref.GetCurrentPattern(10002)
            if not unk:
                return None
            from comtypes.gen.UIAutomationClient import IUIAutomationValuePattern
            value_pat = unk.QueryInterface(IUIAutomationValuePattern)
            return str(value_pat.CurrentValue) if value_pat.CurrentValue else ""
        except Exception as exc:
            logger.warning("get_value 失败: %s", exc)
            return None

    def toggle(self, element_info: ElementInfo) -> bool:
        """对元素调用 TogglePattern.Toggle(复选框/单选按钮)。失败返回 False。"""
        if not self.is_available():
            return False
        ref = element_info.get("__ref")
        if ref is None:
            return False
        try:
            unk = ref.GetCurrentPattern(10015)  # UIA_TogglePatternId = 10015
            if not unk:
                return False
            from comtypes.gen.UIAutomationClient import IUIAutomationTogglePattern
            toggle_pat = unk.QueryInterface(IUIAutomationTogglePattern)
            toggle_pat.Toggle()
            return True
        except Exception as exc:
            logger.warning("toggle 失败: %s", exc)
        return False

    def focus(self, element_info: ElementInfo) -> bool:
        """对元素调用 SetFocus。失败返回 False。

        用于把焦点设到目标控件(不激活窗口,仅设焦点)。
        """
        if not self.is_available():
            return False
        ref = element_info.get("__ref")
        if ref is None:
            return False
        try:
            ref.SetFocus()
            return True
        except Exception as exc:
            logger.warning("focus 失败: %s", exc)
        return False

    def select(self, element_info: ElementInfo) -> bool:
        """对元素调用 SelectionItemPattern.Select(列表项/树节点选中)。失败返回 False。"""
        if not self.is_available():
            return False
        ref = element_info.get("__ref")
        if ref is None:
            return False
        try:
            unk = ref.GetCurrentPattern(10010)  # UIA_SelectionItemPatternId = 10010
            if not unk:
                return False
            from comtypes.gen.UIAutomationClient import IUIAutomationSelectionItemPattern
            sel_pat = unk.QueryInterface(IUIAutomationSelectionItemPattern)
            sel_pat.Select()
            return True
        except Exception as exc:
            logger.warning("select 失败: %s", exc)
        return False

    def expand(self, element_info: ElementInfo, *, expand: bool = True) -> bool:
        """对元素调用 ExpandCollapsePattern.Expand/Collapse(下拉框/树节点展开折叠)。失败返回 False。"""
        if not self.is_available():
            return False
        ref = element_info.get("__ref")
        if ref is None:
            return False
        try:
            unk = ref.GetCurrentPattern(10005)  # UIA_ExpandCollapsePatternId = 10005
            if not unk:
                return False
            from comtypes.gen.UIAutomationClient import IUIAutomationExpandCollapsePattern
            ec_pat = unk.QueryInterface(IUIAutomationExpandCollapsePattern)
            if expand:
                ec_pat.Expand()
            else:
                ec_pat.Collapse()
            return True
        except Exception as exc:
            logger.warning("expand(%s) 失败: %s", expand, exc)
        return False

    def scroll_into_view(self, element_info: ElementInfo) -> bool:
        """对元素调用 ScrollItemPattern.ScrollIntoView(滚动到可见区域)。失败返回 False。"""
        if not self.is_available():
            return False
        ref = element_info.get("__ref")
        if ref is None:
            return False
        try:
            unk = ref.GetCurrentPattern(10017)  # UIA_ScrollItemPatternId = 10017
            if not unk:
                return False
            from comtypes.gen.UIAutomationClient import IUIAutomationScrollItemPattern
            si_pat = unk.QueryInterface(IUIAutomationScrollItemPattern)
            si_pat.ScrollIntoView()
            return True
        except Exception as exc:
            logger.warning("scroll_into_view 失败: %s", exc)
        return False

    # ---- 窗口根与控件树快照（主流"快照→按元素操作"模式） ------------------

    def find_window_root(self, title: str | None = None) -> tuple[Optional[Any], str]:
        """定位顶层窗口元素作为查询/快照根。

        - title 非空：按窗口标题子串匹配（大小写不敏感），返回第一个命中；
        - title 为空：优先前台窗口（GetForegroundWindow → ElementFromHandle），
          失败退化为桌面根。

        返回 (element_ref, window_title)；找不到返回 (None, "")。
        """
        if not self.is_available():
            return None, ""
        try:
            if title:
                needle = title.strip().lower()
                root = self._uia.GetRootElement()
                walker = self._uia.CreateControlViewWalker()
                child = walker.GetFirstChildElement(root)
                while child is not None:
                    try:
                        name = (child.CurrentName or "").strip()
                        if needle in name.lower():
                            return child, name
                    except Exception:
                        pass
                    try:
                        child = walker.GetNextSiblingElement(child)
                    except Exception:
                        break
                return None, ""
            # 前台窗口优先
            try:
                import ctypes

                hwnd = ctypes.windll.user32.GetForegroundWindow()
                if hwnd:
                    elem = self._uia.ElementFromHandle(hwnd)
                    if elem is not None:
                        return elem, (elem.CurrentName or "")
            except Exception:
                pass
            root = self._uia.GetRootElement()
            return root, "Desktop"
        except Exception as exc:
            logger.warning("find_window_root(%r) 失败: %s", title, exc)
            return None, ""

    def snapshot_tree(self, root_ref: Any, *, max_depth: int = 6, limit: int = 150) -> list[dict[str, Any]]:
        """控制视图扁平遍历，产出可复用的元素快照列表。

        每项含 path（形如 "2.1.3"，相对 root 的 1-based 控制视图子索引链），
        同一进程内 / 跨进程都可用 element_by_path(root, path) 确定性复原。
        """
        if not self.is_available() or root_ref is None:
            return []
        out: list[dict[str, Any]] = []
        walker = self._uia.CreateControlViewWalker()
        self._snapshot_walk(walker, root_ref, "", 0, min(max(1, max_depth), 12), min(max(1, limit), 500), out)
        return out

    def _snapshot_walk(
        self,
        walker: Any,
        node: Any,
        parent_path: str,
        depth: int,
        max_depth: int,
        limit: int,
        out: list[dict[str, Any]],
    ) -> None:
        if len(out) >= limit or depth >= max_depth:
            return
        try:
            child = walker.GetFirstChildElement(node)
        except Exception:
            child = None
        sibling = 0
        while child is not None and len(out) < limit:
            sibling += 1
            path = f"{sibling}" if not parent_path else f"{parent_path}.{sibling}"
            snap = self._snapshot(child)
            if snap is not None:
                snap["path"] = path
                snap["depth"] = depth
                out.append(snap)
                if len(out) < limit:
                    self._snapshot_walk(walker, child, path, depth + 1, max_depth, limit, out)
            try:
                child = walker.GetNextSiblingElement(child)
            except Exception:
                break

    def element_by_path(self, root_ref: Any, path: str) -> Optional[ElementInfo]:
        """按 snapshot_tree 输出的 path 复原元素（控制视图子索引，1-based）。"""
        if not self.is_available() or root_ref is None:
            return None
        parts = [p for p in str(path).strip().split(".") if p]
        if not parts:
            return None
        walker = self._uia.CreateControlViewWalker()
        node = root_ref
        for part in parts:
            try:
                index = int(part)
            except ValueError:
                return None
            if index < 1:
                return None
            try:
                child = walker.GetFirstChildElement(node)
            except Exception:
                return None
            target = None
            sibling = 0
            while child is not None:
                sibling += 1
                if sibling == index:
                    target = child
                    break
                try:
                    child = walker.GetNextSiblingElement(child)
                except Exception:
                    break
            if target is None:
                return None
            node = target
        return self._snapshot(node)

    # ---- 结构化查询 ------------------------------------------------------
    def query(self, selector: dict[str, Any], *, top_only: bool = True, limit: int = 100) -> list[ElementInfo]:
        """按 selector 条件查询元素。

        selector 字段：
        - name: 元素 Name（精确匹配）
        - name_contains: Name 子串匹配（后过滤,UIA 无原生子串条件）
        - automation_id: AutomationId（精确）
        - control_type: 控件类型，如 Button/Edit/List/List/ListItem/Tree/TreeItem
        - class_name: ClassName（精确）
        - parent: 父元素 __ref（可选，限定查询范围）
        """
        if not self.is_available():
            return []
        try:
            # name_contains 需要后过滤(UIA 无原生子串条件),先提取出来
            name_contains = selector.get("name_contains")
            # 构造 UIA 条件时排除 name_contains(它不是原生条件)
            cond_selector = {k: v for k, v in selector.items() if k != "name_contains"}
            root = self._uia.GetRootElement() if cond_selector.get("parent") is None else cond_selector["parent"]
            condition = self._build_condition(cond_selector)
            if condition is None:
                return []
            walker = self._uia.CreateTreeWalker(condition)
            results: list[ElementInfo] = []
            # 如果有 name_contains 后过滤,需要多遍历一些再过滤
            raw_limit = limit * 5 if name_contains else limit
            self._walk(root, walker, results, top_only, raw_limit, depth=0)
            # name_contains 后过滤
            if name_contains:
                results = [e for e in results if name_contains in e.get("name", "")]
            return results[:limit]
        except Exception as exc:
            logger.warning("query(%r) 失败: %s", selector, exc)
            return []

    def read_children(self, parent_ref: Any, *, limit: int = 200) -> list[ElementInfo]:
        """读元素直接子节点（用于 ListView/Tree 内容读取）。

        comtypes 的 IUIAutomationElement 没有 GetFirstChildElement/GetNextSiblingElement
        (这些是 IUIAutomationTreeWalker 的方法)。改用 FindAll(TreeScope_Children) 查直接子元素。
        """
        if not self.is_available() or parent_ref is None:
            return []
        try:
            # TreeScope_Children = 2,只查直接子节点;用 TrueCondition 匹配所有
            true_cond = self._uia.CreateTrueCondition()
            raw_array = parent_ref.FindAll(2, true_cond)  # 2 = TreeScope_Children
            if not raw_array:
                return []
            # IUIAutomationElementArray 不可迭代,用 Length + GetElement
            length = int(raw_array.Length)
            children: list[ElementInfo] = []
            count = 0
            for i in range(min(length, limit)):
                child = raw_array.GetElement(i)
                snap = self._snapshot(child)
                if snap is not None:
                    children.append(snap)
                count += 1
            return children
        except Exception as exc:
            logger.warning("read_children 失败: %s", exc)
            return []

    def inspect_point(self, x: int, y: int) -> dict[str, Any]:
        """综合检查 (x, y) 处元素（含 patterns/bbox）。"""
        elem = self.element_at(x, y)
        if elem is None:
            return {"ok": False, "error": "无元素或 UIA 不可用", "point": {"x": x, "y": y}}
        return {"ok": True, "element": elem, "point": {"x": x, "y": y}}

    # ---- 内部辅助 --------------------------------------------------------
    def _build_condition(self, selector: dict[str, Any]) -> Any:
        """构造 UIA 查询条件。

        UIA Property IDs（Microsoft 官方）:
          30003 = ControlTypeProperty
          30005 = NameProperty
          30011 = AutomationIdProperty
          30012 = ClassNameProperty
        """
        try:
            uia = self._uia
            conds: list[Any] = []
            if "control_type" in selector:
                ct_id = self._control_type_id_by_name.get(selector["control_type"])
                if ct_id is not None:
                    conds.append(uia.CreatePropertyCondition(30003, ct_id))
            if "automation_id" in selector:
                conds.append(uia.CreatePropertyCondition(30011, selector["automation_id"]))
            if "name" in selector:
                conds.append(uia.CreatePropertyCondition(30005, selector["name"]))
            if "class_name" in selector:
                conds.append(uia.CreatePropertyCondition(30012, selector["class_name"]))
            if not conds:
                return uia.CreateTrueCondition()
            if len(conds) == 1:
                return conds[0]
            return uia.CreateAndCondition(*conds)
        except Exception as exc:
            logger.warning("_build_condition 失败: %s", exc)
            return None

    def _walk(
        self,
        root: Any,
        walker: Any,
        out: list[ElementInfo],
        top_only: bool,
        limit: int,
        depth: int,
    ) -> None:
        """深度优先遍历 UIA 树。"""
        if len(out) >= limit:
            return
        try:
            child = walker.GetFirstChildElement(root)
        except Exception:
            child = None
        while child is not None and len(out) < limit:
            snap = self._snapshot(child)
            if snap is not None:
                out.append(snap)
            if not top_only and depth < 5:  # 限制深度防爆栈
                self._walk(child, walker, out, top_only, limit, depth + 1)
            try:
                child = walker.GetNextSiblingElement(child)
            except Exception:
                break

    def _snapshot(self, elem: Any) -> Optional[ElementInfo]:
        """把 UIA 元素快照为 ElementInfo dict（含 __ref 供 invoke 复用）。"""
        try:
            # Current* 属性走缓存，避免 RPC 开销
            rect = elem.CurrentBoundingRectangle
            bbox = [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)]
            patterns = self._detect_patterns(elem)
            info: ElementInfo = ElementInfo(
                name=elem.CurrentName or "",
                automation_id=elem.CurrentAutomationId or "",
                control_type=self._control_type_name_map.get(elem.CurrentControlType, "Unknown"),
                class_name=elem.CurrentClassName or "",
                bbox=bbox,
                patterns=patterns,
                is_enabled=bool(elem.CurrentIsEnabled),
                is_offscreen=bool(elem.CurrentIsOffscreen),
                process_name="",
            )
            # 保留元素引用供 invoke() 复用（不序列化，仅供本进程内调用）
            info["__ref"] = elem
            return info
        except Exception as exc:
            logger.debug("_snapshot 失败: %s", exc)
            return None

    def _detect_patterns(self, elem: Any) -> list[str]:
        """检测元素支持的 pattern。

        用 GetCurrentPattern + QueryInterface 实际尝试转换到具体 pattern 接口。
        这样 patterns 字段反映的是「实际能否成功调用该 pattern」,与 invoke/set_value
        等方法的实际行为一致,不会误报也不会漏报。

        comtypes 的 GetCurrentPattern 即使元素不支持 pattern 也可能返回非空 IUnknown 指针,
        但 QueryInterface 到具体接口时会失败(返回 None 或抛异常),以此作为判断依据。
        """
        supported: list[str] = []
        # (pattern 名, pattern ID, 接口类名)
        # 延迟 import 避免非 Windows 环境报错
        try:
            from comtypes.gen.UIAutomationClient import (
                IUIAutomationInvokePattern,
                IUIAutomationValuePattern,
                IUIAutomationTogglePattern,
                IUIAutomationSelectionItemPattern,
                IUIAutomationExpandCollapsePattern,
                IUIAutomationScrollItemPattern,
                IUIAutomationTextPattern,
                IUIAutomationRangeValuePattern,
                IUIAutomationGridItemPattern,
                IUIAutomationTableItemPattern,
            )
        except ImportError:
            return supported

        candidates = [
            ("Invoke", 10000, IUIAutomationInvokePattern),
            ("Value", 10002, IUIAutomationValuePattern),
            ("Toggle", 10015, IUIAutomationTogglePattern),
            ("SelectionItem", 10010, IUIAutomationSelectionItemPattern),
            ("ExpandCollapse", 10005, IUIAutomationExpandCollapsePattern),
            ("ScrollItem", 10017, IUIAutomationScrollItemPattern),
            ("Text", 10020, IUIAutomationTextPattern),
            ("RangeValue", 10003, IUIAutomationRangeValuePattern),
            ("GridItem", 10007, IUIAutomationGridItemPattern),
            ("TableItem", 10013, IUIAutomationTableItemPattern),
        ]
        for name, pid, iface in candidates:
            try:
                unk = elem.GetCurrentPattern(pid)
                if not unk:
                    continue
                # QueryInterface 实际尝试转换到具体接口
                # 成功 = 元素真正支持该 pattern;失败 = 不支持
                pat = unk.QueryInterface(iface)
                if pat:
                    supported.append(name)
            except Exception:
                pass
        return supported

    def _control_type_name(self, ct_id: int) -> str:
        """ControlTypeId → 名字（反查，由初始化时构造）。"""
        return self._control_type_name_map.get(ct_id, f"Unknown({ct_id})")


# 模块级单例：visual_loop / stdio_worker 共用
_default_instance: Optional[UiaController] = None


def get_uia_controller() -> UiaController:
    """获取共享 UiaController 单例。"""
    global _default_instance
    if _default_instance is None:
        _default_instance = UiaController()
    return _default_instance
