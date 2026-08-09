use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Runtime, WebviewWindow, command};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, HWND_NOTOPMOST, HWND_TOPMOST, SW_RESTORE, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOZORDER, SetForegroundWindow, SetWindowPos, ShowWindow,
};

static TOPMOST_RUNNING: OnceLock<Arc<AtomicBool>> = OnceLock::new();

#[command]
pub async fn show_window<R: Runtime>(
    _app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    x: Option<i32>,
    y: Option<i32>,
) {
    let native_hwnd = window.hwnd().ok();

    if let (Some(x), Some(y), Some(native_hwnd)) = (x, y, native_hwnd) {
        let hwnd = HWND(native_hwnd.0);

        // Reposition while the window is still hidden. The regular Tauri show
        // path below then keeps its visibility state in sync with isVisible().
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                None,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    let _ = window.show();
    let _ = window.unminimize();

    // WebView focus alone does not reliably activate a hidden preference
    // window on Windows, especially when the request comes from a tray/menu
    // callback. Bring the native HWND to the foreground as well.
    if let Some(native_hwnd) = native_hwnd {
        let hwnd = HWND(native_hwnd.0);

        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
        }
    }

    let _ = window.set_focus();
}

#[command]
pub async fn hide_window<R: Runtime>(_app_handle: AppHandle<R>, window: WebviewWindow<R>) {
    let _ = window.hide();
}

#[command]
pub async fn set_always_on_top<R: Runtime>(
    _app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    always_on_top: bool,
) {
    let running = TOPMOST_RUNNING.get_or_init(|| Arc::new(AtomicBool::new(false)));

    let Ok(hwnd) = window.hwnd() else { return };
    let raw_hwnd = hwnd.0 as isize;

    if always_on_top {
        let Ok(_) = running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        else {
            return;
        };

        let running = Arc::clone(running);

        thread::spawn(move || {
            let hwnd = HWND(raw_hwnd as *mut _);

            while running.load(Ordering::SeqCst) {
                unsafe {
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                thread::sleep(Duration::from_millis(16));
            }
        });
    } else {
        running.store(false, Ordering::SeqCst);

        let hwnd = HWND(raw_hwnd as *mut _);

        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_NOTOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

#[command]
pub async fn set_taskbar_visibility<R: Runtime>(window: WebviewWindow<R>, visible: bool) {
    let _ = window.set_skip_taskbar(!visible);
}
