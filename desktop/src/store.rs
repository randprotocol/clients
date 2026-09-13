//! Persistence: settings and the note store as JSON under the OS config directory
//! (`~/Library/Application Support/RandWallet`, `%APPDATA%\RandWallet`, `~/.config/RandWallet`).
//! The note store is a cache of chain data plus this wallet's own submissions — every note row
//! is recoverable by rescanning from leaf 0.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use wallet_core::{OwnedNote, SentRow};

pub const TIME_WINDOW: u64 = 256;

pub fn data_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("RandWallet");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub rpc_url: String,
    pub chain_id: u64,
    pub dark: bool,
    pub backed_up: bool,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings { rpc_url: wallet_core::DEFAULT_RPC_URL.into(), chain_id: wallet_core::DEFAULT_CHAIN_ID, dark: true, backed_up: false }
    }
}

impl Settings {
    fn path() -> PathBuf {
        data_dir().join("settings.json")
    }
    pub fn load() -> Settings {
        std::fs::read_to_string(Self::path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    pub fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = write_private(&Self::path(), s.as_bytes());
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SubmissionStatus {
    Pending,
    Committed,
    Failed,
}

/// A transfer this wallet submitted: the hash and the payment's per-transaction key, so the user
/// can disclose exactly that payment later.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Submission {
    pub hash: String,
    pub time: u32,
    pub amount: String,
    pub to: String,
    pub fee: String,
    pub tx_key: String,
    pub status: SubmissionStatus,
    pub height: Option<u64>,
    pub submitted_unix: u64,
}

impl Submission {
    pub fn units(&self) -> u64 {
        self.amount.parse().unwrap_or(0)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NoteStore {
    pub scanned_index: u64,
    pub scanned_height: u64,
    #[serde(default)]
    pub scanned_attest_height: u64,
    pub notes: Vec<OwnedNote>,
    #[serde(default)]
    pub sent: Vec<SentRow>,
    #[serde(default)]
    pub submissions: Vec<Submission>,
}

impl NoteStore {
    fn path() -> PathBuf {
        data_dir().join("notes.json")
    }
    pub fn load() -> NoteStore {
        std::fs::read_to_string(Self::path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    pub fn save(&self) -> Result<(), String> {
        let s = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        write_private(&Self::path(), s.as_bytes())
    }
    pub fn delete() {
        let _ = std::fs::remove_file(Self::path());
    }

    /// Spendable SHRUGG (asset 0), in units.
    pub fn balance(&self) -> u64 {
        self.notes.iter().filter(|n| n.is_spendable() && n.asset == 0).map(|n| n.units()).sum()
    }

    pub fn pending_out(&self) -> u64 {
        self.submissions
            .iter()
            .filter(|s| s.status == SubmissionStatus::Pending)
            .map(|s| s.units() + s.fee.parse::<u64>().unwrap_or(0))
            .sum()
    }

    /// Merge a scanned page by leaf index; a deposit rebuilt without an index is placed when its
    /// leaf appears.
    pub fn merge(&mut self, received: Vec<OwnedNote>, sent: Vec<SentRow>) {
        for n in received {
            if self.notes.iter().any(|x| x.index == n.index) {
                continue;
            }
            if let Some(d) = self.notes.iter_mut().find(|x| x.index == u64::MAX && x.cm == n.cm) {
                d.index = n.index;
                d.height = n.height;
            } else {
                self.notes.push(n);
            }
        }
        for s in sent {
            if !self.sent.iter().any(|x| x.index == s.index) {
                self.sent.push(s);
            }
        }
    }

    pub fn add_deposit(&mut self, note: OwnedNote) {
        if !self.notes.iter().any(|x| x.cm == note.cm) {
            self.notes.push(note);
        }
    }

    pub fn mark_spent(&mut self, nullifiers: &[String]) {
        for n in &mut self.notes {
            if nullifiers.iter().any(|nf| nf == &n.nf) {
                n.spent = true;
            }
        }
    }

    pub fn hold_pending(&mut self, indices: &[u64], time: u32) {
        for n in &mut self.notes {
            if indices.contains(&n.index) {
                n.pending = Some(time);
            }
        }
    }

    pub fn clear_pending(&mut self, read_through: u64) {
        for n in &mut self.notes {
            if wallet_core::pending_cleared(n, read_through) {
                n.pending = None;
            }
        }
        for s in &mut self.submissions {
            if s.status == SubmissionStatus::Pending && read_through > s.time as u64 + TIME_WINDOW {
                s.status = SubmissionStatus::Failed;
            }
        }
    }

    pub fn advance_scanned_height(&mut self, paged_to: u64, head_before: u64) {
        self.scanned_height = self.scanned_height.max(paged_to).max(head_before.saturating_add(1));
    }
}

/// Create or replace `path` owner-only (mode 0600 on Unix) through a temporary file.
pub fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// SHRUGG amounts: mirrors `shrugg_core::format_amount` / `parse_amount`.
pub mod amount {
    pub const UNITS: u64 = 1_000_000_000;

    pub fn format(units: u64) -> String {
        let whole = units / UNITS;
        let frac = units % UNITS;
        if frac == 0 {
            return whole.to_string();
        }
        let s = format!("{frac:09}");
        format!("{whole}.{}", s.trim_end_matches('0'))
    }

    pub fn format_str(units: &str) -> String {
        format(units.parse().unwrap_or(0))
    }

    pub fn parse(text: &str) -> Option<u64> {
        let s = text.trim();
        let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
        if whole.is_empty() && frac.is_empty() || frac.len() > 9 {
            return None;
        }
        let whole: u64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
        let frac: u64 = if frac.is_empty() { 0 } else { format!("{frac:0<9}").parse().ok()? };
        whole.checked_mul(UNITS)?.checked_add(frac)
    }
}

pub fn shortened(s: &str, head: usize, tail: usize) -> String {
    if s.chars().count() <= head + tail + 1 {
        return s.to_string();
    }
    let h: String = s.chars().take(head).collect();
    let t: String = s.chars().rev().take(tail).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{h}…{t}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(index: u64, amount: u64, cm: &str) -> OwnedNote {
        OwnedNote {
            index,
            note: "00".into(),
            cm: cm.into(),
            nf: format!("nf{index}"),
            amount: amount.to_string(),
            asset: 0,
            time: 1,
            from: "pk".into(),
            height: 1,
            spent: false,
            pending: None,
        }
    }

    #[test]
    fn merge_spent_pending_and_balance() {
        let mut s = NoteStore::default();
        s.merge(vec![note(1, 5, "a"), note(2, 0, "b")], vec![]);
        s.merge(vec![note(1, 5, "a"), note(3, 7, "c")], vec![]);
        assert_eq!(s.notes.len(), 3);
        assert_eq!(s.balance(), 12);
        s.mark_spent(&["nf3".into()]);
        assert_eq!(s.balance(), 5);
        s.hold_pending(&[1], 100);
        assert_eq!(s.balance(), 0);
        s.clear_pending(100 + TIME_WINDOW);
        assert_eq!(s.balance(), 0);
        s.clear_pending(100 + TIME_WINDOW + 1);
        assert_eq!(s.balance(), 5);
        s.add_deposit(note(u64::MAX, 9, "dep"));
        s.add_deposit(note(u64::MAX, 9, "dep"));
        s.merge(vec![note(40, 9, "dep")], vec![]);
        assert_eq!(s.notes.iter().filter(|n| n.cm == "dep").count(), 1);
        assert_eq!(s.notes.iter().find(|n| n.cm == "dep").unwrap().index, 40);
        s.scanned_height = 10;
        s.advance_scanned_height(10, 20);
        assert_eq!(s.scanned_height, 21);
    }

    #[test]
    fn amounts() {
        assert_eq!(amount::format(1_500_000_000), "1.5");
        assert_eq!(amount::format(1), "0.000000001");
        assert_eq!(amount::parse("1.5"), Some(1_500_000_000));
        assert_eq!(amount::parse(".25"), Some(250_000_000));
        assert_eq!(amount::parse("0.0000000001"), None);
        assert_eq!(amount::parse("x"), None);
        assert_eq!(shortened("shrugg1abcdefghijklmnop", 10, 4), "shrugg1abc…mnop");
    }
}
