use tauri::{
    Runtime, generate_handler,
    plugin::{Builder, TauriPlugin},
};

mod commands;

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
        ])
        .build()
}
