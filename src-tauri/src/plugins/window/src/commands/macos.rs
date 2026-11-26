#![allow(deprecated)]
use crate::MAIN_WINDOW_LABEL;
use tauri::{AppHandle, PhysicalPosition, Runtime, WebviewWindow, command};
use tauri_nspanel::{CollectionBehavior, ManagerExt, PanelLevel};

enum MacOSPanelStatus {
    Show,
    Hide,
    SetAlwaysOnTop(bool),
}

fn is_main_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window.label() == MAIN_WINDOW_LABEL
}

fn set_macos_panel<R: Runtime>(
    app_handle: &AppHandle<R>,
    window: &WebviewWindow<R>,
    status: MacOSPanelStatus,
) {
    if is_main_window(window) {
        let app_handle_clone = app_handle.clone();

        let _ = app_handle.run_on_main_thread(move || {
            if let Ok(panel) = app_handle_clone.get_webview_panel(MAIN_WINDOW_LABEL) {
                match status {
                    MacOSPanelStatus::Show => {
                        panel.show();

                        panel.set_collection_behavior(
                            CollectionBehavior::new()
                                .stationary()
                                .can_join_all_spaces()
                                .full_screen_auxiliary()
                                .into(),
                        );
                    }
                    MacOSPanelStatus::Hide => {
                        panel.hide();

                        panel.set_collection_behavior(
                            CollectionBehavior::new()
                                .stationary()
                                .move_to_active_space()
                                .full_screen_auxiliary()
                                .into(),
                        );
                    }
                    MacOSPanelStatus::SetAlwaysOnTop(always_on_top) => {
                        if always_on_top {
                            panel.set_level(PanelLevel::Dock.value());
                        } else {
                            panel.set_level(-1);
                        };
                    }
                }
            }
        });
    }
}

#[command]
pub async fn show_window<R: Runtime>(
    app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    x: Option<i32>,
    y: Option<i32>,
) {
    if let (Some(x), Some(y)) = (x, y) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }

    if is_main_window(&window) {
        set_macos_panel(&app_handle, &window, MacOSPanelStatus::Show);
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub(super) fn hide_main_panel<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    set_macos_panel(app, window, MacOSPanelStatus::Hide);
}

/// Bring the existing NSPanel forward without changing its saved/native level.
/// to_panel changes this NSWindow's class; it is not a second window to move.
pub fn reveal_recovered_panel<R: Runtime>(app_handle: &AppHandle<R>) -> Result<(), String> {
    let app = app_handle.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app_handle
        .run_on_main_thread(move || {
            let result = app
                .get_webview_panel(MAIN_WINDOW_LABEL)
                .map_err(|error| format!("{error:?}"))
                .map(|panel| {
                    panel.show_and_make_key();
                    panel.order_front_regardless();
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| error.to_string())?
}

/// Tauri 2.10's macOS work_area omits the visibleFrame's vertical inset.
/// Read both rectangles from AppKit and convert their bottom-left origin to
/// the same global top-left logical desktop used by tao::outer_position.
pub fn macos_display_work_areas<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<Vec<super::DisplayWorkArea>, String> {
    use tauri_nspanel::{objc2::MainThreadMarker, objc2_app_kit::NSScreen};
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app_handle
        .run_on_main_thread(move || {
            let result = (|| {
                let mtm = MainThreadMarker::new().ok_or("display query is not on main thread")?;
                let screens = NSScreen::screens(mtm);
                if screens.is_empty() {
                    return Err("no connected display".to_string());
                }
                // AppKit defines screens[0] as the menu-bar (primary) screen;
                // unlike Tauri's available_monitors this is a documented ordering.
                let primary = screens.objectAtIndex(0).frame();
                let top = primary.origin.y + primary.size.height;
                let rect = |frame: tauri_nspanel::NSRect| super::DesktopRect {
                    x: frame.origin.x,
                    y: top - frame.origin.y - frame.size.height,
                    width: frame.size.width,
                    height: frame.size.height,
                };
                Ok(screens
                    .iter()
                    .map(|screen| super::DisplayWorkArea {
                        bounds: rect(screen.frame()),
                        work: rect(screen.visibleFrame()),
                    })
                    .collect())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| error.to_string())?
}

#[command]
pub async fn set_always_on_top<R: Runtime>(
    app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    always_on_top: bool,
) {
    if is_main_window(&window) {
        return set_macos_panel(
            &app_handle,
            &window,
            MacOSPanelStatus::SetAlwaysOnTop(always_on_top),
        );
    }

    if always_on_top {
        let _ = window.set_always_on_bottom(false);
        let _ = window.set_always_on_top(true);
    } else {
        let _ = window.set_always_on_top(false);
        // Clearing both flags restores normal window ordering. Setting
        // always-on-bottom here would make preference/stock windows behave
        // differently from Windows, where false means not-topmost.
        let _ = window.set_always_on_bottom(false);
    }
}

#[command]
pub async fn set_taskbar_visibility<R: Runtime>(app_handle: AppHandle<R>, visible: bool) {
    let _ = app_handle.set_dock_visibility(visible);
}
