//! Sphere Overlay - Tauri 实现
//!
//! 对应 sphere-overlay/main.cjs 的完整功能：
//! - 透明无框置顶窗口
//! - Win11 圆角关闭 + 鼠标穿透
//! - IPC 命令（moveTo/moveBy/setPosition 等）
//! - 系统托盘菜单
//! - 日程悬浮窗（独立窗口）
//! - 单实例锁 + 命令参数
//! - mood 文件轮询推送 patch 事件

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod win32;

#[cfg(target_os = "windows")]
use win32::{apply_desk_pet_shell, get_work_area_for_hwnd, set_click_through};

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

// ===== 常量 =====

/// 3D 桌宠主窗口尺寸（对应 main.cjs PET_WIDTH / PET_HEIGHT）
const PET_WIDTH: i32 = 186;
const PET_HEIGHT: i32 = 232;
/// 菜单展开时增加的宽度
const MENU_WIDTH: i32 = 204;

/// 日程悬浮窗尺寸（对应 main.cjs SCHEDULE_*）
const SCHEDULE_WIDTH: i32 = 280;
const SCHEDULE_HEIGHT_COLLAPSED: i32 = 48;
const SCHEDULE_HEIGHT_EXPANDED: i32 = 340;
const SCHEDULE_WIDTH_COLLAPSED: i32 = 200;

const MAIN_LABEL: &str = "main";
const SCHEDULE_LABEL: &str = "schedule";

// ===== 状态 =====

#[derive(Default)]
struct AppState {
    /// 主窗口菜单是否展开（控制 setMenuExpanded 时窗口宽度）
    menu_expanded: AtomicBool,
}

// ===== 类型 =====

#[derive(Serialize, Deserialize, Clone)]
struct WorkArea {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Serialize, Deserialize, Clone)]
struct WindowPosition {
    x: i32,
    y: i32,
}

// ===== Preload 脚本 =====

/// 注入到 WebView 的初始化脚本，构造 `window.sphereOverlay` 对象。
/// 对应 sphere-overlay/preload.cjs。
///
/// 兼容性：avatar 调用 `window.sphereOverlay?.method?.()`，全部方法可选。
const PRELOAD_SCRIPT: &str = r#"
(function () {
  function setupSphereOverlay() {
    var api = (window.__TAURI__) || (window.__TAURI_INTERNALS__);
    if (!api || (!api.core && !api.invoke)) {
      // Tauri 全局未就绪，重试
      setTimeout(setupSphereOverlay, 30);
      return;
    }
    var invokeFn = api.core ? api.core.invoke : api.invoke;
    var listenFn = api.core ? (api.event ? api.event.listen : null) : (api.event ? api.event.listen : null);

    function invoke(cmd, args) {
      try {
        return invokeFn(cmd, args);
      } catch (e) {
        console.warn('[sphereOverlay] invoke failed:', cmd, e);
        return Promise.reject(e);
      }
    }

    window.sphereOverlay = {
      getWorkArea: function () {
        return invoke('get_work_area');
      },
      moveTo: function (x, y, animateMs) {
        return invoke('move_to', { x: x, y: y, durationMs: animateMs || 0 });
      },
      moveBy: function (dx, dy) {
        return invoke('move_by', { dx: dx, dy: dy });
      },
      setPosition: function (x, y) {
        return invoke('set_position', { x: x, y: y });
      },
      getPosition: function () {
        return invoke('get_position');
      },
      setIgnoreMouseEvents: function (ignore, forward) {
        return invoke('set_ignore_mouse_events', { ignore: !!ignore, forward: !!forward });
      },
      setMenuExpanded: function (expanded) {
        return invoke('set_menu_expanded', { expanded: !!expanded });
      },
      setScheduleCollapsed: function (collapsed) {
        return invoke('set_schedule_collapsed', { collapsed: !!collapsed });
      },
      onPatch: function (cb) {
        if (!listenFn) return function () {};
        var unlisten = null;
        listenFn('sphere-overlay:patch', function (event) {
          try { cb(event.payload); } catch (e) { console.warn('[sphereOverlay] onPatch cb error:', e); }
        }).then(function (fn) { unlisten = fn; });
        return function () { if (unlisten) unlisten(); };
      },
      onRoam: function (cb) {
        if (!listenFn) return function () {};
        var unlisten = null;
        listenFn('sphere-overlay:roam', function () {
          try { cb(); } catch (e) { console.warn('[sphereOverlay] onRoam cb error:', e); }
        }).then(function (fn) { unlisten = fn; });
        return function () { if (unlisten) unlisten(); };
      }
    };
    console.log('[sphereOverlay] ready');
  }
  setupSphereOverlay();
})();
"#;

// ===== URL 构建 =====

/// 构建主窗口 overlay.html 的 URL。
/// 对应 main.cjs loadOverlayPage()。
fn build_overlay_url(
    base_url: Option<&str>,
    ws: &str,
    session_id: &str,
    _http_base: &str,
) -> String {
    let mut query = vec![("ws".to_string(), ws.to_string())];
    if !session_id.is_empty() {
        query.push(("sessionId".to_string(), session_id.to_string()));
    }
    query.push(("petW".to_string(), PET_WIDTH.to_string()));
    query.push(("petH".to_string(), PET_HEIGHT.to_string()));

    let query_str = query
        .into_iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(&v)))
        .collect::<Vec<_>>()
        .join("&");

    if let Some(dev_url) = base_url {
        // 开发模式：直接拼接 dev server URL
        let mut url = url::Url::parse(dev_url).unwrap_or_else(|_| {
            url::Url::parse("http://localhost:5180/overlay.html").unwrap()
        });
        url.query_pairs_mut()
            .append_pair("ws", ws)
            .append_pair("petW", &PET_WIDTH.to_string())
            .append_pair("petH", &PET_HEIGHT.to_string());
        if !session_id.is_empty() {
            url.query_pairs_mut().append_pair("sessionId", session_id);
        }
        url.to_string()
    } else {
        // 生产：相对路径，由 Tauri 从 frontendDist 提供
        format!("overlay.html?{}", query_str)
    }
}

/// 构建日程悬浮窗 schedule-floating.html 的 URL
fn build_schedule_url(
    base_url: Option<&str>,
    ws: &str,
    session_id: &str,
    http_base: &str,
) -> String {
    let mut query = vec![("ws".to_string(), ws.to_string()), ("httpBase".to_string(), http_base.to_string())];
    if !session_id.is_empty() {
        query.push(("sessionId".to_string(), session_id.to_string()));
    }

    let query_str = query
        .into_iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");

    if let Some(dev_url) = base_url {
        let mut url = url::Url::parse(dev_url).unwrap_or_else(|_| {
            url::Url::parse("http://localhost:5180/schedule-floating.html").unwrap()
        });
        url.query_pairs_mut().append_pair("ws", ws);
        url.query_pairs_mut().append_pair("httpBase", http_base);
        if !session_id.is_empty() {
            url.query_pairs_mut().append_pair("sessionId", session_id);
        }
        url.to_string()
    } else {
        format!("schedule-floating.html?{}", query_str)
    }
}

// ===== 命令参数解析 =====

fn read_command_arg(args: &Vec<String>) -> String {
    for arg in args {
        if let Some(value) = arg.strip_prefix("--pai-command=") {
            return value.to_string();
        }
    }
    String::new()
}

// ===== 窗口创建 =====

/// 创建主桌宠窗口
fn create_main_window(app: &AppHandle, dev_url: Option<&str>) -> tauri::Result<WebviewWindow> {
    let ws = std::env::var("PAI_WS_URL").unwrap_or_else(|_| "ws://127.0.0.1:3000/ws".to_string());
    let session_id = std::env::var("PAI_SESSION_ID").unwrap_or_default();
    let http_base = std::env::var("PAI_HTTP_BASE")
        .unwrap_or_else(|_| "http://127.0.0.1:3000".to_string());

    let url = build_overlay_url(dev_url, &ws, &session_id, &http_base);

    // 计算初始位置：右下角，距边缘 24px
    let (init_x, init_y) = get_initial_position(app);

    let window = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App(url.into()))
        .title("Sphere Overlay")
        .inner_size(PET_WIDTH as f64, PET_HEIGHT as f64)
        .position(init_x as f64, init_y as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false) // ready-to-show 后再显示
        .initialization_script(PRELOAD_SCRIPT)
        .build()?;

    // Win11 圆角关闭 + 始终置顶层级
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            // hwnd 已是 windows::Win32::Foundation::HWND 类型
            apply_desk_pet_shell(hwnd);
        }
        // 设置为 screen-saver 级别的置顶（对应 Electron alwaysOnTop: 'screen-saver'）
        let _ = window.set_always_on_top(true);
    }

    // 显示窗口
    window.show()?;
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            // hwnd 已是 windows::Win32::Foundation::HWND 类型
            set_click_through(hwnd, true); // 默认穿透
        }
    }

    Ok(window)
}

/// 创建日程悬浮窗
fn create_schedule_window(app: &AppHandle, dev_url: Option<&str>) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(SCHEDULE_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }

    let ws = std::env::var("PAI_WS_URL").unwrap_or_else(|_| "ws://127.0.0.1:3000/ws".to_string());
    let session_id = std::env::var("PAI_SESSION_ID").unwrap_or_default();
    let http_base = std::env::var("PAI_HTTP_BASE")
        .unwrap_or_else(|_| "http://127.0.0.1:3000".to_string());

    let url = build_schedule_url(dev_url, &ws, &session_id, &http_base);

    // 默认位置：屏幕右上角
    let (init_x, init_y) = get_schedule_initial_position(app);

    let window = WebviewWindowBuilder::new(app, SCHEDULE_LABEL, WebviewUrl::App(url.into()))
        .title("Schedule")
        .inner_size(SCHEDULE_WIDTH as f64, SCHEDULE_HEIGHT_EXPANDED as f64)
        .position(init_x as f64, init_y as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(true)
        .visible(false)
        .initialization_script(PRELOAD_SCRIPT)
        .build()?;

    let _ = window.set_always_on_top(true);
    window.show()?;

    Ok(window)
}

/// 获取主窗口初始位置（屏幕右下角）
fn get_initial_position(app: &AppHandle) -> (i32, i32) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        if let Ok(pos) = window.outer_position() {
            return (pos.x, pos.y);
        }
    }
    // 右下角，距边缘 24px
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let w = (size.width as f64 / scale) as i32;
        let h = (size.height as f64 / scale) as i32;
        (w - PET_WIDTH - 24, h - PET_HEIGHT - 24)
    } else {
        (1920 - PET_WIDTH - 24, 1080 - PET_HEIGHT - 24)
    }
}

/// 获取日程悬浮窗初始位置（屏幕右上角）
fn get_schedule_initial_position(app: &AppHandle) -> (i32, i32) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let w = (size.width as f64 / scale) as i32;
        let x = w - SCHEDULE_WIDTH - 24;
        (x, 24)
    } else {
        (1920 - SCHEDULE_WIDTH - 24, 24)
    }
}

/// 钳制位置到工作区内（对应 main.cjs clampMainBounds）
fn clamp_main_bounds(app: &AppHandle, x: i32, y: i32, width: i32, height: i32) -> (i32, i32) {
    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
            if let Ok(hwnd) = window.hwnd() {
                // hwnd 已是 windows::Win32::Foundation::HWND 类型
                let (ax, ay, aw, ah) = get_work_area_for_hwnd(hwnd);
                let max_x = ax + (aw - width).max(0);
                let max_y = ay + (ah - height).max(0);
                return (
                    x.min(max_x).max(ax),
                    y.min(max_y).max(ay),
                );
            }
        }
    }
    // Fallback：使用主显示器尺寸（无任务栏排除）
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let aw = (size.width as f64 / scale) as i32;
        let ah = (size.height as f64 / scale) as i32;
        let max_x = (aw - width).max(0);
        let max_y = (ah - height).max(0);
        return (x.min(max_x).max(0), y.min(max_y).max(0));
    }
    (x, y)
}

// ===== 动画移动（对应 main.cjs animateMove）=====

fn animate_move(app: AppHandle, target_x: i32, target_y: i32, duration_ms: u64) {
    let window = match app.get_webview_window(MAIN_LABEL) {
        Some(w) => w,
        None => return,
    };
    let start = match window.outer_position() {
        Ok(p) => p,
        Err(_) => return,
    };
    let width = PET_WIDTH;
    let height = PET_HEIGHT;
    let (clamped_x, clamped_y) = clamp_main_bounds(&app, target_x, target_y, width, height);
    let start_x = start.x;
    let start_y = start.y;
    let start_at = Instant::now();
    let duration = Duration::from_millis(duration_ms);

    tauri::async_runtime::spawn(async move {
        loop {
            let elapsed = start_at.elapsed();
            if elapsed >= duration {
                let _ = window.set_position(PhysicalPosition::new(clamped_x, clamped_y));
                return;
            }
            let t = elapsed.as_secs_f64() / duration.as_secs_f64();
            // easeInOutQuad
            let ease = if t < 0.5 {
                2.0 * t * t
            } else {
                1.0 - ((-2.0 * t + 2.0).powi(2)) / 2.0
            };
            let x = (start_x as f64 + (clamped_x - start_x) as f64 * ease).round() as i32;
            let y = (start_y as f64 + (clamped_y - start_y) as f64 * ease).round() as i32;
            let _ = window.set_position(PhysicalPosition::new(x, y));
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
    });
}

// ===== IPC 命令 =====

#[tauri::command]
fn get_work_area(app: AppHandle) -> Result<WorkArea, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
            if let Ok(hwnd) = window.hwnd() {
                // hwnd 已是 windows::Win32::Foundation::HWND 类型
                let (x, y, w, h) = get_work_area_for_hwnd(hwnd);
                return Ok(WorkArea { x, y, width: w, height: h });
            }
        }
    }
    // Fallback
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();
        return Ok(WorkArea {
            x: pos.x,
            y: pos.y,
            width: (size.width as f64 / scale) as i32,
            height: (size.height as f64 / scale) as i32,
        });
    }
    Err("no monitor".to_string())
}

#[tauri::command]
fn move_to(app: AppHandle, x: i32, y: i32, duration_ms: Option<u64>) {
    let duration = duration_ms.unwrap_or(0);
    if duration == 0 {
        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
            let (cx, cy) = clamp_main_bounds(&app, x, y, PET_WIDTH, PET_HEIGHT);
            let _ = window.set_position(PhysicalPosition::new(cx, cy));
        }
    } else {
        animate_move(app, x, y, duration);
    }
}

#[tauri::command]
fn move_by(app: AppHandle, window: WebviewWindow, dx: i32, dy: i32) {
    // 通过 window 参数自动识别调用者（主窗口或日程窗）
    if let Ok(pos) = window.outer_position() {
        let new_x = pos.x + dx;
        let new_y = pos.y + dy;
        if window.label() == MAIN_LABEL {
            let (cx, cy) = clamp_main_bounds(&app, new_x, new_y, PET_WIDTH, PET_HEIGHT);
            let _ = window.set_position(PhysicalPosition::new(cx, cy));
        } else {
            let _ = window.set_position(PhysicalPosition::new(new_x, new_y));
        }
    }
}

#[tauri::command]
fn set_position(app: AppHandle, window: WebviewWindow, x: i32, y: i32) {
    if window.label() == MAIN_LABEL {
        let (cx, cy) = clamp_main_bounds(&app, x, y, PET_WIDTH, PET_HEIGHT);
        let _ = window.set_position(PhysicalPosition::new(cx, cy));
    } else {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

#[tauri::command]
fn get_position(window: WebviewWindow) -> Result<WindowPosition, String> {
    window
        .outer_position()
        .map(|p| WindowPosition { x: p.x, y: p.y })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_ignore_mouse_events(window: WebviewWindow, ignore: bool, _forward: bool) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            // hwnd 已是 windows::Win32::Foundation::HWND 类型
            set_click_through(hwnd, ignore);
        }
    }
    // Tauri 原生 API 作为后备（语义略有差异，但保证基本可用）
    let _ = window.set_ignore_cursor_events(ignore);
}

#[tauri::command]
fn set_menu_expanded(app: AppHandle, state: tauri::State<'_, AppState>, expanded: bool) {
    state.menu_expanded.store(expanded, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let width = if expanded { PET_WIDTH + MENU_WIDTH } else { PET_WIDTH };
        if let Ok(pos) = window.outer_position() {
            let (cx, cy) = clamp_main_bounds(&app, pos.x, pos.y, width, PET_HEIGHT);
            let _ = window.set_size(PhysicalSize::new(width, PET_HEIGHT));
            let _ = window.set_position(PhysicalPosition::new(cx, cy));
        }
    }
}

#[tauri::command]
fn set_schedule_collapsed(window: WebviewWindow, collapsed: bool) {
    if window.label() != SCHEDULE_LABEL {
        return;
    }
    let target_height = if collapsed {
        SCHEDULE_HEIGHT_COLLAPSED
    } else {
        SCHEDULE_HEIGHT_EXPANDED
    };
    let target_width = if collapsed {
        SCHEDULE_WIDTH_COLLAPSED
    } else {
        SCHEDULE_WIDTH
    };
    if let Ok(pos) = window.outer_position() {
        let _ = window.set_size(PhysicalSize::new(target_width, target_height));
        let _ = window.set_position(PhysicalPosition::new(pos.x, pos.y));
    }
    // 折叠后保证可交互（不穿透）
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            // hwnd 已是 windows::Win32::Foundation::HWND 类型
            set_click_through(hwnd, false);
        }
    }
    let _ = window.set_ignore_cursor_events(false);
}

// ===== 命令处理（单实例二次启动）=====

fn handle_command(app: &AppHandle, command: &str, dev_url: Option<&str>) {
    match command {
        "" => {
            if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "close" => {
            app.exit(0);
        }
        "roam" => {
            let _ = app.emit_to(MAIN_LABEL, "sphere-overlay:roam", ());
        }
        "show" => {
            if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                let _ = window.show();
                #[cfg(target_os = "windows")]
                {
                    if let Ok(hwnd) = window.hwnd() {
                        // hwnd 已是 windows::Win32::Foundation::HWND 类型
                        apply_desk_pet_shell(hwnd);
                    }
                }
            }
        }
        "schedule" | "schedule:toggle" => {
            if let Some(window) = app.get_webview_window(SCHEDULE_LABEL) {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            } else {
                let _ = create_schedule_window(app, dev_url);
            }
        }
        "schedule:show" => {
            if let Some(window) = app.get_webview_window(SCHEDULE_LABEL) {
                let _ = window.show();
            } else {
                let _ = create_schedule_window(app, dev_url);
            }
        }
        "schedule:hide" => {
            if let Some(window) = app.get_webview_window(SCHEDULE_LABEL) {
                let _ = window.hide();
            }
        }
        _ => {}
    }
}

// ===== mood 文件轮询（对应 main.cjs setInterval 250ms）=====

fn start_mood_polling(app: AppHandle) {
    let mood_file = std::env::var("PAI_MOOD_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let temp = std::env::temp_dir();
            temp.join("pai-sphere-mood.json")
        });

    tauri::async_runtime::spawn(async move {
        let mut last_raw = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;

            if !mood_file.exists() {
                continue;
            }
            let raw = match std::fs::read_to_string(&mood_file) {
                Ok(content) => content,
                Err(_) => continue,
            };
            if raw.is_empty() || raw == last_raw {
                continue;
            }
            last_raw = raw.clone();

            match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(patch) => {
                    let _ = app.emit_to(MAIN_LABEL, "sphere-overlay:patch", patch);
                }
                Err(_) => continue,
            }
        }
    });
}

// ===== 托盘菜单 =====

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let toggle_main = MenuItemBuilder::with_id("toggle_main", "显示/隐藏 桌宠")
        .build(app)?;
    let toggle_schedule = MenuItemBuilder::with_id("toggle_schedule", "显示/隐藏 日程悬浮窗")
        .build(app)?;
    let roam = MenuItemBuilder::with_id("roam", "随机漫游").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&toggle_main)
        .item(&toggle_schedule)
        .item(&roam)
        .item(&separator)
        .item(&quit)
        .build()?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Agent 桌宠")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle_main" => {
                if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                    }
                }
            }
            "toggle_schedule" => {
                if let Some(window) = app.get_webview_window(SCHEDULE_LABEL) {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                    }
                } else {
                    let dev_url = std::env::var("PAI_OVERLAY_DEV_URL").ok();
                    let _ = create_schedule_window(app, dev_url.as_deref());
                }
            }
            "roam" => {
                let _ = app.emit_to(MAIN_LABEL, "sphere-overlay:roam", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

// ===== 主入口 =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dev_url = std::env::var("PAI_OVERLAY_DEV_URL").ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 二次启动：转发命令到已有实例
            let command = read_command_arg(&args);
            let dev_url = std::env::var("PAI_OVERLAY_DEV_URL").ok();
            handle_command(app, &command, dev_url.as_deref());
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_work_area,
            move_to,
            move_by,
            set_position,
            get_position,
            set_ignore_mouse_events,
            set_menu_expanded,
            set_schedule_collapsed,
        ])
        .setup(move |app| {
            // 解析初始命令
            let args: Vec<String> = std::env::args().collect();
            let initial_command = read_command_arg(&args);

            let is_schedule_only = matches!(
                initial_command.as_str(),
                "schedule" | "schedule:show" | "schedule:hide" | "schedule:toggle"
            );

            if !is_schedule_only {
                create_main_window(app.handle(), dev_url.as_deref())?;
            }

            // 启动托盘
            setup_tray(app.handle())?;

            // 启动 mood 文件轮询
            start_mood_polling(app.handle().clone());

            // 处理初始命令
            if !initial_command.is_empty() {
                handle_command(app.handle(), &initial_command, dev_url.as_deref());
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running sphere-overlay-tauri");
}
