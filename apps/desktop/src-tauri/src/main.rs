// GenCouncil desktop: tray-resident wrapper around the local web console.
// UNVERIFIED SCAFFOLD: written without a Rust toolchain at hand; expect small API fixes when first built.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Deserialize)]
struct ServerConfig {
    token: String,
    port: u16,
}

struct Server(Mutex<Option<Child>>);

fn home() -> PathBuf {
    std::env::var("GENCOUNCIL_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".gencouncil"))
}

fn read_config() -> Option<ServerConfig> {
    let text = fs::read_to_string(home().join("server.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn server_up(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_millis(300)).is_ok()
}

/// Start `node <cli.js> web` unless something already listens on the port.
fn ensure_server(state: &Server) {
    let cfg = read_config();
    let port = cfg.as_ref().map(|c| c.port).unwrap_or(7700);
    if server_up(port) {
        return;
    }
    let cli = std::env::var("GENCOUNCIL_CLI").unwrap_or_else(|_| "gencouncil".to_string());
    let child = if cli.ends_with(".js") {
        Command::new("node").arg(&cli).arg("web").stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    } else {
        Command::new(&cli).arg("web").stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    };
    if let Ok(c) = child {
        *state.0.lock().unwrap() = Some(c);
        for _ in 0..40 {
            if server_up(port) {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
}

fn console_url() -> String {
    match read_config() {
        Some(c) => format!("http://localhost:{}/auth?token={}", c.port, c.token),
        None => "http://localhost:7700/".to_string(),
    }
}

fn open_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url = console_url().parse().expect("url");
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("GenCouncil")
        .inner_size(1400.0, 900.0)
        .build();
}

fn main() {
    tauri::Builder::default()
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            ensure_server(app.state::<Server>().inner());
            let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "서버 재시작", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &restart, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("icon"))
                .menu(&menu)
                .tooltip("GenCouncil")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_main(app),
                    "restart" => {
                        let state = app.state::<Server>();
                        if let Some(mut c) = state.0.lock().unwrap().take() {
                            let _ = c.kill();
                        }
                        ensure_server(state.inner());
                    }
                    "quit" => {
                        let state = app.state::<Server>();
                        if let Some(mut c) = state.0.lock().unwrap().take() {
                            let _ = c.kill();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            open_main(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the window keeps the app in the tray
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running GenCouncil desktop");
}
