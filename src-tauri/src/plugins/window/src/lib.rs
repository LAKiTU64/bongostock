use tauri::{
    Runtime, generate_handler,
    plugin::{Builder, TauriPlugin},
};

mod commands;
mod page_gesture;

pub use commands::*;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("custom-window")
        .invoke_handler(generate_handler![
            commands::show_window,
            commands::request_window_recovery,
            commands::take_window_recovery_request,
            commands::reveal_recovered_main,
            commands::display_work_areas,
            commands::show_labeled_window,
            commands::hide_window,
            commands::set_always_on_top,
            commands::set_taskbar_visibility,
            page_gesture::set_page_gesture,
        ])
        .on_event(|_app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = event {
                if label == commands::STOCK_PANEL_WINDOW_LABEL {
                    page_gesture::macos::clear();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = event;
        })
        .build()
}
