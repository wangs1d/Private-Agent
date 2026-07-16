//! Win32 API 辅助函数
//!
//! 对应原 sphere-overlay/win32-desk-pet.cjs：
//! - apply_desk_pet_shell: 关闭 Win11 圆角矩形外框
//! - set_click_through: 鼠标点击穿透切换（WS_EX_TRANSPARENT）
//! - get_work_area_for_hwnd: 通过 HWND 获取所在显示器工作区

#![cfg(target_os = "windows")]

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTONEAREST, MONITORINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT,
};

/// 关闭 Win11 圆角矩形外框，避免「透明卡片」感。
/// 对应 main.cjs applyDeskPetShell()。
pub fn apply_desk_pet_shell(hwnd: HWND) -> bool {
    unsafe {
        let corner_pref: u32 = DWMWCP_DONOTROUND.0 as u32;
        let result = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner_pref as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
        result.is_ok()
    }
}

/// 设置鼠标点击穿透。
///
/// 对应 Electron `setIgnoreMouseEvents(true, { forward: true })`：
/// - ignore=true  → 添加 WS_EX_TRANSPARENT，鼠标事件穿透到下层
/// - ignore=false → 移除 WS_EX_TRANSPARENT，窗口正常接收事件
///
/// 注意：Electron 的 `forward: true` 会让鼠标移动事件仍转发到窗口（用于检测
/// 鼠标离开/进入角色区域）。Tauri 原生不支持此行为，需要由渲染层
/// （EmbedDragSurface / OverlayQuickMenu）通过 mousemove 事件 + set_position
/// 主动切换 ignore 状态来模拟。avatar 已实现此模式。
pub fn set_click_through(hwnd: HWND, ignore: bool) -> bool {
    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

        let new_style = if ignore {
            ex_style | (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize
        } else {
            // 移除 WS_EX_TRANSPARENT，保留 WS_EX_LAYERED（透明窗口必须）
            ex_style & !(WS_EX_TRANSPARENT.0 as isize)
        };

        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
        true
    }
}

/// 获取 HWND 所在显示器的工作区（排除任务栏）。
/// 对应 main.cjs `screen.getDisplayMatching(bounds).workArea`。
///
/// 返回 (x, y, width, height)。
pub fn get_work_area_for_hwnd(hwnd: HWND) -> (i32, i32, i32, i32) {
    unsafe {
        let hmonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(hmonitor, &mut info).as_bool() {
            let rc = info.rcWork;
            return (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top);
        }
        // Fallback：调用失败，返回一个合理默认值
        (0, 0, 1920, 1080)
    }
}
