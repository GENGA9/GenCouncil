// GenCouncil desktop: tray-resident window around the local web console.
// The server itself runs as the "GenCouncilWeb" logon task (gencouncil service); this app
// only starts that task when nothing listens yet, and never stops the server when it quits.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Deserialize)]
struct ServerConfig {
    token: String,
    port: u16,
}

fn home() -> PathBuf {
    std::env::var("GENCOUNCIL_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".gencouncil"))
}

fn read_config() -> Option<ServerConfig> {
    let text = fs::read_to_string(home().join("server.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn port() -> u16 {
    read_config().map(|c| c.port).unwrap_or(7700)
}

fn server_up(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}").parse().unwrap();
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn cli_path() -> String {
    std::env::var("GENCOUNCIL_CLI").unwrap_or_else(|_| env!("GENCOUNCIL_CLI_DEFAULT").to_string())
}

/// `node <cli.js> <args>` with no console window; waits for it to finish.
fn cli(args: &[&str]) -> bool {
    let mut cmd = Command::new("node");
    cmd.arg(cli_path()).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn wait_up(port: u16, tries: u32) -> bool {
    for _ in 0..tries {
        if server_up(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    server_up(port)
}

/// Start the logon task when nothing listens; fall back to a detached `gencouncil web`.
fn ensure_server() -> bool {
    let p = port();
    if server_up(p) {
        return true;
    }
    if cli(&["service", "start"]) && wait_up(p, 20) {
        return true;
    }
    let mut cmd = Command::new("node");
    cmd.arg(cli_path()).arg("web").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_0008); // CREATE_NO_WINDOW | DETACHED_PROCESS
    }
    let _ = cmd.spawn();
    wait_up(p, 60)
}

fn console_url() -> Option<tauri::Url> {
    let c = read_config()?;
    let token: String = c
        .token
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("http://localhost:{}/auth?token={}", c.port, token).parse().ok()
}

fn splash_url() -> tauri::Url {
    let u = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    u.parse().unwrap()
}

fn set_status(app: &AppHandle, text: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("var s=document.getElementById('s'); if(s) s.textContent={};", serde_json::to_string(text).unwrap());
        let _ = w.eval(&js);
    }
}

/// Bring the console up in the main window (in the background: starting the task can take seconds).
fn connect(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if !ensure_server() {
            set_status(&app, "서버를 시작하지 못했어요. 트레이 메뉴의 '서버 재시작'을 눌러 보세요.");
            return;
        }
        match (console_url(), app.get_webview_window("main")) {
            (Some(url), Some(w)) => {
                let _ = w.navigate(url);
            }
            _ => set_status(&app, "~/.gencouncil/server.json을 읽지 못했어요."),
        }
    });
}

// ---- floating chair -------------------------------------------------------------------------
// When the main window is closed into the tray (and the tray's "닫으면 플로팅 의장 띄우기" is on),
// a small transparent, always-on-top window ("float", the console's /?float=1 page) keeps the
// chair's bust on the desktop until the main window comes back. Minimizing only minimizes.
// Whatever view the main console shows: the float page fetches the chair's words and the members'
// reports itself (only the avatar view's short event lines come from the main window).

const FLOAT_W: f64 = 300.0;
const FLOAT_H: f64 = 420.0;

#[derive(Serialize, Deserialize, Clone)]
struct FloatPrefs {
    /// show the float when the main window is closed into the tray (on by default: it is what the
    /// floating chair is for, and one right click on it turns it off for good)
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
}

fn yes() -> bool {
    true
}

impl Default for FloatPrefs {
    fn default() -> Self {
        FloatPrefs { enabled: true, x: None, y: None }
    }
}

#[derive(Default)]
struct FloatState {
    prefs: Mutex<FloatPrefs>,
    /// whether the float window should be on screen now (we show and hide it ourselves, see `float_visible`)
    shown: AtomicBool,
}

// Win32 straight from user32 (no extra crate): tao's `show()` is ShowWindow(SW_SHOW), which makes the
// window the active one and takes the keyboard from whatever the user was in when the main window went
// down. The float window is shown with SW_SHOWNOACTIVATE instead; it is still an ordinary window, so a
// click on it (the 💬 input box) activates it and the keys go there.
#[cfg(windows)]
mod win {
    #[link(name = "user32")]
    extern "system" {
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        #[cfg(debug_assertions)]
        fn GetForegroundWindow() -> isize;
    }
    const SW_HIDE: i32 = 0;
    const SW_SHOWNOACTIVATE: i32 = 4;

    pub fn show(hwnd: isize, on: bool) {
        unsafe {
            ShowWindow(hwnd, if on { SW_SHOWNOACTIVATE } else { SW_HIDE });
        }
    }

    /// (for the debug log: which window has the keyboard before and after)
    #[cfg(debug_assertions)]
    pub fn foreground() -> isize {
        unsafe { GetForegroundWindow() }
    }
}

/// Show or hide the float window. On Windows this bypasses tao, so tao keeps thinking the window is
/// hidden; the only tao path that then hides it behind our back is a DPI change (see on_window_event).
fn float_visible(w: &WebviewWindow, on: bool) {
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        #[cfg(debug_assertions)]
        let before = win::foreground();
        win::show(h.0 as isize, on);
        #[cfg(debug_assertions)]
        eprintln!("[float] {} hwnd={} foreground before={} after={}", if on { "show" } else { "hide" }, h.0 as isize, before, win::foreground());
        return;
    }
    let _ = if on { w.show() } else { w.hide() };
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("float.json"))
}

fn load_prefs(app: &AppHandle) -> FloatPrefs {
    prefs_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_prefs(app: &AppHandle) {
    let Some(path) = prefs_path(app) else { return };
    let prefs = app.state::<FloatState>().prefs.lock().unwrap().clone();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(&prefs) {
        let _ = fs::write(path, text);
    }
}

fn float_url() -> Option<tauri::Url> {
    format!("http://localhost:{}/?float=1", read_config()?.port).parse().ok()
}

/// A remembered position counts only while its top-left corner is still on some monitor.
fn on_screen(app: &AppHandle, x: i32, y: i32) -> bool {
    app.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        x >= p.x && y >= p.y && x < p.x + s.width as i32 - 40 && y < p.y + s.height as i32 - 40
    })
}

/// Remembered position, else the bottom-right corner of the work area the main window is on.
fn place_float(app: &AppHandle, w: &WebviewWindow) {
    let saved = {
        let p = app.state::<FloatState>().prefs.lock().unwrap().clone();
        p.x.zip(p.y)
    };
    if let Some((x, y)) = saved.filter(|&(x, y)| on_screen(app, x, y)) {
        let _ = w.set_position(PhysicalPosition::new(x, y));
        return;
    }
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let (area, scale) = (m.work_area(), m.scale_factor());
        let margin = (12.0 * scale) as i32;
        let x = area.position.x + area.size.width as i32 - (FLOAT_W * scale) as i32 - margin;
        let y = area.position.y + area.size.height as i32 - (FLOAT_H * scale) as i32;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
}

fn ensure_float(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("float") {
        return Some(w);
    }
    let w = WebviewWindowBuilder::new(app, "float", WebviewUrl::External(float_url()?))
        .title("GenCouncil 의장")
        .inner_size(FLOAT_W, FLOAT_H)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .ok()?;
    place_float(app, &w);
    Some(w)
}

fn float_enabled(app: &AppHandle) -> bool {
    app.state::<FloatState>().prefs.lock().unwrap().enabled
}

/// The main window is down in the tray (closed, not minimized: a minimized window still counts as
/// visible). Read from the window itself, so every way it comes back counts.
fn main_in_tray(app: &AppHandle) -> bool {
    app.get_webview_window("main").map(|w| !w.is_visible().unwrap_or(true)).unwrap_or(false)
}

/// Show the float if the setting is on. Callers have checked that the main window is in the tray.
fn show_float(app: &AppHandle) {
    if !float_enabled(app) {
        return;
    }
    if let Some(w) = ensure_float(app) {
        if !app.state::<FloatState>().shown.swap(true, Ordering::SeqCst) {
            float_visible(&w, true);
        }
    }
}

fn hide_float(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("float") {
        if app.state::<FloatState>().shown.swap(false, Ordering::SeqCst) {
            float_visible(&w, false);
            save_prefs(app); // keeps the last dragged position
        }
    }
}

/// Turn "닫으면 플로팅 의장 띄우기" on or off (the tray's check item, the float's right-click menu).
fn set_float_enabled(app: &AppHandle, on: bool) {
    app.state::<FloatState>().prefs.lock().unwrap().enabled = on;
    save_prefs(app);
    if let Some(m) = app.try_state::<FloatMenus>() {
        let _ = m.check.set_checked(on);
    }
    if !on {
        hide_float(app);
    } else if main_in_tray(app) {
        show_float(app);
    }
}

/// The tray's check item and the float's right-click menu (kept for the app's life: a menu's click
/// events come after its popup returns, and a dropped menu would lose them).
struct FloatMenus {
    check: CheckMenuItem<tauri::Wry>,
    popup: Menu<tauri::Wry>,
}

/// From the console in the main window, once it is up (it reports which view it shows; the float
/// no longer depends on that). The float is loaded hidden now so closing shows it at once.
#[tauri::command]
async fn desktop_mode(app: AppHandle, window: tauri::Window, mode: String) {
    let _ = mode;
    if window.label() == "main" && float_enabled(&app) {
        let _ = ensure_float(&app);
    }
}

/// From the float window, on a right click anywhere on it: its small menu at the cursor.
#[tauri::command]
async fn float_menu(app: AppHandle, window: tauri::Window) {
    if window.label() != "float" {
        return;
    }
    if let Some(m) = app.try_state::<FloatMenus>() {
        let _ = window.popup_menu(&m.popup);
    }
}

/// From the float window: bring the main window back.
#[tauri::command]
async fn float_restore(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
async fn float_drag(window: tauri::Window) {
    if window.label() == "float" {
        let _ = window.start_dragging();
    }
}

#[tauri::command]
async fn float_hide(app: AppHandle) {
    hide_float(&app);
}

fn show_main(app: &AppHandle) {
    hide_float(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("GenCouncil")
        .inner_size(1400.0, 900.0)
        .min_inner_size(420.0, 560.0)
        // let the page's own HTML5 drop handlers get files (images into the chat): Tauri's native
        // drag-drop handler would otherwise take every drop on Windows
        .disable_drag_drop_handler()
        .build();
    if built.is_ok() {
        connect(app);
    }
}

fn restart_server(app: &AppHandle) {
    let app2 = app.clone();
    app.dialog()
        .message("서버를 다시 시작하면 진행 중인 위원 작업이 멈출 수 있어요. 계속할까요?")
        .title("서버 재시작")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("재시작".into(), "취소".into()))
        .show(move |ok| {
            if !ok {
                return;
            }
            show_main(&app2);
            if let Some(w) = app2.get_webview_window("main") {
                let _ = w.navigate(splash_url());
            }
            let app3 = app2.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(400));
                set_status(&app3, "서버를 다시 시작하는 중…");
                cli(&["service", "stop"]);
                thread::sleep(Duration::from_millis(800));
                connect(&app3);
            });
        });
}

fn main() {
    tauri::Builder::default()
        // a second launch just brings the existing window forward
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .manage(FloatState::default())
        .invoke_handler(tauri::generate_handler![desktop_mode, float_restore, float_drag, float_hide, float_menu])
        .setup(|app| {
            let prefs = load_prefs(app.handle());
            let float_on = prefs.enabled;
            *app.state::<FloatState>().prefs.lock().unwrap() = prefs;
            let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "새로고침", true, None::<&str>)?;
            let float = CheckMenuItem::with_id(app, "float", "닫으면 플로팅 의장 띄우기", true, float_on, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "서버 재시작", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "종료 (서버는 계속 실행)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &reload, &float, &restart, &sep, &quit])?;
            // the float's right-click menu (its clicks come to the same menu handler below)
            let popup = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "float_main", "메인 열기", true, None::<&str>)?,
                    &MenuItem::with_id(app, "float_hide", "잠시 숨기기", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "float_off", "플로팅 끄기 (닫아도 안 뜸)", true, None::<&str>)?,
                ],
            )?;
            let float_item = float.clone();
            app.manage(FloatMenus { check: float, popup });
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("GenCouncil")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "reload" => {
                        show_main(app);
                        if let Some(w) = app.get_webview_window("main") {
                            if w.url().map(|u| u.host_str() == Some("localhost")).unwrap_or(false) {
                                let _ = w.eval("location.reload()");
                            } else {
                                connect(app);
                            }
                        }
                        if let Some(w) = app.get_webview_window("float") {
                            let _ = w.eval("location.reload()");
                        }
                    }
                    "float" => {
                        // the check mark flips itself on click; follow it
                        set_float_enabled(app, float_item.is_checked().unwrap_or(true));
                    }
                    "float_main" => show_main(app),
                    "float_hide" => hide_float(app),
                    "float_off" => set_float_enabled(app, false),
                    "restart" => restart_server(app),
                    "quit" => {
                        hide_float(app);
                        save_prefs(app);
                        app.exit(0)
                    }
                    _ => {}
                })
                .build(app)?;
            show_main(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // closing the window keeps the app in the tray
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "float" {
                    hide_float(window.app_handle());
                } else {
                    let _ = window.hide();
                    // into the tray: the floating chair stands in for it (if the setting is on)
                    if window.label() == "main" {
                        show_float(window.app_handle());
                    }
                }
            }
            // the main window back on screen by any way: the chair goes
            tauri::WindowEvent::Focused(true) if window.label() == "main" => {
                if window.is_visible().unwrap_or(false) {
                    hide_float(window.app_handle());
                }
            }
            // a DPI change (dragged onto a monitor with another scale) makes tao re-apply its window
            // flags, and tao still has the float window as hidden: show it again once that is done
            tauri::WindowEvent::ScaleFactorChanged { .. } if window.label() == "float" => {
                let app = window.app_handle().clone();
                let _ = window.app_handle().run_on_main_thread(move || {
                    if app.state::<FloatState>().shown.load(Ordering::SeqCst) {
                        if let Some(w) = app.get_webview_window("float") {
                            float_visible(&w, true);
                        }
                    }
                });
            }
            tauri::WindowEvent::Moved(p) if window.label() == "float" => {
                let st = window.app_handle().state::<FloatState>();
                let mut prefs = st.prefs.lock().unwrap();
                prefs.x = Some(p.x);
                prefs.y = Some(p.y);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running GenCouncil desktop");
}
