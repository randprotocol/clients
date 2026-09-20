// Generates the Tauri context (config, capabilities, icons, and on Windows the app manifest) that
// `tauri::generate_context!()` expands into. Nothing else.
fn main() {
    tauri_build::build()
}
