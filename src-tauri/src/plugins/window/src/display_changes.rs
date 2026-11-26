use std::{cell::RefCell, ptr::NonNull};

use block2::RcBlock;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};
use tauri_nspanel::{
    objc2::{rc::Retained, runtime::ProtocolObject},
    objc2_app_kit::NSApplicationDidChangeScreenParametersNotification,
    objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol},
};

use crate::MAIN_WINDOW_LABEL;

thread_local! {
    static OBSERVER: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
}

// Tauri delivers Ready and Exit on the AppKit event-loop thread.
pub fn observe<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    subscribe(move || {
        let _ = app.emit_to(
            EventTarget::webview_window(MAIN_WINDOW_LABEL),
            "desktop-displays-changed",
            (),
        );
    });
}

fn subscribe(changed: impl Fn() + Send + Sync + 'static) {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| changed());
    OBSERVER.with(|slot| {
        let mut observer = slot.borrow_mut();
        if observer.is_none() {
            // SAFETY: The callback is sendable and does not retain the notification.
            *observer = Some(unsafe {
                NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(NSApplicationDidChangeScreenParametersNotification),
                    None,
                    None,
                    &block,
                )
            });
        }
    });
}

pub fn stop() {
    OBSERVER.with(|slot| {
        if let Some(observer) = slot.borrow_mut().take() {
            // SAFETY: This is the token returned by the same notification center.
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn posts_one_local_screen_event_and_stops_on_release() {
        let count = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let count = count.clone();
            subscribe(move || {
                count.fetch_add(1, Ordering::SeqCst);
            });
        }
        let post = || {
            // This Foundation notification is local to the test process.
            unsafe {
                NSNotificationCenter::defaultCenter().postNotificationName_object(
                    NSApplicationDidChangeScreenParametersNotification,
                    None,
                )
            };
        };
        post();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        stop();
        post();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
