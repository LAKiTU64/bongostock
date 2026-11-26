use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, EventTarget, Listener, Manager, Runtime, WebviewWindow};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
    time::{sleep, timeout},
};

use crate::commands::{
    PREFERENCE_WINDOW_LABEL, STOCK_PANEL_WINDOW_LABEL, ensure_window, reveal_window,
};

fn retention_duration(minutes: Option<u32>) -> Result<Duration, String> {
    let minutes = minutes.unwrap_or(60);
    if !(1..=1440).contains(&minutes) {
        return Err("hidden panel retention must be between 1 and 1440 minutes".into());
    }
    Ok(Duration::from_secs(u64::from(minutes) * 60))
}

struct Retention {
    deadline: SystemTime,
    timer: JoinHandle<()>,
}

#[derive(Default)]
pub(crate) struct HiddenPanel {
    // Serialize the pet's open request against hiding and expiring this window.
    retention: Mutex<Option<Retention>>,
    destroyed: Notify,
}

impl HiddenPanel {
    pub fn did_destroy(&self) {
        self.destroyed.notify_one();
    }
}

fn remaining(deadline: SystemTime, now: SystemTime) -> Duration {
    deadline.duration_since(now).unwrap_or_default()
}

async fn wait_for_deadline(deadline: SystemTime) {
    loop {
        let delay = remaining(deadline, SystemTime::now());
        if delay.is_zero() {
            return;
        }
        // System sleep can suspend a monotonic timer. Also check wall time on
        // wake; every request to reopen checks the same deadline immediately.
        sleep(delay.min(Duration::from_secs(5))).await;
    }
}

fn cancel(retention: &mut Option<Retention>) {
    if let Some(previous) = retention.take() {
        previous.timer.abort();
    }
}

// destroy() queues actual destruction. A subsequent explicit open must wait
// until the old instance of this label has left Tauri's window registry.
async fn wait_until_removed<R: Runtime>(
    window: &WebviewWindow<R>,
    state: &HiddenPanel,
) -> Result<(), String> {
    timeout(Duration::from_secs(5), async {
        while window
            .app_handle()
            .get_webview_window(window.label())
            .is_some()
        {
            state.destroyed.notified().await;
        }
    })
    .await
    .map_err(|_| format!("window {} did not close", window.label()))
}

async fn destroy<R: Runtime>(window: &WebviewWindow<R>, state: &HiddenPanel) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())?;
    wait_until_removed(window, state).await
}

pub async fn open_preferences<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<HiddenPanel>();
    let _guard = state.retention.lock().await;
    ensure_window(app, PREFERENCE_WINDOW_LABEL)
}

pub async fn discard_for_boss_key<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<HiddenPanel>();
    let mut retention = state.retention.lock().await;
    cancel(&mut retention);

    let pref = app.get_webview_window(PREFERENCE_WINDOW_LABEL);
    let pref_close = pref.as_ref().map(|w| w.destroy()).transpose();
    let mut panel_close = Ok(());
    if let Some(panel) = app.get_webview_window(STOCK_PANEL_WINDOW_LABEL) {
        let _ = panel.hide();
        // Let a mounted player save its last position. A cold or stalled
        // webview can never prevent the native side from stopping playback.
        let (send, stopped) = tokio::sync::oneshot::channel();
        let listener = panel.once("stock-panel-playback-stopped", move |_| {
            let _ = send.send(());
        });
        if panel
            .emit_to(
                EventTarget::labeled(STOCK_PANEL_WINDOW_LABEL),
                "close-stock-panel",
                "boss",
            )
            .is_ok()
        {
            let _ = timeout(Duration::from_millis(120), stopped).await;
        }
        panel.unlisten(listener);
        panel_close = destroy(&panel, &state).await;
    }
    pref_close.map_err(|e| e.to_string())?;
    if let Some(pref) = pref {
        wait_until_removed(&pref, &state).await?;
    }
    panel_close
}

#[tauri::command]
pub async fn hide_panel_for_hour<R: Runtime>(
    window: WebviewWindow<R>,
    retention_minutes: Option<u32>,
) -> Result<(), String> {
    if window.label() != STOCK_PANEL_WINDOW_LABEL {
        return Err("only the stock panel can hide itself with retention".into());
    }
    let duration = retention_duration(retention_minutes)?;
    let state = window.state::<HiddenPanel>();
    let mut retention = state.retention.lock().await;
    if retention.is_some() {
        return Ok(());
    }
    window.hide().map_err(|e| e.to_string())?;
    let deadline = SystemTime::now() + duration;
    let target = window.clone();
    let timer = tokio::spawn(async move {
        wait_for_deadline(deadline).await;
        let state = target.state::<HiddenPanel>();
        loop {
            let mut current = state.retention.lock().await;
            if current.as_ref().map(|r| r.deadline) != Some(deadline) {
                return;
            }
            if target
                .app_handle()
                .get_webview_window(STOCK_PANEL_WINDOW_LABEL)
                .is_none()
            {
                current.take();
                return;
            }
            match destroy(&target, &state).await {
                Ok(()) => {
                    current.take();
                    return;
                }
                Err(error) => eprintln!("could not close the hidden stock panel: {error}"),
            }
            // Keep the expired lease so opens also have to retire this window.
            // Release the lock during backoff so open/close can make progress.
            drop(current);
            sleep(Duration::from_secs(1)).await;
        }
    });
    *retention = Some(Retention { deadline, timer });
    Ok(())
}

pub async fn hide_normally<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let state = window.state::<HiddenPanel>();
    let mut retention = state.retention.lock().await;
    window.hide().map_err(|e| e.to_string())?;
    cancel(&mut retention);
    Ok(())
}

pub async fn open<R: Runtime>(app: &AppHandle<R>, requester: &str) -> Result<(), String> {
    let state = app.state::<HiddenPanel>();
    let mut retention = state.retention.lock().await;
    // The panel also reports its own readiness through show_labeled_window.
    // Remounting a hidden webview must not act like a click on the pet.
    if requester == STOCK_PANEL_WINDOW_LABEL {
        if retention.is_none() {
            reveal_window(app, STOCK_PANEL_WINDOW_LABEL);
        }
        return Ok(());
    }
    if let (Some(lease), Some(window)) = (
        retention.as_ref(),
        app.get_webview_window(STOCK_PANEL_WINDOW_LABEL),
    ) {
        if remaining(lease.deadline, SystemTime::now()).is_zero() {
            destroy(&window, &state).await?;
        } else {
            // The same webview, position, and player are still live.
            window.show().map_err(|e| e.to_string())?;
            let _ = window.set_focus();
        }
    }
    cancel(&mut retention);
    ensure_window(app, STOCK_PANEL_WINDOW_LABEL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[test]
    fn defaults_to_one_hour_and_rejects_invalid_minutes() {
        assert_eq!(retention_duration(None).unwrap(), Duration::from_secs(3600));
        assert!(retention_duration(Some(0)).is_err());
        assert!(retention_duration(Some(1441)).is_err());
    }

    #[test]
    fn restores_only_before_the_configured_deadline() {
        let start = UNIX_EPOCH + Duration::from_secs(1234);
        for minutes in [1, 15, 60, 1440] {
            let duration = retention_duration(Some(minutes)).unwrap();
            let deadline = start + duration;
            assert_eq!(
                remaining(deadline, start).as_secs(),
                u64::from(minutes) * 60
            );
            assert_eq!(
                remaining(deadline, deadline - Duration::from_millis(1)),
                Duration::from_millis(1)
            );
            assert!(remaining(deadline, deadline).is_zero());
            assert!(remaining(deadline, deadline + Duration::from_secs(1)).is_zero());
        }
    }
}
