//! Where the desktop wallet keeps its bytes.
//!
//! Two halves, exactly as in every other shell (`ui/engine/backend-shared.js` on `storage`):
//!
//!   * the **persistent** half — one JSON file under [`data_dir`], holding the encrypted vault,
//!     the public wallet facts, the settings, the cached asset registry and the note store. The
//!     engine reads and writes it whole; there is no `compareAndSet` and none is needed, because
//!     the desktop app is a single process with a single webview. There is no second tab to race.
//!   * the **session** half — a `HashMap` in this process's memory and nowhere else. It holds the
//!     plaintext spend key while the wallet is unlocked, and it is cleared when the process exits
//!     *by construction*: nothing ever persists it.
//!
//! What this replaces is worth naming. The previous (egui) desktop app kept the spend key in the
//! OS credential store **in plaintext**, relying entirely on keychain ACLs — the one shell that
//! did not encrypt it at rest. It is now the same password-derived AES-GCM vault every other shell
//! writes (`ui/engine/crypto.js`: PBKDF2-SHA256, 600 000 iterations), stored as an opaque blob in
//! the file below. A native convenience-unlock through the OS keychain or a biometric prompt is a
//! reasonable future enhancement; it is deliberately not built here, because it would be a second
//! way to reach the key and each one has to be got right.
//!
//! `Storage` is given its path rather than looking one up, so a test drives the real code against
//! a temporary directory without an environment variable that could redirect a real user's vault.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

/// `~/Library/Application Support/RandWallet`, `%APPDATA%\RandWallet`, `~/.config/RandWallet`.
///
/// Carried over unchanged from the egui app's `store.rs`, the one piece of it that survives: the
/// directory a user's wallet already lives in must not move underneath them.
pub fn data_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("RandWallet");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The file the persistent half lives in, inside [`data_dir`].
pub const STORE_FILE: &str = "wallet.json";

/// Create or replace `path` owner-only (mode 0600 on Unix) through a temporary file, so a reader
/// never sees a half-written store and no other account on the machine can read the vault.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        // `mode` applies only at creation: a tmp left by a crashed earlier write keeps whatever
        // permissions it had, and the rename below would carry them onto the store. Set them.
        f.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The persistent half: a JSON object of `key -> value`, read and written whole.
///
/// Values arrive from JavaScript already serialised (`JSON.stringify`) and go back the same way,
/// so this file never has to know the shape of a vault or a note store. They are parsed on the way
/// in only so the file on disk is a real JSON document rather than a map of strings-of-JSON —
/// which also means a malformed value is refused here rather than corrupting the store.
pub struct Storage {
    path: PathBuf,
    /// Every operation reads the file, changes it and writes it back; the lock is what makes that
    /// sequence atomic between the webview's concurrent invocations.
    lock: Mutex<()>,
}

impl Storage {
    pub fn new(path: PathBuf) -> Storage {
        Storage { path, lock: Mutex::new(()) }
    }

    /// The store under [`data_dir`] — what the running app uses.
    pub fn in_data_dir() -> Storage {
        Storage::new(data_dir().join(STORE_FILE))
    }

    /// A missing or unreadable file is an empty store, never an error: that is a wallet that has
    /// not been created yet, which is the ordinary first-run state.
    fn read(&self) -> BTreeMap<String, Value> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write(&self, map: &BTreeMap<String, Value>) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
        write_private(&self.path, &bytes)
    }

    fn guard(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.lock.lock().map_err(|_| "the wallet store lock is poisoned".to_string())
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        let _g = self.guard()?;
        Ok(self.read().get(key).map(|v| v.to_string()))
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let parsed: Value = serde_json::from_str(value).map_err(|e| format!("value for {key:?} is not JSON: {e}"))?;
        let _g = self.guard()?;
        let mut map = self.read();
        map.insert(key.to_string(), parsed);
        self.write(&map)
    }

    pub fn remove(&self, key: &str) -> Result<(), String> {
        let _g = self.guard()?;
        let mut map = self.read();
        if map.remove(key).is_none() {
            return Ok(());
        }
        self.write(&map)
    }

    /// `wallet.wipe()`. The file goes, rather than being rewritten empty: a rewrite through a
    /// temp-file rename leaves the old content's blocks exactly where they were. Neither is a
    /// secure erase — no userspace write is, on a copy-on-write or flash-backed filesystem — and
    /// this is the same guarantee every other shell gives (`storage.clear()` over IndexedDB or
    /// `chrome.storage`): the wallet forgets, and the disk is the operating system's business.
    ///
    /// The `tmp` twin goes with it: a write that died mid-way leaves that file behind, and a
    /// wipe that removed only the store would leave a full stale copy of it (vault included)
    /// on disk.
    pub fn clear(&self) -> Result<(), String> {
        let _g = self.guard()?;
        for path in [self.path.clone(), self.path.with_extension("tmp")] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }
}

/// The session half: memory, for this process, for as long as it runs.
///
/// This is where the plaintext spend key is, while the wallet is unlocked, and it is the only
/// place it is ever written — the same contract `chrome.storage.session` and a plain `Map` fill in
/// the other shells. Nothing here touches the disk, so a crash, a lock or a quit all forget it.
#[derive(Default)]
pub struct Session(Mutex<HashMap<String, String>>);

impl Session {
    fn guard(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, String>>, String> {
        self.0.lock().map_err(|_| "the wallet session lock is poisoned".to_string())
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.guard()?.get(key).cloned())
    }

    pub fn set(&self, key: &str, value: String) -> Result<(), String> {
        self.guard()?.insert(key.to_string(), value);
        Ok(())
    }

    pub fn remove(&self, key: &str) -> Result<(), String> {
        self.guard()?.remove(key);
        Ok(())
    }

    /// Emptied by `wallet.wipe()`, which must not leave the unlocked key behind it.
    pub fn clear(&self) -> Result<(), String> {
        self.guard()?.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// A store of its own per test, under the system temp directory. Not `data_dir()`: a test must
    /// never be able to touch the wallet of whoever is running it.
    fn temp_store() -> (Storage, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "rand-wallet-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(STORE_FILE);
        (Storage::new(path.clone()), path)
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let (store, path) = temp_store();
        assert_eq!(store.get("vault").unwrap(), None, "a store that does not exist yet is empty, not an error");

        store.set("vault", r#"{"kdf":"pbkdf2-sha256","iter":600000,"ct":"AA"}"#).unwrap();
        store.set("settings", r#"{"theme":"dark"}"#).unwrap();

        let vault: Value = serde_json::from_str(&store.get("vault").unwrap().unwrap()).unwrap();
        assert_eq!(vault["iter"], 600000);
        assert_eq!(vault["kdf"], "pbkdf2-sha256");

        // A second Storage over the same path is a restart of the app.
        let reopened = Storage::new(path.clone());
        let settings: Value = serde_json::from_str(&reopened.get("settings").unwrap().unwrap()).unwrap();
        assert_eq!(settings["theme"], "dark");

        // Every kind of JSON the engine stores, not only objects.
        store.set("head", "100").unwrap();
        store.set("assets", "[]").unwrap();
        store.set("nothing", "null").unwrap();
        assert_eq!(store.get("head").unwrap().unwrap(), "100");
        assert_eq!(store.get("assets").unwrap().unwrap(), "[]");
        assert_eq!(store.get("nothing").unwrap().unwrap(), "null");
    }

    #[test]
    fn overwrites_removes_and_clears() {
        let (store, path) = temp_store();
        store.set("settings", r#"{"theme":"dark"}"#).unwrap();
        store.set("settings", r#"{"theme":"light"}"#).unwrap();
        let settings: Value = serde_json::from_str(&store.get("settings").unwrap().unwrap()).unwrap();
        assert_eq!(settings["theme"], "light");

        store.set("vault", r#"{"ct":"AA"}"#).unwrap();
        store.remove("settings").unwrap();
        assert_eq!(store.get("settings").unwrap(), None);
        assert!(store.get("vault").unwrap().is_some(), "removing one key removed another");
        store.remove("settings").unwrap(); // removing what is not there is not an error

        store.clear().unwrap();
        assert_eq!(store.get("vault").unwrap(), None, "a wipe left the vault readable");
        assert!(!path.exists(), "a wipe left the store file on disk");
        store.clear().unwrap(); // …and clearing an already-cleared store is not an error either
    }

    #[test]
    fn a_wipe_takes_a_crashed_writes_tmp_with_it() {
        let (store, path) = temp_store();
        store.set("vault", r#"{"ct":"AA"}"#).unwrap();
        // A write that died before its rename: a full stale copy of the store, vault included.
        std::fs::write(path.with_extension("tmp"), br#"{"ct":"stale"}"#).unwrap();

        store.clear().unwrap();
        assert!(!path.exists(), "a wipe left the store file on disk");
        assert!(!path.with_extension("tmp").exists(), "a wipe left a crashed write's tmp on disk");
    }

    #[cfg(unix)]
    #[test]
    fn a_pre_existing_tmp_cannot_smuggle_wider_permissions_onto_the_store() {
        use std::os::unix::fs::PermissionsExt;
        let (store, path) = temp_store();
        // Simulate a tmp left behind by something less careful: the rename would carry its mode.
        std::fs::write(path.with_extension("tmp"), b"placeholder").unwrap();
        std::fs::set_permissions(&path.with_extension("tmp"), std::fs::Permissions::from_mode(0o644)).unwrap();

        store.set("vault", r#"{"ct":"AA"}"#).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a stale tmp's permissions reached the store: {mode:o}");
    }

    #[test]
    fn refuses_a_value_that_is_not_json() {
        let (store, _) = temp_store();
        let err = store.set("vault", "not json at all").unwrap_err();
        assert!(err.contains("is not JSON"), "{err}");
        assert_eq!(store.get("vault").unwrap(), None, "a refused write landed anyway");
    }

    #[cfg(unix)]
    #[test]
    fn the_store_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (store, path) = temp_store();
        store.set("vault", r#"{"ct":"AA"}"#).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the vault is readable by other accounts on this machine: {mode:o}");
    }

    #[test]
    fn the_session_is_memory_and_forgets() {
        let session = Session::default();
        assert_eq!(session.get("unlocked").unwrap(), None);
        session.set("unlocked", r#"{"spend_key":"aa"}"#.into()).unwrap();
        assert_eq!(session.get("unlocked").unwrap().unwrap(), r#"{"spend_key":"aa"}"#);
        session.remove("unlocked").unwrap();
        assert_eq!(session.get("unlocked").unwrap(), None, "a lock left the spend key in memory");

        session.set("unlocked", "1".into()).unwrap();
        session.clear().unwrap();
        assert_eq!(session.get("unlocked").unwrap(), None, "a wipe left the spend key in memory");

        // A new Session is a new process: nothing carries over, because nothing persisted it.
        assert_eq!(Session::default().get("unlocked").unwrap(), None);
    }
}
