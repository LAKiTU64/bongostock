use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, Runtime, WebviewWindow, WebviewWindowBuilder,
    async_runtime::spawn, command, webview::PageLoadEvent,
};

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const PREFERENCE_WINDOW_LABEL: &str = "preference";
pub const STOCK_PANEL_WINDOW_LABEL: &str = "stock-panel";
pub const SHOW_WINDOW_EVENT: &str = "show-window";

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "linux")]
pub use linux::*;

pub fn show_main_window(app_handle: &AppHandle) {
    reveal_window(app_handle, MAIN_WINDOW_LABEL);
}

pub fn show_preference_window(app_handle: &AppHandle) {
    let _ = ensure_window(app_handle, PREFERENCE_WINDOW_LABEL);
}

#[command]
pub async fn show_labeled_window<R: Runtime>(
    app_handle: AppHandle<R>,
    label: String,
) -> Result<(), String> {
    ensure_window(&app_handle, &label)
}

pub fn reveal_window<R: Runtime>(app_handle: &AppHandle<R>, label: &str) {
    let Some(window) = app_handle.get_webview_window(label) else {
        return;
    };

    let target = EventTarget::labeled(label);
    let _ = window.emit_to(target, SHOW_WINDOW_EVENT, label);

    // The stock panel prepares its size and position while it is still hidden,
    // then reveals itself from the webview. Showing it here first produces one
    // frame at its stale position when retained state has expired.
    if label == STOCK_PANEL_WINDOW_LABEL {
        return;
    }

    let app_handle = app_handle.clone();

    spawn(async move {
        show_window(app_handle, window, None, None).await;
    });
}

fn ensure_window<R: Runtime>(app_handle: &AppHandle<R>, label: &str) -> Result<(), String> {
    if !matches!(label, PREFERENCE_WINDOW_LABEL | STOCK_PANEL_WINDOW_LABEL) {
        return Err(format!("unsupported window label: {label}"));
    }

    if app_handle.get_webview_window(label).is_some() {
        reveal_window(app_handle, label);
        return Ok(());
    }

    let config = app_handle
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == label)
        .cloned()
        .ok_or_else(|| format!("missing window configuration: {label}"))?;
    let ready_app_handle = app_handle.clone();
    let ready_label = label.to_owned();
    let first_page_load = Arc::new(AtomicBool::new(true));

    WebviewWindowBuilder::from_config(app_handle, &config)
        .map_err(|error| error.to_string())?
        .on_page_load(move |_window: WebviewWindow<R>, payload| {
            if payload.event() == PageLoadEvent::Finished
                && first_page_load.swap(false, Ordering::Relaxed)
                && ready_label != STOCK_PANEL_WINDOW_LABEL
            {
                reveal_window(&ready_app_handle, &ready_label);
            }
        })
        .build()
        .map_err(|error| error.to_string())?;

    Ok(())
}
