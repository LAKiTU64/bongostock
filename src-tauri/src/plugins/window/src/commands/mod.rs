use std::sync::{
    Arc, Mutex,
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
const RECOVER_WINDOWS_EVENT: &str = "recover-desktop-windows";

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MainWindowRequest {
    Reopen,
    Recover,
}

static PENDING_REQUEST: Mutex<Option<MainWindowRequest>> = Mutex::new(None);

/// Keep the request until the main webview has restored stores and final size.
/// Emitting alone loses Reopen/single-instance requests during Vue startup.
pub fn request_main_window<R: Runtime>(
    app_handle: &AppHandle<R>,
    request: MainWindowRequest,
) -> Result<(), String> {
    {
        let mut pending = PENDING_REQUEST.lock().map_err(|error| error.to_string())?;
        // A queued explicit menu action also reveals the pet and takes priority.
        if !matches!(*pending, Some(MainWindowRequest::Recover)) {
            *pending = Some(request);
        }
    }
    app_handle
        .emit_to(
            EventTarget::labeled(MAIN_WINDOW_LABEL),
            RECOVER_WINDOWS_EVENT,
            (),
        )
        .map_err(|error| error.to_string())
}

#[command]
pub fn request_window_recovery<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    request_main_window(&app_handle, MainWindowRequest::Recover)
}

#[command]
pub fn take_window_recovery_request<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Option<MainWindowRequest>, String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("only the main window can handle recovery".into());
    }
    Ok(PENDING_REQUEST
        .lock()
        .map_err(|error| error.to_string())?
        .take())
}

#[command]
pub async fn reveal_recovered_main<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    let window = app_handle
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or("main window unavailable")?;
    window.unminimize().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    return reveal_recovered_panel(&app_handle);
    #[cfg(not(target_os = "macos"))]
    {
        window.show().map_err(|error| error.to_string())?;
        show_window(app_handle, window.clone(), None, None).await;
        window.set_focus().map_err(|error| error.to_string())
    }
}

#[derive(serde::Serialize)]
pub struct DesktopRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(serde::Serialize)]
pub struct DisplayWorkArea {
    pub bounds: DesktopRect,
    pub work: DesktopRect,
}

#[command]
pub async fn display_work_areas<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<Vec<DisplayWorkArea>, String> {
    #[cfg(target_os = "macos")]
    return macos_display_work_areas(&app_handle);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle;
        Ok(Vec::new())
    }
}

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
pub async fn hide_window<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    if window.label() == STOCK_PANEL_WINDOW_LABEL {
        return crate::hidden_panel::hide_normally(&window).await;
    }
    #[cfg(target_os = "macos")]
    if window.label() == MAIN_WINDOW_LABEL {
        hide_main_panel(window.app_handle(), &window);
        return Ok(());
    }
    window.hide().map_err(|error| error.to_string())
}

#[command]
pub async fn show_labeled_window<R: Runtime>(
    app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    label: String,
) -> Result<(), String> {
    if label == STOCK_PANEL_WINDOW_LABEL {
        return crate::hidden_panel::open(&app_handle, window.label()).await;
    }
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

pub(crate) fn ensure_window<R: Runtime>(app_handle: &AppHandle<R>, label: &str) -> Result<(), String> {
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
