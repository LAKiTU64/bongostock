use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
    time::{sleep, timeout},
};

use crate::commands::{STOCK_PANEL_WINDOW_LABEL, ensure_window};

const RETENTION: Duration = Duration::from_secs(60 * 60);

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

// destroy() queues actual destruction. Wait for removal from Tauri's window
// registry before letting a simultaneous pet click reuse the same label.
async fn destroy<R: Runtime>(window: &WebviewWindow<R>, state: &HiddenPanel) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())?;
    timeout(Duration::from_secs(5), async {
        while window
            .app_handle()
            .get_webview_window(STOCK_PANEL_WINDOW_LABEL)
            .is_some()
        {
            state.destroyed.notified().await;
        }
    })
    .await
    .map_err(|_| "the hidden stock panel did not close".to_string())
}

#[tauri::command]
pub async fn hide_panel_for_hour<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    if window.label() != STOCK_PANEL_WINDOW_LABEL {
        return Err("only the stock panel can hide itself for an hour".into());
    }
    let state = window.state::<HiddenPanel>();
    let mut retention = state.retention.lock().await;
    if retention.is_some() {
        return Ok(());
    }
    window.hide().map_err(|e| e.to_string())?;
    let deadline = SystemTime::now() + RETENTION;
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
    if requester == STOCK_PANEL_WINDOW_LABEL && retention.is_some() {
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
    fn restores_only_before_the_one_hour_deadline() {
        let start = UNIX_EPOCH + Duration::from_secs(1234);
        let deadline = start + RETENTION;
        assert_eq!(remaining(deadline, start), Duration::from_secs(3600));
        assert_eq!(
            remaining(deadline, start + Duration::from_millis(3_599_999)),
            Duration::from_millis(1)
        );
        assert!(remaining(deadline, start + Duration::from_secs(3600)).is_zero());
        assert!(remaining(deadline, start + Duration::from_secs(7200)).is_zero());
    }
}
