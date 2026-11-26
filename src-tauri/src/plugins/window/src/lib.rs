use tauri::{
    Manager, Runtime, generate_handler,
    plugin::{Builder, TauriPlugin},
};

mod commands;
mod hidden_panel;
mod page_gesture;

pub use commands::*;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("custom-window")
        .setup(|app, _| {
            app.manage(hidden_panel::HiddenPanel::default());
            Ok(())
        })
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
            hidden_panel::hide_panel_for_hour,
        ])
        .on_event(|app, event| {
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = event {
                if label == commands::STOCK_PANEL_WINDOW_LABEL {
                    app.state::<hidden_panel::HiddenPanel>().did_destroy();
                    #[cfg(target_os = "macos")]
                    page_gesture::macos::clear();
                }
            }
        })
        .build()
}
