//! Rand Wallet for the desktop: one native binary for Windows, Linux and macOS on the shared
//! Rust core (`../core/crates/wallet-core`). Screens follow the design spec §5: Welcome → Home
//! (balance card, Receive / Send / Faucet, Activity) → Receive, Send → Review → Proving → Sent,
//! Activity detail with "Disclose this payment", Settings.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod engine;
mod rpc;
mod secrets;
mod store;
mod theme;
mod ui;

use engine::{Engine, Event, Job, Phase, SendOutcome};
use std::sync::{Arc, Mutex};
use store::{NoteStore, Settings};
/// The core's `WalletInfo`, owned here so screens can clone it.
#[derive(Clone, Debug)]
pub struct Info {
    pub spend_key: String,
    pub viewing_key: String,
    pub pk: String,
    pub address: String,
    pub key_file: String,
}

impl From<wallet_core::WalletInfo> for Info {
    fn from(w: wallet_core::WalletInfo) -> Info {
        Info { spend_key: w.spend_key, viewing_key: w.viewing_key, pk: w.pk, address: w.address, key_file: w.key_file }
    }
}

fn main() -> eframe::Result {
    let icon = load_icon();
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([420.0, 760.0])
            .with_min_inner_size([380.0, 640.0])
            .with_title("Rand Wallet")
            .with_icon(icon),
        ..Default::default()
    };
    eframe::run_native("Rand Wallet", options, Box::new(|cc| Ok(Box::new(App::new(cc)))))
}

fn load_icon() -> egui::IconData {
    // The PNG is decoded by hand-rolled code in ui::png, keeping the image crate out of the build.
    ui::png::decode(include_bytes!("../assets/icon.png"))
        .map(|(w, h, rgba)| egui::IconData { rgba, width: w, height: h })
        .unwrap_or_default()
}

#[derive(Clone, Debug)]
pub enum Screen {
    Welcome,
    Create,
    Import,
    Locked,
    Home,
    Receive,
    Send,
    Review,
    Working,
    Sent(SendOutcome),
    SendFailed(String),
    Detail(ui::ActivityItem),
    Settings,
    Reveal { title: String, value: String },
}

pub struct App {
    pub settings: Settings,
    pub store: Arc<Mutex<NoteStore>>,
    pub rpc_url: Arc<Mutex<String>>,
    pub engine: Engine,
    pub screen: Screen,
    pub spend_key: Option<String>,
    pub info: Option<Info>,
    pub phase: Phase,
    pub syncing: bool,
    pub last_error: Option<String>,
    pub notice: Option<String>,
    pub connection: Option<String>,
    pub testing: bool,
    // form state
    pub create_info: Option<Info>,
    pub create_saved: bool,
    pub import_text: String,
    pub recipient: String,
    pub amount_text: String,
    pub address_error: Option<String>,
    pub rpc_draft: String,
    pub chain_draft: String,
    pub qr: Option<egui::TextureHandle>,
    pub copied_at: Option<std::time::Instant>,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> App {
        let settings = Settings::load();
        theme::apply(&cc.egui_ctx, settings.dark);
        let store = Arc::new(Mutex::new(NoteStore::load()));
        let rpc_url = Arc::new(Mutex::new(settings.rpc_url.clone()));
        let ctx = cc.egui_ctx.clone();
        let engine = Engine::start(store.clone(), rpc_url.clone(), move || ctx.request_repaint());
        let mut app = App {
            rpc_draft: settings.rpc_url.clone(),
            chain_draft: settings.chain_id.to_string(),
            settings,
            store,
            rpc_url,
            engine,
            screen: Screen::Welcome,
            spend_key: None,
            info: None,
            phase: Phase::Idle,
            syncing: false,
            last_error: None,
            notice: None,
            connection: None,
            testing: false,
            create_info: None,
            create_saved: false,
            import_text: String::new(),
            recipient: String::new(),
            amount_text: String::new(),
            address_error: None,
            qr: None,
            copied_at: None,
        };
        if secrets::exists() {
            app.screen = Screen::Locked;
        }
        app
    }

    pub fn palette(&self) -> theme::Palette {
        if self.settings.dark { theme::DARK } else { theme::LIGHT }
    }

    pub fn balance(&self) -> u64 {
        self.store.lock().unwrap().balance()
    }

    pub fn address(&self) -> String {
        self.info.as_ref().map(|i| i.address.clone()).unwrap_or_default()
    }

    pub fn unlock_with(&mut self, sk: String) {
        self.info = wallet_core::Wallet::from_hex(&sk).ok().map(|w| wallet_core::wallet_info(&w).into());
        self.spend_key = Some(sk);
        self.qr = None;
        self.screen = Screen::Home;
        self.sync();
    }

    pub fn unlock(&mut self) -> bool {
        match secrets::load() {
            Some(sk) => {
                self.unlock_with(sk);
                true
            }
            None => false,
        }
    }

    pub fn lock(&mut self) {
        self.spend_key = None;
        self.info = None;
        self.screen = Screen::Locked;
    }

    pub fn create_wallet(&mut self) -> Result<Info, String> {
        let w = wallet_core::Wallet::generate();
        let info: Info = wallet_core::wallet_info(&w).into();
        secrets::save(&info.spend_key)?;
        NoteStore::delete();
        *self.store.lock().unwrap() = NoteStore::default();
        Ok(info)
    }

    pub fn import_wallet(&mut self, input: &str) -> Result<Info, String> {
        let sk = wallet_core::spend_key_from_input(input)?;
        let w = wallet_core::Wallet::from_hex(&sk)?;
        let info: Info = wallet_core::wallet_info(&w).into();
        secrets::save(&info.spend_key)?;
        NoteStore::delete();
        *self.store.lock().unwrap() = NoteStore::default();
        Ok(info)
    }

    pub fn forget_wallet(&mut self) {
        secrets::delete();
        NoteStore::delete();
        *self.store.lock().unwrap() = NoteStore::default();
        self.settings.backed_up = false;
        self.settings.save();
        self.spend_key = None;
        self.info = None;
        self.screen = Screen::Welcome;
    }

    pub fn job(&mut self, job: Job) {
        if let Some(sk) = &self.spend_key {
            *self.rpc_url.lock().unwrap() = self.settings.rpc_url.clone();
            self.engine.submit(job, sk);
        }
    }

    pub fn sync(&mut self) {
        if !self.syncing {
            self.syncing = true;
            self.job(Job::Sync);
        }
    }

    pub fn copy(&mut self, ctx: &egui::Context, text: &str) {
        ctx.copy_text(text.to_string());
        self.copied_at = Some(std::time::Instant::now());
    }

    pub fn open(&self, url: &str) {
        let _ = open::that(url);
    }

    fn drain_events(&mut self) {
        while let Ok(e) = self.engine.events.try_recv() {
            match e {
                Event::Phase(p) => self.phase = p,
                Event::StoreChanged => {}
                Event::SyncDone(r) => {
                    self.syncing = false;
                    self.last_error = r.err();
                }
                Event::SendDone(r) => {
                    self.syncing = false;
                    self.screen = match r {
                        Ok(o) => Screen::Sent(o),
                        Err(e) => Screen::SendFailed(e),
                    };
                }
                Event::FaucetDone(r) => {
                    self.syncing = false;
                    self.notice = Some(match r {
                        Ok(h) => format!("Faucet mint {} submitted; it appears once committed.", store::shortened(&h, 8, 6)),
                        Err(e) => e,
                    });
                }
                Event::Connection(r) => {
                    self.testing = false;
                    self.connection = Some(match r {
                        Ok(s) => s,
                        Err(e) => e,
                    });
                }
            }
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_events();
        if matches!(self.phase, Phase::Proving { .. }) {
            ctx.request_repaint_after(std::time::Duration::from_millis(500));
        }
        ui::draw(self, ctx);
    }
}
