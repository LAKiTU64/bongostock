//! A local monitor for the opted-in stock-panel video viewport only.
//! Phased events are consumed and routed as complete packets; unphased mouse
//! wheels are never intercepted or classified by delta size/precision.
use tauri::{Runtime, WebviewWindow};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl ScrollRect {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|value| value.is_finite())
            && self.x >= 0.0 && self.y >= 0.0
            && self.width > 0.0 && self.height > 0.0
            && self.x + self.width <= 1.000001 && self.y + self.height <= 1.000001
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GestureRegion {
    epoch: String,
    region: ScrollRect,
    exclusions: Vec<ScrollRect>,
}

impl GestureRegion {
    fn valid(&self) -> bool {
        !self.epoch.is_empty() && self.epoch.len() <= 100
            && self.region.valid() && self.exclusions.len() <= 64
            && self.exclusions.iter().all(ScrollRect::valid)
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        self.region.contains(x, y) && !self.exclusions.iter().any(|rect| rect.contains(x, y))
    }
}

#[tauri::command]
pub async fn set_page_gesture<R: Runtime>(
    window: WebviewWindow<R>,
    region: Option<GestureRegion>,
) -> Result<(), String> {
    if window.label() != crate::STOCK_PANEL_WINDOW_LABEL {
        return Err("page gestures are only available in stock-panel".into());
    }
    if region.as_ref().is_some_and(|region| !region.valid()) {
        return Err("invalid page gesture region".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let target = window.clone();
        window.with_webview(move |webview| {
            let result = macos::configure(target, webview.inner(), region);
            let _ = sender.try_send(result);
        }).map_err(|error| error.to_string())?;
        receiver.recv().await.ok_or("gesture configuration was cancelled")?
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[cfg(target_os = "macos")]
pub mod macos {
    use super::*;
    use block2::RcBlock;
    use std::{cell::RefCell, ptr::NonNull};
    use tauri::{Emitter, EventTarget};
    use tauri_nspanel::{
        objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject},
        objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventPhase, NSView},
    };

    thread_local! {
        static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct GesturePacket {
        epoch: String,
        phase: usize,
        momentum_phase: usize,
        delta_x: f64,
        delta_y: f64,
        delta_mode: u8,
        x: f64,
        y: f64,
    }

    // Called on the AppKit thread, including from the plugin's Destroyed hook.
    pub fn clear() {
        MONITOR.with(|slot| {
            if let Some(monitor) = slot.borrow_mut().take() {
                // SAFETY: this object came from addLocalMonitor below.
                unsafe { NSEvent::removeMonitor(&monitor) };
            }
        });
    }

    pub fn configure<R: Runtime>(
        window: WebviewWindow<R>,
        webview: *mut std::ffi::c_void,
        region: Option<GestureRegion>,
    ) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("gesture monitor is not on main thread")?;
        clear();
        let Some(region) = region else { return Ok(()) };
        // SAFETY: Tauri supplies the live WKWebView (an NSView subclass), on its
        // owning thread. Retain it until the monitor is removed.
        let view = unsafe { Retained::retain(webview.cast::<NSView>()) }
            .ok_or("missing native webview")?;
        let native_window = view.window().ok_or("missing native window")?;
        let number = native_window.windowNumber();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit lends a valid event for this callback.
            let sample = unsafe { event.as_ref() };
            let phase = sample.phase();
            let momentum = sample.momentumPhase();
            if sample.windowNumber() != number || !native_window.isVisible()
                || (phase == NSEventPhase::None && momentum == NSEventPhase::None)
                || sample.modifierFlags().intersects(
                    NSEventModifierFlags::Control | NSEventModifierFlags::Option | NSEventModifierFlags::Command,
                )
            {
                return event.as_ptr();
            }
            // Convert from AppKit window points into the same top-left CSS
            // viewport used by getBoundingClientRect, including webview scaling.
            let point = view.convertPoint_fromView(sample.locationInWindow(), None);
            let bounds = view.bounds();
            if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
                return event.as_ptr();
            }
            let x = (point.x - bounds.origin.x) / bounds.size.width;
            let local_y = point.y - bounds.origin.y;
            let y = (if view.isFlipped() { local_y } else { bounds.size.height - local_y })
                / bounds.size.height;
            if !region.contains(x, y) {
                return event.as_ptr();
            }
            let packet = GesturePacket {
                epoch: region.epoch.clone(),
                phase: phase.0,
                momentum_phase: momentum.0,
                // AppKit scroll deltas and DOM wheel deltas have opposite signs.
                delta_x: -sample.scrollingDeltaX(),
                delta_y: -sample.scrollingDeltaY(),
                delta_mode: 0,
                x, y,
            };
            if window.emit_to(EventTarget::webview_window(crate::STOCK_PANEL_WINDOW_LABEL), "stock-panel-page-gesture", packet).is_ok() {
                std::ptr::null_mut() // Never also deliver this event as a DOM wheel.
            } else {
                event.as_ptr()
            }
        });
        // SAFETY: callback returns the original live event or null only. AppKit
        // copies the block; all captured AppKit objects stay on the main thread.
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &handler)
        }.ok_or("could not install page gesture monitor")?;
        let _ = mtm;
        MONITOR.with(|slot| *slot.borrow_mut() = Some(monitor));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_is_finite_and_half_open() {
        let mut region = GestureRegion { epoch: "test".into(), region: ScrollRect { x: 0.1, y: 0.2, width: 0.8, height: 0.6 }, exclusions: vec![ScrollRect { x: 0.2, y: 0.3, width: 0.1, height: 0.1 }] };
        assert!(region.valid());
        assert!(region.contains(0.1, 0.2));
        assert!(!region.contains(0.9, 0.3));
        assert!(!region.contains(0.2, 0.8));
        assert!(!region.contains(0.2, 0.1));
        assert!(!region.contains(0.25, 0.35));
        region.region.width = f64::NAN;
        assert!(!region.valid());
    }

    #[test]
    fn rejects_invalid_scope_and_exclusions() {
        let full = ScrollRect { x: 0.0, y: 0.0, width: 1.0, height: 1.0 };
        let mut region = GestureRegion { epoch: "test".into(), region: full.clone(), exclusions: vec![] };
        assert!(region.valid());
        for epoch in [String::new(), "x".repeat(101)] {
            region.epoch = epoch;
            assert!(!region.valid());
        }
        region.epoch = "test".into();
        region.exclusions = vec![full.clone(); 65];
        assert!(!region.valid());
        region.exclusions = vec![full; 64];
        assert!(region.valid());
        assert!(!region.contains(0.5, 0.5));
        region.exclusions[0].height = f64::INFINITY;
        assert!(!region.valid());
    }

    #[test]
    fn rejects_offscreen_and_empty_rectangles() {
        for rect in [
            ScrollRect { x: -0.1, y: 0.0, width: 0.5, height: 0.5 },
            ScrollRect { x: 0.0, y: 0.8, width: 0.5, height: 0.5 },
            ScrollRect { x: 0.8, y: 0.0, width: 0.5, height: 0.5 },
            ScrollRect { x: 0.0, y: 0.0, width: 0.0, height: 0.5 },
            ScrollRect { x: 0.0, y: 0.0, width: 0.5, height: -0.5 },
        ] {
            assert!(!rect.valid());
        }
    }
}
