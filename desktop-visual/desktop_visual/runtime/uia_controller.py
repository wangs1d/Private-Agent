"""Windows UIAutomation 封装（pywinauto）。

仅 Windows 可用；其他平台 / import 失败时所有方法安全降级。
UiaController 采取懒加载策略：首次调用 UIA API 时才 import pywinauto。

设计要点：
- 坐标兜底：element_at(x, y) 用 IUIAutomation.ElementFromPoint 拿元素
- 结构化查询：query(selector) 按 name/automation_id/control_type 组合查询
- DPI 处理：VLM 输出物理坐标，UIA 需逻辑坐标，_to_logical_point 内部转换
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
        """VLM 物理坐标 → UIA 逻辑坐标（除以 DPI 缩放比）。"""
        return int(x / self._dpi_scale), int(y / self._dpi_scale)

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
            invoke_pat = ref.GetPattern(10000)  # UIA_InvokePatternId = 10000
            if invoke_pat:
                invoke_pat.Invoke()
                return True
        except Exception as exc:
            logger.warning("invoke 失败: %s", exc)
        return False

    # ---- 结构化查询 ------------------------------------------------------
    def query(self, selector: dict[str, Any], *, top_only: bool = True, limit: int = 100) -> list[ElementInfo]:
        """按 selector 条件查询元素。

        selector 字段：
        - name: 元素 Name（精确匹配）
        - name_contains: Name 子串匹配
        - automation_id: AutomationId（精确）
        - control_type: 控件类型，如 Button/Edit/List/List/ListItem/Tree/TreeItem
        - class_name: ClassName
        - parent: 父元素 __ref（可选，限定查询范围）
        """
        if not self.is_available():
            return []
        try:
            # 用纯 IUIAutomation API 走 UIA 树（pywinauto 0.6.x 没有 uia_element_infos 子模块）
            root = self._uia.GetRootElement() if selector.get("parent") is None else selector["parent"]
            condition = self._build_condition(selector)
            if condition is None:
                return []
            walker = self._uia.CreateTreeWalker(condition)
            results: list[ElementInfo] = []
            self._walk(root, walker, results, top_only, limit, depth=0)
            return results
        except Exception as exc:
            logger.warning("query(%r) 失败: %s", selector, exc)
            return []

    def read_children(self, parent_ref: Any, *, limit: int = 200) -> list[ElementInfo]:
        """读元素直接子节点（用于 ListView/Tree 内容读取）。"""
        if not self.is_available() or parent_ref is None:
            return []
        try:
            children: list[ElementInfo] = []
            child = parent_ref.GetFirstChildElement()
            count = 0
            while child is not None and count < limit:
                snap = self._snapshot(child)
                if snap is not None:
                    children.append(snap)
                child = child.GetNextSiblingElement()
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
        """构造 UIA 查询条件。"""
        try:
            uia = self._uia
            conds: list[Any] = []
            if "control_type" in selector:
                ct_id = self._control_type_id_by_name.get(selector["control_type"])
                if ct_id is not None:
                    conds.append(uia.CreatePropertyCondition(30003, ct_id))  # UIA_ControlTypePropertyId
            if "automation_id" in selector:
                conds.append(uia.CreatePropertyCondition(30011, selector["automation_id"]))  # AutomationIdProperty
            if "name" in selector:
                conds.append(uia.CreatePropertyCondition(30012, selector["name"]))  # NameProperty
            if "class_name" in selector:
                # UIA 没有独立的 ClassName PropertyId，需要配合 NativeWindowHandle 或其他条件，这里简化跳过
                logger.debug("class_name 条件暂不支持，忽略")
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
        """检测元素支持的 pattern（仅列常用：Invoke/SelectionItem/Value/Toggle/ExpandCollapse/ScrollItem）。"""
        supported: list[str] = []
        candidates = [
            ("Invoke", 10000),
            ("SelectionItem", 10010),
            ("Value", 10002),
            ("Toggle", 10015),
            ("ExpandCollapse", 10005),
            ("ScrollItem", 10017),
            ("Text", 10020),
            ("RangeValue", 10003),
            ("GridItem", 10007),
            ("TableItem", 10013),
        ]
        for name, pid in candidates:
            try:
                if elem.GetPattern(pid) is not None:
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
