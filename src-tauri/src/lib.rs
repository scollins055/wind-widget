//! Desktop shell for the wind widget: one frameless window, a tray icon,
//! and the plugins the web UI uses (autostart, notifications, links,
//! remembering the window position, and refusing a second copy).

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

fn show_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
    }
}

fn toggle_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch just reveals the running widget.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_widget(app);
        }))
        // Remember where the widget was placed (size is set by the UI's mode).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let toggle = MenuItem::with_id(app, "toggle", "Show / hide widget", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh forecast", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &refresh, &settings, &separator, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Wind Widget")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_widget(app),
                    "refresh" => {
                        let _ = app.emit("tray-refresh", ());
                    }
                    "settings" => {
                        show_widget(app);
                        let _ = app.emit("tray-settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Wind Widget");
}
