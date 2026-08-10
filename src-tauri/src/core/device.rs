use rdev::{Event, EventType, listen};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Runtime, command};
use tauri_plugin_custom_window::MAIN_WINDOW_LABEL;

#[derive(Debug, Clone, Serialize)]
pub enum DeviceEventKind {
    MousePress,
    MouseRelease,
    MouseMove,
    KeyboardPress,
    KeyboardRelease,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceEvent {
    kind: DeviceEventKind,
    value: Value,
}

static IS_LISTENING: AtomicBool = AtomicBool::new(false);
static MOUSE_MOVE_ENABLED: AtomicBool = AtomicBool::new(false);
static HAS_RECEIVED_EVENT: AtomicBool = AtomicBool::new(false);

#[command]
pub fn set_mouse_move_enabled(enabled: bool) {
    MOUSE_MOVE_ENABLED.store(enabled, Ordering::Relaxed);
}

// kIOHIDRequestTypeListenEvent
#[cfg(target_os = "macos")]
const IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOHIDRequestAccess(request_type: u32) -> bool;
}

/// Ask macOS for Input Monitoring access.
///
/// Opening the Privacy pane does not register the app there; only
/// `IOHIDRequestAccess` adds it to the list and shows the system prompt.
#[command]
pub async fn request_input_monitoring_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        let granted = unsafe { IOHIDRequestAccess(IOHID_REQUEST_TYPE_LISTEN_EVENT) };

        tauri_plugin_log::log::info!(
            "[device] IOHIDRequestAccess(ListenEvent) returned: {granted}"
        );

        granted
    }

    #[cfg(not(target_os = "macos"))]
    true
}

#[command]
pub async fn start_device_listening<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let accessibility_authorized =
            tauri_plugin_macos_permissions::check_accessibility_permission().await;
        let input_monitoring_authorized =
            tauri_plugin_macos_permissions::check_input_monitoring_permission().await;

        tauri_plugin_log::log::info!(
            "[device] Rust Accessibility authorized: {accessibility_authorized}; Input Monitoring authorized: {input_monitoring_authorized}"
        );

        if !accessibility_authorized || !input_monitoring_authorized {
            return Err(
                "macOS Accessibility and Input Monitoring permissions are required".to_string(),
            );
        }
    }

    if IS_LISTENING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        tauri_plugin_log::log::info!("[device] Native input listener already running");
        return Ok(());
    }

    HAS_RECEIVED_EVENT.store(false, Ordering::SeqCst);
    tauri_plugin_log::log::info!("[device] Entering rdev input listener");

    let callback = move |event: Event| {
        if !HAS_RECEIVED_EVENT.swap(true, Ordering::SeqCst) {
            tauri_plugin_log::log::info!("[device] Received first native input event");
        }

        let device_event = match event.event_type {
            EventType::ButtonPress(button) => DeviceEvent {
                kind: DeviceEventKind::MousePress,
                value: json!(format!("{:?}", button)),
            },
            EventType::ButtonRelease(button) => DeviceEvent {
                kind: DeviceEventKind::MouseRelease,
                value: json!(format!("{:?}", button)),
            },
            EventType::MouseMove { x, y } => {
                if !MOUSE_MOVE_ENABLED.load(Ordering::Relaxed) {
                    return;
                }

                DeviceEvent {
                    kind: DeviceEventKind::MouseMove,
                    value: json!({ "x": x, "y": y }),
                }
            }
            EventType::KeyPress(key) => DeviceEvent {
                kind: DeviceEventKind::KeyboardPress,
                value: json!(format!("{:?}", key)),
            },
            EventType::KeyRelease(key) => DeviceEvent {
                kind: DeviceEventKind::KeyboardRelease,
                value: json!(format!("{:?}", key)),
            },
            _ => return,
        };

        let _ = app_handle.emit_to(MAIN_WINDOW_LABEL, "device-changed", device_event);
    };

    let result = listen(callback).map_err(|err| format!("Failed to listen device: {:?}", err));

    IS_LISTENING.store(false, Ordering::SeqCst);

    if let Err(error) = &result {
        tauri_plugin_log::log::error!("[device] Native input listener stopped: {error}");
    }

    result
}
