//! Optional PC keyboard and application-launch keys on macOS.
//! IOKit filters individual input elements before invoking our callback. We
//! never subscribe to keyboard reports or open a device with exclusive access.
use core_foundation::{
    array::{CFArray, CFArrayGetCount, CFArrayGetValueAtIndex},
    base::{CFRelease, TCFType},
    dictionary::CFDictionary,
    number::CFNumber,
    runloop::{CFRunLoopGetMain, kCFRunLoopCommonModes},
    set::{CFSetGetCount, CFSetGetValues},
    string::CFString,
};
use io_kit_sys::{
    hid::{
        base::{IOHIDDeviceRef, IOHIDValueRef},
        device::IOHIDDeviceCopyMatchingElements,
        element::{
            IOHIDElementGetDevice, IOHIDElementGetType, IOHIDElementGetUsage,
            IOHIDElementGetUsagePage,
        },
        manager::*,
        value::{IOHIDValueGetElement, IOHIDValueGetIntegerValue, IOHIDValueGetLength},
    },
    ret::{IOReturn, kIOReturnNotPermitted, kIOReturnNotPrivileged},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ffi::c_void,
    ptr,
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};
use tauri_nspanel::objc2_app_kit::{NSEvent, NSEventModifierFlags as Modifiers};
use tauri_plugin_custom_window::{MAIN_WINDOW_LABEL, PREFERENCE_WINDOW_LABEL};

unsafe extern "C" {
    fn IOHIDCheckAccess(request_type: u32) -> u32;
}

#[derive(Debug, Copy, Clone, Hash, PartialEq, Eq, Serialize, Deserialize)]
pub enum Key {
    PrintScreen,
    ScrollLock,
    Pause,
    ContextMenu,
    LaunchApp1,
    LaunchApp2,
    LaunchMail,
    LaunchWebBrowser,
    LaunchFileBrowser,
    BrowserHome,
    BrowserSearch,
    BrowserFavorites,
    MediaSelect,
}

const USAGES: &[(Key, i32, i32)] = &[
    (Key::PrintScreen, 0x07, 0x46),
    (Key::ScrollLock, 0x07, 0x47),
    (Key::Pause, 0x07, 0x48),
    (Key::ContextMenu, 0x07, 0x65), // Keyboard Application
    // PC keyboards use AL Consumer Control Configuration for Media Select.
    (Key::MediaSelect, 0x0c, 0x183),
    (Key::LaunchMail, 0x0c, 0x18a),
    (Key::LaunchApp2, 0x0c, 0x192), // AL Calculator
    (Key::LaunchApp1, 0x0c, 0x194), // AL Local Machine Browser
    (Key::LaunchWebBrowser, 0x0c, 0x196),
    (Key::LaunchFileBrowser, 0x0c, 0x1b4),
    (Key::BrowserSearch, 0x0c, 0x221),
    (Key::BrowserHome, 0x0c, 0x223),
    (Key::BrowserFavorites, 0x0c, 0x22a),
];

fn identify(page: u32, usage: u32) -> Option<Key> {
    USAGES
        .iter()
        .find(|(_, p, u)| *p as u32 == page && *u as u32 == usage)
        .map(|&(key, _, _)| key)
}

fn element_filter(page: i32, usage: i32) -> CFDictionary<CFString, CFNumber> {
    CFDictionary::from_CFType_pairs(&[
        (
            CFString::from_static_string("UsagePage"),
            CFNumber::from(page),
        ),
        (CFString::from_static_string("Usage"), CFNumber::from(usage)),
    ])
}

#[derive(Default)]
struct KeysDown(HashSet<(usize, Key)>);

impl KeysDown {
    fn first_press(&mut self, device: usize, key: Key, down: bool) -> bool {
        if down {
            self.0.insert((device, key))
        } else {
            self.0.remove(&(device, key));
            false
        }
    }

    fn disconnect(&mut self, device: usize) {
        self.0.retain(|&(id, _)| id != device);
    }
}

struct Monitor {
    manager: IOHIDManagerRef,
    app: AppHandle,
    keys: HashSet<Key>,
    recording: bool,
    devices: HashMap<usize, Vec<Key>>,
    down: KeysDown,
}

// All configuration, callbacks and teardown run on the same AppKit run loop.
thread_local! { static MONITOR: RefCell<Option<Monitor>> = const { RefCell::new(None) }; }

impl Monitor {
    fn status(&self) -> &'static str {
        if self
            .devices
            .values()
            .flatten()
            .any(|key| self.recording || self.keys.contains(key))
        {
            "ready"
        } else {
            "noDevice"
        }
    }

    fn add_device(&mut self, device: IOHIDDeviceRef) {
        let mut supported = Vec::new();
        for &(key, page, usage) in USAGES {
            let filter = element_filter(page, usage);
            unsafe {
                let elements =
                    IOHIDDeviceCopyMatchingElements(device, filter.as_concrete_TypeRef(), 0);
                if !elements.is_null() {
                    let has_input = (0..CFArrayGetCount(elements)).any(|index| {
                        let element = CFArrayGetValueAtIndex(elements, index).cast_mut().cast();
                        (1..=4).contains(&IOHIDElementGetType(element))
                    });
                    CFRelease(elements.cast());
                    if has_input {
                        supported.push(key);
                    }
                }
            }
        }
        if !supported.is_empty() {
            self.devices.insert(device as usize, supported);
        }
    }

    fn start(app: AppHandle, keys: HashSet<Key>, recording: bool) -> Result<Self, &'static str> {
        unsafe {
            let manager = IOHIDManagerCreate(ptr::null(), 0);
            if manager.is_null() {
                return Err("unavailable");
            }
            let mut monitor = Self {
                manager,
                app,
                keys,
                recording,
                devices: HashMap::new(),
                down: KeysDown::default(),
            };
            // A composite USB receiver can expose its calculator under a mouse
            // collection. Filter by element usage, not primary keyboard type.
            let matches: Vec<_> = USAGES
                .iter()
                .map(|&(_, p, u)| element_filter(p, u))
                .collect();
            let matches = CFArray::from_CFTypes(&matches);
            IOHIDManagerSetInputValueMatchingMultiple(manager, matches.as_concrete_TypeRef());
            IOHIDManagerRegisterInputValueCallback(manager, value_changed, manager.cast());
            IOHIDManagerRegisterDeviceMatchingCallback(manager, connected, manager.cast());
            IOHIDManagerRegisterDeviceRemovalCallback(manager, disconnected, manager.cast());
            IOHIDManagerSetDeviceMatching(manager, ptr::null());
            IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), kCFRunLoopCommonModes);
            let result = IOHIDManagerOpen(manager, 0);
            if result != 0 {
                return Err(
                    if result == kIOReturnNotPermitted || result == kIOReturnNotPrivileged {
                        "permissionDenied"
                    } else {
                        "unavailable"
                    },
                );
            }
            let devices = IOHIDManagerCopyDevices(manager);
            if !devices.is_null() {
                let mut pointers = vec![ptr::null(); CFSetGetCount(devices) as usize];
                CFSetGetValues(devices, pointers.as_mut_ptr());
                for device in pointers {
                    monitor.add_device(device.cast_mut().cast());
                }
                CFRelease(devices.cast());
            }
            Ok(monitor)
        }
    }

    fn dispatch(&self, key: Key) {
        let (label, event) = if self.recording {
            if !self
                .app
                .get_webview_window(PREFERENCE_WINDOW_LABEL)
                .is_some_and(|w| w.is_focused().unwrap_or(false))
            {
                return;
            }
            (PREFERENCE_WINDOW_LABEL, "settings-hid-shortcut-recorded")
        } else if self.keys.contains(&key) {
            (MAIN_WINDOW_LABEL, "settings-hid-shortcut-pressed")
        } else {
            return;
        };
        let modifiers = Modifiers::Command
            | Modifiers::Control
            | Modifiers::Shift
            | Modifiers::Option
            | Modifiers::Function;
        if !NSEvent::modifierFlags_class().intersects(modifiers) {
            let _ = self.app.emit_to(EventTarget::labeled(label), event, key);
        }
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        unsafe {
            IOHIDManagerUnscheduleFromRunLoop(
                self.manager,
                CFRunLoopGetMain(),
                kCFRunLoopCommonModes,
            );
            IOHIDManagerClose(self.manager, 0);
            CFRelease(self.manager.cast());
        }
    }
}

// The callback context is an opaque identity, not a Rust pointer. A callback
// during configuration or from a retired manager cannot access freed state.
fn with_monitor(context: *mut c_void, f: impl FnOnce(&mut Monitor)) {
    let _ = MONITOR.try_with(|slot| {
        if let Ok(mut active) = slot.try_borrow_mut() {
            if let Some(m) = active.as_mut().filter(|m| m.manager.cast() == context) {
                f(m);
            }
        }
    });
}

unsafe extern "C" fn value_changed(
    context: *mut c_void,
    result: IOReturn,
    _: *mut c_void,
    value: IOHIDValueRef,
) {
    if result != 0 || value.is_null() {
        return;
    }
    unsafe {
        let element = IOHIDValueGetElement(value);
        if element.is_null() || IOHIDValueGetLength(value) > 4 {
            return;
        }
        let usage = IOHIDElementGetUsage(element);
        let Some(key) = identify(IOHIDElementGetUsagePage(element), usage) else {
            return;
        };
        let device = IOHIDElementGetDevice(element) as usize;
        let down = IOHIDValueGetIntegerValue(value) != 0;
        with_monitor(context, |m| {
            if m.down.first_press(device, key, down) {
                m.dispatch(key);
            }
        });
    }
}

fn update_devices(context: *mut c_void, f: impl FnOnce(&mut Monitor)) {
    with_monitor(context, |m| {
        let old = m.status();
        f(m);
        let status = m.status();
        if old != status {
            let _ = m.app.emit_to(
                EventTarget::labeled(MAIN_WINDOW_LABEL),
                "settings-hid-shortcut-status",
                status,
            );
        }
    })
}

unsafe extern "C" fn connected(
    context: *mut c_void,
    result: IOReturn,
    _: *mut c_void,
    device: IOHIDDeviceRef,
) {
    if result == 0 && !device.is_null() {
        update_devices(context, |m| m.add_device(device));
    }
}

unsafe extern "C" fn disconnected(
    context: *mut c_void,
    _: IOReturn,
    _: *mut c_void,
    device: IOHIDDeviceRef,
) {
    update_devices(context, |m| {
        m.devices.remove(&(device as usize));
        m.down.disconnect(device as usize);
    });
}

fn configure(app: AppHandle, keys: HashSet<Key>, recording: bool) -> &'static str {
    MONITOR.with_borrow_mut(|slot| {
        if keys.is_empty() && !recording {
            slot.take();
            return "disabled";
        }
        // kIOHIDRequestTypeListenEvent, kIOHIDAccessTypeGranted. The existing
        // Input Monitoring setting owns the system permission request.
        if unsafe { IOHIDCheckAccess(1) } != 0 {
            slot.take();
            return "permissionDenied";
        }
        if let Some(m) = slot {
            m.keys = keys;
            m.recording = recording;
        } else {
            match Monitor::start(app, keys, recording) {
                Ok(m) => *slot = Some(m),
                Err(status) => return status,
            }
        }
        slot.as_ref().unwrap().status()
    })
}

#[tauri::command]
pub async fn set_shortcut_hid_keys(
    window: WebviewWindow,
    keys: HashSet<Key>,
    recording: bool,
) -> Result<&'static str, String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("only the desktop pet manages hardware shortcuts".into());
    }
    let app = window.app_handle().clone();
    let (send, mut recv) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            let _ = send.try_send(configure(app, keys, recording));
        })
        .map_err(|e| e.to_string())?;
    recv.recv()
        .await
        .ok_or_else(|| "hardware shortcut monitor stopped".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pc_keyboard_and_app_keys_are_distinct() {
        assert_eq!(identify(7, 0x46), Some(Key::PrintScreen));
        assert_eq!(identify(7, 0x65), Some(Key::ContextMenu));
        assert_eq!(identify(0x0c, 0x183), Some(Key::MediaSelect));
        assert_eq!(identify(0x0c, 0x18a), Some(Key::LaunchMail));
        assert_eq!(identify(0x0c, 0x192), Some(Key::LaunchApp2));
        assert_eq!(identify(0x0c, 0x194), Some(Key::LaunchApp1));
        assert_eq!(identify(0x0c, 0x196), Some(Key::LaunchWebBrowser));
        assert_eq!(identify(0x0c, 0x1b4), Some(Key::LaunchFileBrowser));
        assert_eq!(identify(0x0c, 0x221), Some(Key::BrowserSearch));
        assert_eq!(identify(0x0c, 0x223), Some(Key::BrowserHome));
        assert_eq!(identify(0x0c, 0x22a), Some(Key::BrowserFavorites));
        assert_eq!(identify(7, 0x47), Some(Key::ScrollLock));
        assert_eq!(identify(7, 0x48), Some(Key::Pause));
        for (page, usage) in [
            (7, 4),
            (7, 0x76),
            (7, 0xe1),
            (0xc, 0xe9),
            (0xc, 0x30),
            (1, 6),
            (8, 3),
        ] {
            assert_eq!(identify(page, usage), None);
        }
    }

    #[test]
    fn repeats_and_unplugged_keyboards() {
        let mut down = KeysDown::default();
        assert!(down.first_press(1, Key::Pause, true));
        assert!(!down.first_press(1, Key::Pause, true));
        assert!(down.first_press(2, Key::Pause, true));
        assert!(!down.first_press(1, Key::Pause, false));
        assert!(down.first_press(1, Key::Pause, true));
        down.disconnect(1);
        assert!(down.first_press(1, Key::Pause, true));
        assert!(!down.first_press(2, Key::Pause, true));
    }
}
