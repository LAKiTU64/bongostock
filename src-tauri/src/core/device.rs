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

#[command]
pub fn set_mouse_move_enabled(enabled: bool) {
    MOUSE_MOVE_ENABLED.store(enabled, Ordering::Relaxed);
}

#[command]
pub async fn start_device_listening<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    if IS_LISTENING.load(Ordering::SeqCst) {
        return Ok(());
    }

    IS_LISTENING.store(true, Ordering::SeqCst);

    let callback = move |event: Event| {
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

    listen(callback).map_err(|err| format!("Failed to listen device: {:?}", err))?;

    Ok(())
}
