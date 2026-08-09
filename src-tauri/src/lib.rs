mod core;
mod utils;

use core::{
    device::{set_mouse_move_enabled, start_device_listening},
    gamepad::{start_gamepad_listing, stop_gamepad_listing},
    prevent_default, setup,
};
use tauri::{Manager, WindowEvent, generate_handler};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_custom_window::{MAIN_WINDOW_LABEL, show_preference_window};
use utils::fs_extra::copy_dir;
use utils::market::market_request;
use utils::skin::{delete_imported_skin, import_skin_pack, list_imported_skins};

#[tauri::command]
fn open_macos_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle();

            let main_window = app.get_webview_window(MAIN_WINDOW_LABEL).unwrap();

            setup::default(&app_handle, main_window.clone());

            Ok(())
        })
        .invoke_handler(generate_handler![
            copy_dir,
            market_request,
            import_skin_pack,
            list_imported_skins,
            delete_imported_skin,
            start_device_listening,
            set_mouse_move_enabled,
            start_gamepad_listing,
            stop_gamepad_listing,
            open_macos_accessibility_settings
        ])
        .plugin(tauri_plugin_admin_status::init())
        .plugin(tauri_plugin_custom_window::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_pinia::init())
        .plugin(prevent_default::init())
        .plugin(tauri_plugin_single_instance::init(
            |app_handle, _argv, _cwd| {
                show_preference_window(app_handle);
            },
        ))
        .plugin(
            tauri_plugin_log::Builder::new()
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .filter(|metadata| !metadata.target().contains("gilrs"))
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_locale::init())
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();

                api.prevent_close();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            show_preference_window(app_handle);
        }
        _ => {
            let _ = app_handle;
        }
    });
}
