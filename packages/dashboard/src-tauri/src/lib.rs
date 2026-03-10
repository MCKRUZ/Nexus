use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: u16 = 47340;

/// Shared server state — tracks whether the server process is running.
struct ServerState {
    child: Option<tauri_plugin_shell::process::CommandChild>,
    port: u16,
    bind_all: bool,
}

fn spawn_server(
    app: &AppHandle,
    port: u16,
    bind_all: bool,
) -> Result<tauri_plugin_shell::process::CommandChild, String> {
    let bind_address = if bind_all { "0.0.0.0" } else { "127.0.0.1" };
    let (_rx, child) = app
        .shell()
        .sidecar("nexus-server")
        .map_err(|e| e.to_string())?
        .args(["--port", &port.to_string(), "--bind", bind_address])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(child)
}

#[tauri::command]
fn get_server_port(state: tauri::State<Arc<Mutex<ServerState>>>) -> u16 {
    state.lock().unwrap().port
}

#[tauri::command]
fn get_server_bind_all(state: tauri::State<Arc<Mutex<ServerState>>>) -> bool {
    state.lock().unwrap().bind_all
}

#[tauri::command]
fn set_server_mode(
    bind_all: bool,
    app: AppHandle,
    state: tauri::State<Arc<Mutex<ServerState>>>,
) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    // Kill existing server
    if let Some(child) = s.child.take() {
        let _ = child.kill();
    }
    s.bind_all = bind_all;
    let port = s.port;
    // Respawn with new bind address
    match spawn_server(&app, port, bind_all) {
        Ok(child) => {
            s.child = Some(child);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn toggle_autostart(
    enabled: bool,
    app: AppHandle,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if enabled {
        autostart.enable().map_err(|e| e.to_string())
    } else {
        autostart.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

pub fn run() {
    let server_state = Arc::new(Mutex::new(ServerState {
        child: None,
        port: DEFAULT_PORT,
        bind_all: false,
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second instance tried to launch — bring existing window to focus instead
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_process::init())
        .manage(server_state.clone())
        .setup(move |app| {
            // In production, spawn the bundled Nexus HTTP server sidecar on startup.
            // In dev mode (cargo run / tauri dev), skip spawning — run the server
            // separately with: node packages/server/dist/index.js
            #[cfg(not(dev))]
            {
                let handle = app.handle().clone();
                let state = server_state.clone();
                match spawn_server(&handle, DEFAULT_PORT, false) {
                    Ok(child) => {
                        state.lock().unwrap().child = Some(child);
                    }
                    Err(e) => {
                        eprintln!("[nexus-desktop] Failed to spawn server: {e}");
                    }
                }
            }

            // Build system tray menu
            let open_item = MenuItem::with_id(app, "open", "Open Nexus", true, None::<&str>)?;
            let server_item = MenuItem::with_id(
                app,
                "server",
                format!("Server: localhost:{DEFAULT_PORT}"),
                false,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&open_item, &server_item, &separator, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("nexus-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Open devtools only in dev builds
            #[cfg(dev)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide instead of close so the app stays in the tray
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            get_server_bind_all,
            set_server_mode,
            toggle_autostart,
            is_autostart_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexus desktop app");
}
