use tauri::{
    Manager, Runtime, generate_handler,
    plugin::{Builder, TauriPlugin},
};

mod commands;
#[cfg(target_os = "macos")]
mod display_changes;
mod hidden_panel;
mod page_gesture;
#[cfg(target_os = "macos")]
mod panel_hover;

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
            commands::close_for_boss_key,
            commands::set_always_on_top,
            commands::set_taskbar_visibility,
            page_gesture::set_page_gesture,
            hidden_panel::hide_panel_for_hour,
        ])
        .on_webview_ready(|_webview| {
            #[cfg(target_os = "macos")]
            if _webview.label() == commands::STOCK_PANEL_WINDOW_LABEL {
                if let Err(error) = panel_hover::install(&_webview) {
                    eprintln!("could not install stock panel pointer tracking: {error}");
                }
            }
        })
        .on_event(|app, event| {
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::Ready => display_changes::observe(app),
                tauri::RunEvent::Exit => display_changes::stop(),
                _ => {}
            }
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = event {
                if label == commands::STOCK_PANEL_WINDOW_LABEL {
                    app.state::<hidden_panel::HiddenPanel>().did_destroy();
                    #[cfg(target_os = "macos")]
                    page_gesture::macos::clear();
                } else if label == commands::PREFERENCE_WINDOW_LABEL {
                    app.state::<hidden_panel::HiddenPanel>().did_destroy();
                }
            }
        })
        .build()
}
