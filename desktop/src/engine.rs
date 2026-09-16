//! The wallet engine: one worker thread that owns the RPC client and runs scan, send and faucet
//! (design spec §3.2), reporting back to the UI over a channel. The spend key lives in the UI
//! state while unlocked and is cloned into a job only for its duration.

use crate::rpc::Rpc;
use crate::store::{NoteStore, Submission, SubmissionStatus};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wallet_core::{ProveInput, ProveRequest, Wallet};

const PAGE: usize = 500;
const COMMIT_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Idle,
    Syncing,
    Selecting,
    FetchingWitnesses,
    Proving { started: Instant },
    Submitting,
    WaitingForCommit { hash: String },
}

#[derive(Clone, Debug)]
pub struct SendOutcome {
    pub hash: String,
    pub amount: String,
    pub fee: String,
    pub change: String,
    pub tx_key: String,
    pub proof_bytes: usize,
    pub tier: u8,
    pub proving_secs: f64,
    pub committed_height: Option<u64>,
}

/// What the worker tells the UI.
#[derive(Debug)]
pub enum Event {
    Phase(Phase),
    StoreChanged,
    SyncDone(Result<(), String>),
    SendDone(Result<SendOutcome, String>),
    FaucetDone(Result<String, String>),
    Connection(Result<String, String>),
}

pub enum Job {
    Sync,
    Send { to: String, amount: u64, fee: u64, chain_id: u64 },
    Faucet,
    TestConnection { chain_id: u64 },
    RescanFromZero,
}

pub struct Engine {
    jobs: Sender<(Job, String)>,
    pub events: Receiver<Event>,
}

impl Engine {
    /// `store` is shared with the UI; `rpc_url` is read at the start of every job.
    pub fn start(store: Arc<Mutex<NoteStore>>, rpc_url: Arc<Mutex<String>>, repaint: impl Fn() + Send + 'static) -> Engine {
        let (jobs, job_rx) = mpsc::channel::<(Job, String)>();
        let (events, event_rx) = mpsc::channel::<Event>();
        std::thread::Builder::new()
            .name("wallet-engine".into())
            .spawn(move || {
                let emit = |e: Event| {
                    let _ = events.send(e);
                    repaint();
                };
                for (job, spend_key) in job_rx {
                    let rpc = Rpc::new(&rpc_url.lock().unwrap());
                    let ctx = Ctx { rpc, store: store.clone(), emit: &emit };
                    match job {
                        Job::Sync => {
                            let r = Wallet::from_hex(&spend_key).and_then(|w| ctx.scan(&w));
                            emit(Event::SyncDone(r));
                        }
                        Job::RescanFromZero => {
                            {
                                let mut s = store.lock().unwrap();
                                let subs = std::mem::take(&mut s.submissions);
                                *s = NoteStore { submissions: subs, ..Default::default() };
                                let _ = s.save();
                            }
                            let r = Wallet::from_hex(&spend_key).and_then(|w| ctx.scan(&w));
                            emit(Event::SyncDone(r));
                        }
                        Job::Send { to, amount, fee, chain_id } => {
                            let r = Wallet::from_hex(&spend_key).and_then(|w| ctx.send(&w, &to, amount, fee, chain_id));
                            emit(Event::Phase(Phase::Idle));
                            emit(Event::SendDone(r));
                        }
                        Job::Faucet => {
                            let r = Wallet::from_hex(&spend_key).and_then(|w| ctx.faucet(&w));
                            emit(Event::FaucetDone(r));
                        }
                        Job::TestConnection { chain_id } => {
                            emit(Event::Connection(ctx.test_connection(chain_id)));
                        }
                    }
                }
            })
            .expect("engine thread");
        Engine { jobs, events: event_rx }
    }

    pub fn submit(&self, job: Job, spend_key: &str) {
        let _ = self.jobs.send((job, spend_key.to_string()));
    }
}

struct Ctx<'a> {
    rpc: Rpc,
    store: Arc<Mutex<NoteStore>>,
    emit: &'a dyn Fn(Event),
}

impl Ctx<'_> {
    fn phase(&self, p: Phase) {
        (self.emit)(Event::Phase(p));
    }

    /// Mirrors `randprotocol_client::wallet::scan`: rebuilt bridge deposits, then every unseen leaf
    /// through the core's trial decryption, then the nullifier set, then pending bookkeeping.
    fn scan(&self, w: &Wallet) -> Result<(), String> {
        self.phase(Phase::Syncing);
        let mut s = self.store.lock().unwrap().clone();

        let head0 = self.rpc.head_height()?;
        if s.scanned_attest_height <= head0 {
            if self.rpc.bridge_enabled()? {
                for h in s.scanned_attest_height..=head0 {
                    for action in self.rpc.block_actions(h)? {
                        if let Some(n) = wallet_core::rebuilt_deposit(w, &action) {
                            s.add_deposit(n);
                        }
                    }
                }
            }
            s.scanned_attest_height = head0 + 1;
        }

        loop {
            let rows = self.rpc.commitments(s.scanned_index, PAGE)?;
            if rows.is_empty() {
                break;
            }
            let before = s.scanned_index;
            let parsed: Vec<wallet_core::CommitmentRow> =
                serde_json::from_value(serde_json::Value::Array(rows)).map_err(|e| format!("getCommitments rows: {e}"))?;
            let result = wallet_core::scan_page(w, &parsed)?;
            s.merge(result.received, result.sent);
            s.scanned_index = s.scanned_index.max(result.next_index);
            if s.scanned_index <= before {
                return Err("getCommitments did not advance".into());
            }
            *self.store.lock().unwrap() = s.clone();
            (self.emit)(Event::StoreChanged);
        }

        let head_before = self.rpc.head_height()?;
        let mut from = s.scanned_height;
        loop {
            let rows = self.rpc.nullifiers(from, PAGE)?;
            let Some(max_height) = rows.iter().map(|(h, _)| *h).max() else { break };
            let nfs: Vec<String> = rows.iter().map(|(_, nf)| nf.clone()).collect();
            s.mark_spent(&nfs);
            if rows.len() < PAGE {
                from = max_height + 1;
                break;
            }
            if max_height == from {
                return Err(format!("block {from} published more than {PAGE} nullifiers"));
            }
            from = max_height;
        }
        s.advance_scanned_height(from, head_before);
        s.clear_pending(s.scanned_height.saturating_sub(1));

        for sub in s.submissions.iter_mut().filter(|x| x.status == SubmissionStatus::Pending) {
            if let Ok(Some(h)) = self.rpc.transaction_height(&sub.hash) {
                sub.status = SubmissionStatus::Committed;
                sub.height = Some(h);
            }
        }
        s.save()?;
        *self.store.lock().unwrap() = s;
        (self.emit)(Event::StoreChanged);
        self.phase(Phase::Idle);
        Ok(())
    }

    fn send(&self, w: &Wallet, to: &str, amount: u64, fee: u64, chain_id: u64) -> Result<SendOutcome, String> {
        let a = wallet_core::parse_address(to);
        if !a.valid {
            return Err(a.error.unwrap_or_else(|| "invalid address".into()));
        }
        self.scan(w)?;

        self.phase(Phase::Selecting);
        let need = amount.checked_add(fee).ok_or("amount + fee overflows")?;
        let notes = self.store.lock().unwrap().notes.clone();
        let selection = wallet_core::select_inputs(&notes, 0, need)?;

        self.phase(Phase::FetchingWitnesses);
        let mut attempt = 0;
        let (anchor, inputs) = loop {
            attempt += 1;
            let (height, root) = self.rpc.anchor()?;
            let mut inputs = Vec::new();
            let mut moved = false;
            for n in &selection.chosen {
                let (wroot, path) = self.rpc.witness(n.index)?;
                if wroot != root {
                    moved = true;
                    break;
                }
                inputs.push(ProveInput { note: n.clone(), path });
            }
            if !moved {
                break ((height, root), inputs);
            }
            if attempt >= 3 {
                return Err("the tree moved while fetching witnesses; try again".into());
            }
        };

        let req = ProveRequest {
            spend_key: w.spend_key_hex(),
            chain_id,
            to: to.to_string(),
            amount: amount.to_string(),
            fee: fee.to_string(),
            anchor_height: anchor.0,
            anchor_root: anchor.1,
            inputs,
            profile: "production".into(),
        };
        let started = Instant::now();
        self.phase(Phase::Proving { started });
        let proof = wallet_core::prove_transfer(&req)?;
        let proving_secs = started.elapsed().as_secs_f64();

        self.phase(Phase::Submitting);
        let hash = self.rpc.send_transaction(&proof.tx_hex)?;
        {
            let mut s = self.store.lock().unwrap();
            s.hold_pending(&proof.spent_indices, proof.time);
            s.submissions.insert(
                0,
                Submission {
                    hash: hash.clone(),
                    time: proof.time,
                    amount: proof.amount.clone(),
                    to: to.to_string(),
                    fee: proof.fee.clone(),
                    tx_key: proof.tx_keys[0].clone(),
                    status: SubmissionStatus::Pending,
                    height: None,
                    submitted_unix: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                },
            );
            let _ = s.save();
        }
        (self.emit)(Event::StoreChanged);

        self.phase(Phase::WaitingForCommit { hash: hash.clone() });
        let deadline = Instant::now() + COMMIT_TIMEOUT;
        let mut committed = None;
        while Instant::now() < deadline {
            if let Ok(Some(h)) = self.rpc.transaction_height(&hash) {
                committed = Some(h);
                break;
            }
            std::thread::sleep(Duration::from_millis(1500));
        }
        let _ = self.scan(w);
        Ok(SendOutcome {
            hash,
            amount: proof.amount,
            fee: proof.fee,
            change: proof.change,
            tx_key: proof.tx_keys[0].clone(),
            proof_bytes: proof.proof_bytes,
            tier: proof.tier,
            proving_secs,
            committed_height: committed,
        })
    }

    fn faucet(&self, w: &Wallet) -> Result<String, String> {
        let hash = self.rpc.mint(&w.address.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.rpc.transaction_height(&hash) {
                break;
            }
            std::thread::sleep(Duration::from_millis(1500));
        }
        let _ = self.scan(w);
        Ok(hash)
    }

    fn test_connection(&self, chain_id: u64) -> Result<String, String> {
        let id = self.rpc.chain_id()?;
        let st = self.rpc.status()?;
        let height = st["height"].as_u64().unwrap_or(0);
        let peers = st["peer_count"].as_u64().unwrap_or(0);
        if id != chain_id {
            return Ok(format!("Connected to chain {id} at height {height} ({peers} peers), but Settings says chain {chain_id}"));
        }
        Ok(format!("Chain {id}, height {height}, {peers} peers"))
    }
}
