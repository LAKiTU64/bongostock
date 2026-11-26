//! Observe the default media output; never change system routing, volume or mute.
//! Consumers must mute/pause for unknown or !monitoring and discard older revisions.
//! CoreAudio notifications arrive after routing changes: this is not an audio gate
//! and cannot guarantee that no samples reach a speaker before the webview reacts.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputKind {
    Headphones,
    Speaker,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputState {
    pub revision: u64,
    pub route_id: String,
    pub kind: OutputKind,
    pub monitoring: bool,
}

impl AudioOutputState {
    fn unknown(revision: u64) -> Self {
        Self {
            revision,
            route_id: String::new(),
            kind: OutputKind::Unknown,
            monitoring: false,
        }
    }
}

#[tauri::command]
pub fn get_audio_output_state() -> AudioOutputState {
    #[cfg(target_os = "macos")]
    return macos::current();
    #[cfg(not(target_os = "macos"))]
    AudioOutputState::unknown(0)
}

pub fn init_audio_output(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    macos::init(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn shutdown_audio_output() {
    #[cfg(target_os = "macos")]
    macos::shutdown();
}

#[cfg(any(target_os = "macos", test))]
mod classification {
    use super::OutputKind;

    pub const BUILT_IN: u32 = u32::from_be_bytes(*b"bltn");
    pub const BLUETOOTH: u32 = u32::from_be_bytes(*b"blue");
    pub const BLUETOOTH_LE: u32 = u32::from_be_bytes(*b"blea");
    pub const HEADPHONES: u32 = u32::from_be_bytes(*b"hdph");
    pub const SPEAKER: u32 = u32::from_be_bytes(*b"spkr");
    // IOAudioTypes.h: kIOAudioSelectorControlSelectionValue*, not device names.
    const JACK_HEADPHONES: u32 = u32::from_be_bytes(*b"hdpn");
    const INTERNAL_SPEAKER: u32 = u32::from_be_bytes(*b"ispk");
    const EXTERNAL_SPEAKER: u32 = u32::from_be_bytes(*b"espk");

    pub fn bluetooth_kind(class: u32) -> OutputKind {
        // BluetoothAssignedNumbers.h. HandsFree is deliberately excluded: it
        // includes car kits and speakerphones. Service bits do not identify ears.
        if class & 3 != 0 || (class >> 8) & 0x1f != 4 {
            return OutputKind::Unknown;
        }
        match (class >> 2) & 0x3f {
            1 | 6 => OutputKind::Headphones,
            5 => OutputKind::Speaker,
            _ => OutputKind::Unknown,
        }
    }

    pub fn classify(
        transport: u32,
        sources: Option<&[u32]>,
        terminals: &[u32],
        bluetooth: OutputKind,
    ) -> OutputKind {
        if terminals.is_empty() {
            return OutputKind::Unknown;
        }
        // Aggregate, virtual, AirPlay and display outputs can fan out. Do not
        // infer safety from a headphone child or an arbitrary driver label.
        if ![
            BUILT_IN,
            BLUETOOTH,
            BLUETOOTH_LE,
            u32::from_be_bytes(*b"usb "),
            u32::from_be_bytes(*b"1394"),
            u32::from_be_bytes(*b"thun"),
        ]
        .contains(&transport)
        {
            return OutputKind::Unknown;
        }
        let all_headphones = terminals.iter().all(|v| *v == HEADPHONES);
        let all_speakers = terminals.iter().all(|v| {
            [
                SPEAKER,
                u32::from_be_bytes(*b"lfes"),
                u32::from_be_bytes(*b"rspk"),
            ]
            .contains(v)
        });
        if transport == BUILT_IN {
            if let Some(sources) = sources {
                // Only Apple's built-in selector uses these SDK-defined item
                // values here. Third-party selector item IDs are driver-defined.
                if !sources.is_empty()
                    && sources.iter().all(|v| *v == JACK_HEADPHONES)
                    && (all_headphones || all_speakers)
                {
                    return OutputKind::Headphones;
                }
                if !sources.is_empty()
                    && sources
                        .iter()
                        .all(|v| [INTERNAL_SPEAKER, EXTERNAL_SPEAKER].contains(v))
                    && all_speakers
                {
                    return OutputKind::Speaker;
                }
                return OutputKind::Unknown;
            }
        } else if sources.is_some() {
            // An unclassified selectable output may change independently of its
            // stream's general terminal type.
            return OutputKind::Unknown;
        }
        if all_headphones {
            OutputKind::Headphones
        } else if transport == BLUETOOTH || transport == BLUETOOTH_LE {
            // Bluetooth HAL streams often have a generic speaker terminal. A
            // connected device alone is insufficient; require matched CoD.
            if all_speakers || terminals.iter().all(|v| *v == 0) {
                bluetooth
            } else {
                OutputKind::Unknown
            }
        } else if all_speakers {
            OutputKind::Speaker
        } else {
            OutputKind::Unknown
        }
    }

    pub fn bluetooth_address(uid: &str) -> Option<String> {
        // HAL UID formats are not a public identity contract. Accept only an
        // exact MAC or MAC:output, then verify against IOBluetooth's address.
        // Never match a connected device by name or by a substring of its UID.
        let address = uid.strip_suffix(":output").unwrap_or(uid);
        let bytes = address.as_bytes();
        if bytes.len() != 17 || ![b':', b'-'].contains(&bytes[2]) {
            return None;
        }
        let separator = bytes[2];
        for (i, byte) in bytes.iter().enumerate() {
            if i % 3 == 2 {
                if *byte != separator {
                    return None;
                }
            } else if !byte.is_ascii_hexdigit() {
                return None;
            }
        }
        Some(address.replace('-', ":").to_ascii_uppercase())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{classification::*, AudioOutputState, OutputKind};
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        mem::size_of,
        ptr,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            Mutex, OnceLock,
        },
        thread::{self, Thread},
        time::{Duration, Instant},
    };
    use tauri::Emitter;

    const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const OUTPUT: u32 = u32::from_be_bytes(*b"outp");
    const DEFAULT_OUTPUT: u32 = u32::from_be_bytes(*b"dOut");
    const DEVICES: u32 = u32::from_be_bytes(*b"dev#");
    const STREAMS: u32 = u32::from_be_bytes(*b"stm#");
    const DATA_SOURCE: u32 = u32::from_be_bytes(*b"ssrc");
    const RUNNING: u32 = u32::from_be_bytes(*b"goin");
    const RUNNING_SOMEWHERE: u32 = u32::from_be_bytes(*b"gone");
    const ALIVE: u32 = u32::from_be_bytes(*b"livn");
    const TRANSPORT: u32 = u32::from_be_bytes(*b"tran");
    const UID: u32 = u32::from_be_bytes(*b"uid ");
    const TERMINAL: u32 = u32::from_be_bytes(*b"term");
    const UTF8: u32 = 0x08000100;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }
    fn address(selector: u32, scope: u32) -> Address {
        Address {
            selector,
            scope,
            element: 0,
        }
    }
    type Listener = unsafe extern "C" fn(u32, u32, *const Address, *mut c_void) -> i32;

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectHasProperty(object: u32, address: *const Address) -> u8;
        fn AudioObjectGetPropertyDataSize(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
        fn AudioObjectAddPropertyListener(
            object: u32,
            address: *const Address,
            callback: Listener,
            context: *mut c_void,
        ) -> i32;
        fn AudioObjectRemovePropertyListener(
            object: u32,
            address: *const Address,
            callback: Listener,
            context: *mut c_void,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
        fn CFStringGetCString(
            value: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            value: *const c_char,
            encoding: u32,
        ) -> *const c_void;
    }
    #[link(name = "IOBluetooth", kind = "framework")]
    unsafe extern "C" {}
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }

    struct Shared {
        // One atomic word couples notification order and route invalidation.
        // Even bits reserve a revision pair; bit 0 stays set until the worker
        // commits a resolved snapshot. Running-only changes preserve this bit.
        revision: AtomicU64,
        stopped: AtomicBool,
        worker: OnceLock<Thread>,
        published: Mutex<AudioOutputState>,
    }
    impl Shared {
        fn new() -> Self {
            Self {
                revision: AtomicU64::new(3),
                stopped: AtomicBool::new(false),
                worker: OnceLock::new(),
                published: Mutex::new(AudioOutputState::unknown(0)),
            }
        }
        fn signal(&self, route_change: bool) {
            let _ = self
                .revision
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |old| {
                    Some(((old & !1) + 2) | (old & 1) | u64::from(route_change))
                });
            if let Some(worker) = self.worker.get() {
                worker.unpark();
            }
        }
        fn wait_for_retry(&self, processed: u64, delay: Duration) {
            let deadline = Instant::now() + delay;
            loop {
                let token = self.revision.load(Ordering::SeqCst);
                if self.stopped.load(Ordering::SeqCst) || token & !1 != processed {
                    return;
                }
                let now = Instant::now();
                if now >= deadline {
                    // A timer retry is not a new route change. Reserve work
                    // without invalidating the snapshot or waking ourselves.
                    let _ = self.revision.compare_exchange(
                        token,
                        token + 2,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    return;
                }
                // Recheck the deadline after stale permits or spurious wakeups.
                thread::park_timeout(deadline - now);
            }
        }
        fn current(&self) -> AudioOutputState {
            let published = self.published.lock().unwrap_or_else(|e| e.into_inner());
            let token = self.revision.load(Ordering::SeqCst);
            if self.stopped.load(Ordering::SeqCst) || token & 1 != 0 {
                AudioOutputState::unknown(token & !1)
            } else {
                published.clone()
            }
        }
        // None means a newer notification won; Some reports whether to emit.
        fn commit(&self, token: u64, state: &AudioOutputState, resolved: bool) -> Option<bool> {
            let mut published = self.published.lock().unwrap_or_else(|e| e.into_inner());
            if self.stopped.load(Ordering::SeqCst) {
                return None;
            }
            // Clear invalidation and replace the cached snapshot under the
            // same lock used by command reads. A callback never takes it.
            if self
                .revision
                .compare_exchange(
                    token,
                    if resolved { token & !1 } else { token },
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_err()
            {
                return None;
            }
            // Starting/stopping media changes device running state. Recheck it,
            // but retain the public revision when the route is unchanged so a
            // player never pauses in response to its own playback.
            if resolved
                && token & 1 == 0
                && published.route_id == state.route_id
                && published.kind == state.kind
                && published.monitoring == state.monitoring
            {
                return Some(false);
            }
            *published = state.clone();
            Some(true)
        }
        fn publish(
            &self,
            app: &tauri::AppHandle,
            token: u64,
            state: AudioOutputState,
            resolved: bool,
        ) -> bool {
            match self.commit(token, &state, resolved) {
                None => false,
                Some(false) => true,
                Some(true) => {
                    // A racing callback already invalidates command reads. This
                    // event predates that callback's next invalidation revision.
                    let _ = app.emit("audio-output-changed", state);
                    true
                }
            }
        }
    }
    // HAL removal does not document waiting for callbacks already in flight.
    // Retain this one small context for process lifetime; it contains no AppHandle
    // and cannot dangle, even when a device disappears or listener removal fails.
    static SHARED: OnceLock<Shared> = OnceLock::new();

    pub fn current() -> AudioOutputState {
        SHARED
            .get()
            .map_or_else(|| AudioOutputState::unknown(0), Shared::current)
    }
    pub fn init(app: &tauri::AppHandle) {
        if SHARED.set(Shared::new()).is_err() {
            return;
        }
        let shared = SHARED.get().unwrap();
        let app = app.clone();
        if thread::Builder::new()
            .name("audio-output-monitor".into())
            .spawn(move || {
                struct StopOnExit(&'static Shared);
                impl Drop for StopOnExit {
                    fn drop(&mut self) {
                        self.0.signal(true);
                        self.0.stopped.store(true, Ordering::SeqCst);
                    }
                }
                let _stop_on_exit = StopOnExit(shared);
                let _ = shared.worker.set(thread::current());
                monitor(&app, shared);
            })
            .is_err()
        {
            shared.stopped.store(true, Ordering::SeqCst);
        }
    }
    pub fn shutdown() {
        if let Some(shared) = SHARED.get() {
            shared.signal(true);
            shared.stopped.store(true, Ordering::SeqCst);
        }
    }

    unsafe extern "C" fn changed(
        _object: u32,
        count: u32,
        addresses: *const Address,
        context: *mut c_void,
    ) -> i32 {
        // Only atomics and a worker wakeup on the HAL/IO thread: no property
        // queries, allocations, locks, event serialization or Objective-C here.
        // SAFETY: context points to the process-lifetime SHARED, and HAL owns
        // the supplied address array for the duration of this callback.
        let shared = unsafe { &*context.cast::<Shared>() };
        if !shared.stopped.load(Ordering::SeqCst) {
            let mut route_change = count == 0 || addresses.is_null();
            if !addresses.is_null() {
                for i in 0..count as usize {
                    let selector = unsafe { (*addresses.add(i)).selector };
                    route_change |= selector != RUNNING && selector != RUNNING_SOMEWHERE;
                }
            }
            // Running notifications require rechecking, not routing invalidation:
            // muting/pausing itself changes running state.
            shared.signal(route_change);
        }
        0
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Subscription {
        object: u32,
        address: Address,
    }
    struct Listeners {
        entries: Vec<Subscription>,
        shared: &'static Shared,
    }
    impl Listeners {
        fn context(&self) -> *mut c_void {
            ptr::from_ref(self.shared).cast_mut().cast()
        }
        fn add(&mut self, object: u32, address: Address) -> Result<(), ()> {
            let entry = Subscription { object, address };
            if self.entries.contains(&entry) {
                return Ok(());
            }
            // SAFETY: stable callback/context and a valid property address.
            if unsafe { AudioObjectAddPropertyListener(object, &address, changed, self.context()) }
                != 0
            {
                return Err(());
            }
            self.entries.push(entry);
            Ok(())
        }
        fn retire(
            &mut self,
            desired: &[Subscription],
            mut remove: impl FnMut(&Subscription) -> i32,
        ) -> Result<(), ()> {
            // AudioHardwareBase.h: the device/stream can disappear before its
            // listener is removed. There is no remaining subscription to retry.
            const BAD_OBJECT: i32 = i32::from_be_bytes(*b"!obj");
            let mut failed = false;
            self.entries.retain(|entry| {
                if desired.contains(entry) {
                    return true;
                }
                match remove(entry) {
                    0 | BAD_OBJECT => false,
                    status => {
                        eprintln!(
                            "Audio listener removal failed: object={}, OSStatus={status}",
                            entry.object
                        );
                        failed = true;
                        true // Other failures retry with backoff; context stays valid.
                    }
                }
            });
            if failed {
                Err(())
            } else {
                Ok(())
            }
        }
        fn keep(&mut self, desired: &[Subscription]) -> Result<(), ()> {
            let context = self.context();
            // SAFETY: remove exactly the registered listener tuple.
            let mut failed = self
                .retire(desired, |entry| unsafe {
                    AudioObjectRemovePropertyListener(
                        entry.object,
                        &entry.address,
                        changed,
                        context,
                    )
                })
                .is_err();
            for entry in desired {
                if self.add(entry.object, entry.address).is_err() {
                    failed = true;
                }
            }
            if failed {
                Err(())
            } else {
                Ok(())
            }
        }
    }
    impl Drop for Listeners {
        fn drop(&mut self) {
            let _ = self.keep(&[]);
        }
    }
    fn has(object: u32, address: Address) -> bool {
        // SAFETY: address is a correctly laid-out SDK AudioObjectPropertyAddress.
        unsafe { AudioObjectHasProperty(object, &address) != 0 }
    }
    fn values(object: u32, address: Address) -> Result<Vec<u32>, ()> {
        let mut size = 0;
        // SAFETY: all out-pointers refer to initialized, writable buffers.
        if unsafe { AudioObjectGetPropertyDataSize(object, &address, 0, ptr::null(), &mut size) }
            != 0
            || size > 4096
            || size % 4 != 0
        {
            return Err(());
        }
        let mut data = vec![0u32; size as usize / 4];
        let capacity = size;
        if unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                ptr::null(),
                &mut size,
                data.as_mut_ptr().cast(),
            )
        } != 0
            || size > capacity
            || size % 4 != 0
        {
            return Err(());
        }
        data.truncate(size as usize / 4);
        Ok(data)
    }
    fn scalar(object: u32, address: Address) -> Result<u32, ()> {
        let data = values(object, address)?;
        if data.len() == 1 {
            Ok(data[0])
        } else {
            Err(())
        }
    }
    struct CfString(*const c_void);
    impl Drop for CfString {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }
    fn string(value: *const c_void) -> Result<String, ()> {
        if value.is_null() {
            return Err(());
        }
        let mut buffer = [0u8; 1024];
        // SAFETY: value is a CFString from a typed SDK property/method; writable
        // buffer is bounded, and successful CFStringGetCString adds its NUL.
        if unsafe {
            CFStringGetCString(
                value,
                buffer.as_mut_ptr().cast(),
                buffer.len() as isize,
                UTF8,
            )
        } == 0
        {
            return Err(());
        }
        unsafe { CStr::from_ptr(buffer.as_ptr().cast()) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| ())
    }
    fn uid(object: u32) -> Result<String, ()> {
        let mut value = CfString(ptr::null());
        let mut size = size_of::<*const c_void>() as u32;
        // SDK: caller owns the CFString returned by DeviceUID.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address(UID, GLOBAL),
                0,
                ptr::null(),
                &mut size,
                ptr::from_mut(&mut value.0).cast(),
            )
        };
        if status != 0 || size != size_of::<*const c_void>() as u32 {
            return Err(());
        }
        string(value.0)
    }

    fn bluetooth_type(uid: &str) -> OutputKind {
        let Some(expected) = bluetooth_address(uid) else {
            return OutputKind::Unknown;
        };
        let Ok(address) = CString::new(expected.as_str()) else {
            return OutputKind::Unknown;
        };
        // IOBluetoothDevice.h: deviceWithAddressString:, isConnected,
        // addressString and classOfDevice. These read identity only; no pairing,
        // scanning, connecting or connection-opening APIs are invoked.
        unsafe {
            let pool = objc_autoreleasePoolPush();
            let result = (|| {
                let class = objc_getClass(c"IOBluetoothDevice".as_ptr());
                if class.is_null() {
                    return OutputKind::Unknown;
                }
                let value = CfString(CFStringCreateWithCString(
                    ptr::null(),
                    address.as_ptr(),
                    UTF8,
                ));
                if value.0.is_null() {
                    return OutputKind::Unknown;
                }
                // SDK signatures use object pointers, UInt32 and BOOL. Explicit
                // signatures avoid variadic ABI and objc_msgSend_stret issues.
                let send_object_arg: unsafe extern "C" fn(
                    *mut c_void,
                    *mut c_void,
                    *const c_void,
                ) -> *mut c_void = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                let send_object: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                let send_bool: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i8 =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                let send_u32: unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32 =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                let device = send_object_arg(
                    class,
                    sel_registerName(c"deviceWithAddressString:".as_ptr()),
                    value.0,
                );
                if device.is_null()
                    || send_bool(device, sel_registerName(c"isConnected".as_ptr())) == 0
                {
                    return OutputKind::Unknown;
                }
                let actual = send_object(device, sel_registerName(c"addressString".as_ptr()));
                if string(actual)
                    .ok()
                    .and_then(|s| bluetooth_address(&s))
                    .as_ref()
                    != Some(&expected)
                {
                    return OutputKind::Unknown;
                }
                bluetooth_kind(send_u32(
                    device,
                    sel_registerName(c"classOfDevice".as_ptr()),
                ))
            })();
            objc_autoreleasePoolPop(pool);
            result
        }
    }

    fn topology(listeners: &mut Listeners) -> Result<(u32, Vec<u32>), ()> {
        let device = scalar(1, address(DEFAULT_OUTPUT, GLOBAL))?;
        if device == 0 {
            return Err(());
        }
        let streams = values(device, address(STREAMS, OUTPUT))?;
        if streams.is_empty() {
            return Err(());
        }
        let mut desired = vec![
            Subscription {
                object: 1,
                address: address(DEFAULT_OUTPUT, GLOBAL),
            },
            Subscription {
                object: 1,
                address: address(DEVICES, GLOBAL),
            },
        ];
        for (selector, scope) in [
            (ALIVE, GLOBAL),
            (RUNNING, GLOBAL),
            (STREAMS, OUTPUT),
            (TRANSPORT, GLOBAL),
            (UID, GLOBAL),
        ] {
            desired.push(Subscription {
                object: device,
                address: address(selector, scope),
            });
        }
        for (selector, scope) in [
            (DATA_SOURCE, OUTPUT),
            (RUNNING_SOMEWHERE, GLOBAL),
            (u32::from_be_bytes(*b"jack"), OUTPUT),
        ] {
            let property = address(selector, scope);
            if has(device, property) {
                desired.push(Subscription {
                    object: device,
                    address: property,
                });
            }
        }
        for stream in &streams {
            desired.push(Subscription {
                object: *stream,
                address: address(TERMINAL, GLOBAL),
            });
        }
        listeners.keep(&desired)?;
        Ok((device, streams))
    }

    fn snapshot(device: u32, streams: &[u32]) -> Result<(String, OutputKind), ()> {
        if scalar(device, address(ALIVE, GLOBAL))? != 1 {
            return Err(());
        }
        // Read running state so query failure is fail-closed, but an idle device
        // remains an eligible route: requiring active IO would prevent auto-play.
        let _ = scalar(device, address(RUNNING, GLOBAL))?;
        let transport = scalar(device, address(TRANSPORT, GLOBAL))?;
        let uid = uid(device)?;
        if uid.is_empty() {
            return Err(());
        }
        let source_property = address(DATA_SOURCE, OUTPUT);
        let sources = if has(device, source_property) {
            Some(values(device, source_property)?)
        } else {
            None
        };
        let terminals = streams
            .iter()
            .map(|stream| scalar(*stream, address(TERMINAL, GLOBAL)))
            .collect::<Result<Vec<_>, _>>()?;
        let bluetooth = if [BLUETOOTH, BLUETOOTH_LE].contains(&transport) {
            bluetooth_type(&uid)
        } else {
            OutputKind::Unknown
        };
        let kind = classify(transport, sources.as_deref(), &terminals, bluetooth);
        // Include selected data sources and stream identity so a shared built-in
        // device ID cannot hide a jack/speaker transition. This ID stays local.
        Ok((
            format!("{device}:{uid}:{sources:?}:{streams:?}:{terminals:?}"),
            kind,
        ))
    }

    fn monitor(app: &tauri::AppHandle, shared: &'static Shared) {
        let mut listeners = Listeners {
            entries: Vec::new(),
            shared,
        };
        let mut processed = 0;
        let mut retry = true;
        while !shared.stopped.load(Ordering::SeqCst) {
            let token = shared.revision.load(Ordering::SeqCst);
            let revision = token & !1;
            if revision == processed {
                if retry {
                    shared.wait_for_retry(processed, Duration::from_secs(2));
                } else {
                    thread::park();
                }
                continue;
            }
            if token & 1 != 0 {
                // Always deliver invalidation before any metadata/identity work.
                if !shared.publish(app, token, AudioOutputState::unknown(revision), false) {
                    continue;
                }
            }
            let roots_ok = listeners.add(1, address(DEFAULT_OUTPUT, GLOBAL)).is_ok()
                && listeners.add(1, address(DEVICES, GLOBAL)).is_ok();
            let result = if roots_ok {
                topology(&mut listeners)
            } else {
                Err(())
            };
            let monitoring = result.is_ok();
            let detected = result.and_then(|(device, streams)| {
                let result = snapshot(device, &streams)?;
                // Cover default/stream topology changes during synchronous HAL
                // reads even before the corresponding notification is delivered.
                if scalar(1, address(DEFAULT_OUTPUT, GLOBAL))? != device
                    || values(device, address(STREAMS, OUTPUT))? != streams
                {
                    return Err(());
                }
                Ok(result)
            });
            let mut state = AudioOutputState::unknown(revision + 1);
            state.monitoring = monitoring;
            if let Ok((route_id, kind)) = detected {
                state.route_id = route_id;
                state.kind = kind;
            }
            retry = !state.monitoring || state.kind == OutputKind::Unknown;
            if shared.publish(app, token, state, true) {
                processed = revision;
            }
        }
        // Listeners are removed on this same non-real-time worker. The immortal
        // callback context remains safe if HAL is already shutting down.
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn route_notification_invalidates_a_previously_safe_snapshot() {
            let shared = Shared::new();
            shared.revision.store(2, Ordering::SeqCst);
            *shared.published.lock().unwrap() = AudioOutputState {
                revision: 3,
                route_id: "test".into(),
                kind: OutputKind::Headphones,
                monitoring: true,
            };
            assert_eq!(shared.current().kind, OutputKind::Headphones);
            shared.signal(true);
            assert_eq!(shared.current(), AudioOutputState::unknown(4));
        }
        #[test]
        fn running_notification_does_not_cause_pause_resume_feedback() {
            let shared = Shared::new();
            shared.revision.store(2, Ordering::SeqCst);
            *shared.published.lock().unwrap() = AudioOutputState {
                revision: 3,
                route_id: "test".into(),
                kind: OutputKind::Headphones,
                monitoring: true,
            };
            shared.signal(false);
            assert_eq!(shared.current().kind, OutputKind::Headphones);
            assert_eq!(shared.revision.load(Ordering::SeqCst), 4);
            let mut same_route = shared.current();
            same_route.revision = 5;
            assert_eq!(shared.commit(4, &same_route, true), Some(false));
            assert_eq!(shared.current().revision, 3);
            // A route invalidation racing this read must still win.
            shared.signal(true);
            assert_eq!(shared.commit(4, &same_route, true), None);
            assert_eq!(shared.current(), AudioOutputState::unknown(6));
        }
        #[test]
        fn disappeared_objects_are_retired_without_blocking_the_new_route() {
            let shared = SHARED.get_or_init(Shared::new);
            let old = Subscription {
                object: 84,
                address: address(RUNNING, GLOBAL),
            };
            let current = Subscription {
                object: 86,
                address: address(RUNNING, GLOBAL),
            };
            let mut listeners = Listeners {
                entries: vec![old, current],
                shared,
            };
            let mut calls = 0;
            assert_eq!(
                listeners.retire(&[current], |entry| {
                    assert_eq!(*entry, old);
                    calls += 1;
                    i32::from_be_bytes(*b"!obj")
                }),
                Ok(())
            );
            assert_eq!(listeners.entries, vec![current]);
            assert_eq!(
                listeners.retire(&[current], |_| {
                    calls += 1;
                    -1
                }),
                Ok(())
            );
            assert_eq!(calls, 1);
            // Avoid real HAL calls when dropping synthetic subscriptions.
            listeners.entries.clear();
        }
        #[test]
        fn other_removal_failures_are_retained_for_a_later_retry() {
            let shared = SHARED.get_or_init(Shared::new);
            let entry = Subscription {
                object: 84,
                address: address(RUNNING, GLOBAL),
            };
            let mut listeners = Listeners {
                entries: vec![entry],
                shared,
            };
            assert_eq!(listeners.retire(&[], |_| -1), Err(()));
            assert_eq!(listeners.entries, vec![entry]);
            assert_eq!(listeners.retire(&[], |_| 0), Ok(()));
            assert!(listeners.entries.is_empty());
        }
        #[test]
        fn retries_wait_even_with_a_stale_wakeup_and_do_not_emit_duplicate_state() {
            thread::spawn(|| {
                let shared = Shared::new();
                shared.worker.set(thread::current()).unwrap();
                shared.revision.store(2, Ordering::SeqCst);
                let mut state = AudioOutputState::unknown(3);
                *shared.published.lock().unwrap() = state.clone();
                for processed in [2, 4] {
                    thread::current().unpark();
                    let delay = Duration::from_millis(15);
                    let started = Instant::now();
                    shared.wait_for_retry(processed, delay);
                    assert!(started.elapsed() >= delay);
                    assert_eq!(shared.revision.load(Ordering::SeqCst), processed + 2);
                    state.revision = processed + 3;
                    assert_eq!(shared.commit(processed + 2, &state, true), Some(false));
                    assert_eq!(shared.current().revision, 3);
                }
            })
            .join()
            .unwrap();
        }
        #[test]
        fn stopped_monitor_never_returns_cached_headphones() {
            let shared = Shared::new();
            shared.stopped.store(true, Ordering::SeqCst);
            assert!(!shared.current().monitoring);
            assert_eq!(shared.current().kind, OutputKind::Unknown);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{classification::*, *};
    #[test]
    fn payload_matches_frontend_contract() {
        assert_eq!(
            serde_json::to_value(AudioOutputState::unknown(12)).unwrap(),
            serde_json::json!({
                "revision": 12, "routeId": "", "kind": "unknown", "monitoring": false,
            })
        );
    }
    #[test]
    fn typed_terminals_and_builtin_selector() {
        assert_eq!(
            classify(BUILT_IN, None, &[HEADPHONES], OutputKind::Unknown),
            OutputKind::Headphones
        );
        assert_eq!(
            classify(
                BUILT_IN,
                Some(&[u32::from_be_bytes(*b"hdpn")]),
                &[SPEAKER],
                OutputKind::Unknown
            ),
            OutputKind::Headphones
        );
        assert_eq!(
            classify(
                BUILT_IN,
                Some(&[u32::from_be_bytes(*b"ispk")]),
                &[SPEAKER],
                OutputKind::Unknown
            ),
            OutputKind::Speaker
        );
        assert_eq!(
            classify(BUILT_IN, Some(&[123]), &[HEADPHONES], OutputKind::Unknown),
            OutputKind::Unknown
        );
        assert_eq!(
            classify(BUILT_IN, None, &[HEADPHONES, SPEAKER], OutputKind::Unknown),
            OutputKind::Unknown
        );
        assert_eq!(
            classify(BUILT_IN, None, &[], OutputKind::Unknown),
            OutputKind::Unknown
        );
    }
    #[test]
    fn bluetooth_requires_terminal_or_matched_specific_class() {
        assert_eq!(
            classify(BLUETOOTH, None, &[SPEAKER], OutputKind::Unknown),
            OutputKind::Unknown
        );
        for minor in [1, 6] {
            assert_eq!(
                bluetooth_kind(0x200000 | (4 << 8) | (minor << 2)),
                OutputKind::Headphones
            );
        }
        for minor in [0, 2, 4, 7, 8, 10] {
            assert_eq!(bluetooth_kind((4 << 8) | (minor << 2)), OutputKind::Unknown);
        }
        assert_eq!(bluetooth_kind((4 << 8) | (5 << 2)), OutputKind::Speaker);
        assert_eq!(bluetooth_kind((2 << 8) | (6 << 2)), OutputKind::Unknown);
        assert_eq!(
            classify(BLUETOOTH, None, &[SPEAKER], bluetooth_kind(0x0418)),
            OutputKind::Headphones
        );
        assert_eq!(
            classify(
                BLUETOOTH,
                None,
                &[HEADPHONES, SPEAKER],
                OutputKind::Headphones
            ),
            OutputKind::Unknown
        );
    }
    #[test]
    fn bluetooth_uid_mapping_is_exact_not_a_name_heuristic() {
        assert_eq!(
            bluetooth_address("AA-BB-CC-DD-EE-FF:output").as_deref(),
            Some("AA:BB:CC:DD:EE:FF")
        );
        assert_eq!(
            bluetooth_address("aa:bb:cc:dd:ee:ff").as_deref(),
            Some("AA:BB:CC:DD:EE:FF")
        );
        for uid in [
            "Headphones",
            "耳机",
            "xAA-BB-CC-DD-EE-FF",
            "AA-BB-CC-DD-EE-FF:input",
            "AA-BB:CC-DD-EE-FF",
            "GG-BB-CC-DD-EE-FF",
        ] {
            assert!(bluetooth_address(uid).is_none(), "{uid}");
        }
    }
    #[test]
    fn fanout_and_unknown_selectors_are_not_safe() {
        for transport in [
            u32::from_be_bytes(*b"grup"),
            u32::from_be_bytes(*b"virt"),
            u32::from_be_bytes(*b"airp"),
            0,
        ] {
            assert_eq!(
                classify(transport, None, &[HEADPHONES], OutputKind::Headphones),
                OutputKind::Unknown
            );
        }
        assert_eq!(
            classify(
                u32::from_be_bytes(*b"usb "),
                Some(&[1]),
                &[HEADPHONES],
                OutputKind::Unknown
            ),
            OutputKind::Unknown
        );
    }
}
