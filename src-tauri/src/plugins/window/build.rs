const COMMANDS: &[&str] = &[
    "show_window",
    "set_page_gesture",
    "request_window_recovery",
    "take_window_recovery_request",
    "reveal_recovered_main",
    "display_work_areas",
    "hide_window",
    "set_always_on_top",
    "set_taskbar_visibility",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
