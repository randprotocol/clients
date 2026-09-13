//! The spend key in the OS credential store (macOS Keychain, Windows Credential Manager, the
//! Linux kernel keyring), with an owner-only file under the data directory as the fallback on
//! systems where no store is available.

use crate::store::{data_dir, write_private};

const SERVICE: &str = "org.randprotocol.wallet";
const USER: &str = "spend_key";

fn entry() -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, USER).ok()
}

fn fallback_path() -> std::path::PathBuf {
    data_dir().join("spend.key")
}

pub fn save(spend_key_hex: &str) -> Result<(), String> {
    if let Some(e) = entry() {
        if e.set_password(spend_key_hex).is_ok() {
            let _ = std::fs::remove_file(fallback_path());
            return Ok(());
        }
    }
    write_private(&fallback_path(), spend_key_hex.as_bytes())
}

pub fn load() -> Option<String> {
    if let Some(e) = entry() {
        if let Ok(p) = e.get_password() {
            return Some(p);
        }
    }
    std::fs::read_to_string(fallback_path()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn exists() -> bool {
    load().is_some()
}

pub fn delete() {
    if let Some(e) = entry() {
        let _ = e.delete_credential();
    }
    let _ = std::fs::remove_file(fallback_path());
}

/// Where the key lives, for the Settings screen.
pub fn location() -> &'static str {
    if fallback_path().exists() {
        "an owner-only file in the data directory"
    } else if cfg!(target_os = "macos") {
        "the macOS Keychain"
    } else if cfg!(target_os = "windows") {
        "Windows Credential Manager"
    } else {
        "the Linux kernel keyring"
    }
}
