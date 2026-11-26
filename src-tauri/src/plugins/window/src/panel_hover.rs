//! WebKit's own mouse tracking can be limited to the key window on macOS.
//! Attach a second tracking area to the stock webview for background activity.
use std::{
    cell::Cell,
    time::{Duration, Instant},
};

use tauri::{Emitter, EventTarget, Manager, Runtime, Webview};
use tauri_nspanel::{
    NSPoint, NSRect, NSView, NSWindow,
    objc2::{AnyThread, DefinedClass, MainThreadOnly, define_class, msg_send, rc::Retained},
    objc2_app_kit::{NSEvent, NSTrackingArea, NSTrackingAreaOptions as Options},
    objc2_foundation::{NSDictionary, NSObject, ns_string},
};

struct HoverState {
    notify: Box<dyn Fn()>,
    last_sample: Cell<Option<(Instant, NSPoint)>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements. AppKit delivers the
    // tracking callbacks on the main thread with a live NSEvent.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = HoverState]
    #[name = "BongoStockPanelHoverObserver"]
    struct HoverObserver;

    impl HoverObserver {
        #[unsafe(method(mouseEntered:))]
        fn entered(&self, event: &NSEvent) {
            self.ivars().last_sample.set(None);
            self.activity(event);
        }

        #[unsafe(method(mouseMoved:))]
        fn moved(&self, event: &NSEvent) {
            self.activity(event);
        }

        #[unsafe(method(mouseExited:))]
        fn exited(&self, _: &NSEvent) {}
    }
);

impl HoverObserver {
    fn activity(&self, event: &NSEvent) {
        let mtm = self.mtm();
        let Some(window) = event.window(mtm) else {
            return;
        };
        if window.isKeyWindow() || !window.isVisible() {
            return;
        }

        let point = NSEvent::mouseLocation();
        let now = Instant::now();
        if let Some((last, position)) = self.ivars().last_sample.get() {
            if point == position || now.duration_since(last) < Duration::from_millis(80) {
                return;
            }
        }
        if NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(point, 0, mtm)
            != window.windowNumber()
        {
            return;
        }
        self.ivars().last_sample.set(Some((now, point)));
        (self.ivars().notify)();
    }
}

pub fn install<R: Runtime>(webview: &Webview<R>) -> tauri::Result<()> {
    let app = webview.app_handle().clone();
    webview.with_webview(move |native| {
        // SAFETY: Tauri lends the WKWebView (NSView subclass) on the AppKit
        // thread for this callback, and AppKit retains the installed area.
        let view = unsafe { &*native.inner().cast::<NSView>() };
        track(view, move || {
            let _ = app.emit_to(
                EventTarget::webview_window(crate::STOCK_PANEL_WINDOW_LABEL),
                "stock-panel-pointer-activity",
                (),
            );
        });
    })
}

fn track(view: &NSView, notify: impl Fn() + 'static) {
    let observer = HoverObserver::alloc(view.mtm()).set_ivars(HoverState {
        notify: Box::new(notify),
        last_sample: Cell::new(None),
    });
    let observer: Retained<HoverObserver> = unsafe { msg_send![super(observer), init] };
    // NSTrackingArea has a weak owner. Its immutable userInfo retains the
    // observer until the webview releases the area, including on expiry.
    let info = NSDictionary::from_slices(&[ns_string!("observer")], &[&*observer]);
    let area = unsafe {
        NSTrackingArea::initWithRect_options_owner_userInfo(
            NSTrackingArea::alloc(),
            NSRect::default(),
            Options::MouseEnteredAndExited
                | Options::MouseMoved
                | Options::ActiveAlways
                | Options::InVisibleRect,
            Some(&observer),
            Some(&Retained::cast_unchecked(info)),
        )
    };
    view.addTrackingArea(&area);
}
