//! Screens and widgets.

use crate::engine::{Job, Phase};
use crate::store::{amount, shortened, SubmissionStatus};
use crate::theme::{Palette, AURORA_FROM, AURORA_TO};
use crate::{App, Screen};
use egui::{Align, Color32, CornerRadius, Frame, Layout, Margin, RichText, Stroke, Ui};

const EXPLORER: &str = wallet_core::EXPLORER_URL;
const FEE: u64 = 1_000_000;

#[derive(Clone, Debug)]
pub enum ActivityItem {
    Received(wallet_core::OwnedNote),
    Sent(crate::store::Submission),
    SentRow(wallet_core::SentRow),
}

pub fn draw(app: &mut App, ctx: &egui::Context) {
    let p = app.palette();
    egui::CentralPanel::default()
        .frame(Frame::default().fill(p.bg).inner_margin(Margin::same(20)))
        .show(ctx, |ui| {
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                ui.set_width(ui.available_width());
                match app.screen.clone() {
                    Screen::Welcome => welcome(app, ui),
                    Screen::Create => create(app, ui),
                    Screen::Import => import(app, ui),
                    Screen::Locked => locked(app, ui),
                    Screen::Home => home(app, ui),
                    Screen::Receive => receive(app, ui),
                    Screen::Send => send_form(app, ui),
                    Screen::Review => review(app, ui),
                    Screen::Working => working(app, ui),
                    Screen::Sent(o) => sent(app, ui, &o),
                    Screen::SendFailed(m) => send_failed(app, ui, &m),
                    Screen::Detail(item) => detail(app, ui, &item),
                    Screen::Settings => settings(app, ui),
                    Screen::Reveal { title, value } => reveal(app, ui, &title, &value),
                }
            });
        });
}

// ------------------------------------------------------------------ widgets

fn card(ui: &mut Ui, p: &Palette, add: impl FnOnce(&mut Ui)) {
    Frame::default()
        .fill(p.surface)
        .stroke(Stroke::new(1.0_f32, p.border_soft))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::same(16))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui);
        });
}

fn primary(ui: &mut Ui, label: &str, enabled: bool) -> bool {
    let b = egui::Button::new(RichText::new(label).color(Color32::WHITE).strong())
        .fill(AURORA_FROM.lerp_to_gamma(AURORA_TO, 0.35))
        .stroke(Stroke::NONE)
        .corner_radius(CornerRadius::same(14))
        .min_size(egui::vec2(ui.available_width(), 48.0));
    ui.add_enabled(enabled, b).clicked()
}

fn secondary(ui: &mut Ui, p: &Palette, label: &str) -> bool {
    let b = egui::Button::new(RichText::new(label).color(p.text).strong())
        .fill(p.surface2)
        .stroke(Stroke::new(1.0_f32, p.border))
        .corner_radius(CornerRadius::same(14))
        .min_size(egui::vec2(ui.available_width(), 48.0));
    ui.add(b).clicked()
}

fn small_button(ui: &mut Ui, p: &Palette, label: &str) -> bool {
    ui.add(egui::Button::new(RichText::new(label).color(p.accent).small()).fill(Color32::TRANSPARENT).stroke(Stroke::NONE)).clicked()
}

fn label(ui: &mut Ui, p: &Palette, text: &str) {
    ui.label(RichText::new(text.to_uppercase()).small().strong().color(p.text_mute));
}

fn muted(ui: &mut Ui, p: &Palette, text: &str) {
    ui.label(RichText::new(text).size(13.0).color(p.text_mute));
}

fn error(ui: &mut Ui, p: &Palette, text: &Option<String>) {
    if let Some(t) = text {
        ui.label(RichText::new(t).size(13.0).color(p.negative));
    }
}

fn copy_row(app: &mut App, ui: &mut Ui, title: &str, value: &str, short: bool) {
    let p = app.palette();
    let just_copied = app.copied_at.map(|t| t.elapsed().as_secs_f32() < 1.5).unwrap_or(false);
    ui.horizontal(|ui| {
        ui.vertical(|ui| {
            ui.label(RichText::new(title).small().color(p.text_mute));
            let shown = if short { shortened(value, 12, 8) } else { value.to_string() };
            ui.add(egui::Label::new(RichText::new(shown).monospace().color(p.text)).wrap());
        });
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if small_button(ui, &p, if just_copied { "Copied" } else { "Copy" }) {
                app.copy(ui.ctx(), value);
            }
        });
    });
}

fn back(app: &mut App, ui: &mut Ui, to: Screen) {
    let p = app.palette();
    if small_button(ui, &p, "← Back") {
        app.screen = to;
    }
}

fn logo(ui: &mut Ui) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(96.0, 96.0), egui::Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(28), AURORA_FROM.lerp_to_gamma(AURORA_TO, 0.4));
    painter.text(rect.center(), egui::Align2::CENTER_CENTER, "R", egui::FontId::proportional(52.0), Color32::WHITE);
}

// ------------------------------------------------------------------ screens

fn welcome(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    ui.add_space(80.0);
    ui.vertical_centered(|ui| {
        logo(ui);
        ui.add_space(16.0);
        ui.label(RichText::new("Rand Wallet").size(30.0).strong().color(p.text_strong));
        ui.add_space(6.0);
        ui.label(RichText::new("A shielded wallet for SHRUGG.\nYour balance and payments are private; the chain sees only proofs.").color(p.text_soft));
    });
    ui.add_space(60.0);
    if primary(ui, "Create a new wallet", true) {
        match app.create_wallet() {
            Ok(info) => {
                app.create_info = Some(info);
                app.create_saved = false;
                app.screen = Screen::Create;
            }
            Err(e) => app.last_error = Some(e),
        }
    }
    if secondary(ui, &p, "I already have a wallet") {
        app.import_text.clear();
        app.last_error = None;
        app.screen = Screen::Import;
    }
    error(ui, &p, &app.last_error);
}

fn create(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    ui.heading(RichText::new("Your secret key").color(p.text_strong));
    ui.label(RichText::new("This 64-character spend key is the only copy of your wallet. Anyone who has it can spend your SHRUGG; anyone who loses it loses the wallet. Write it down and keep it offline.").color(p.text_soft));
    let Some(info) = app.create_info.clone() else { return };
    card(ui, &p, |ui| {
        ui.add(egui::Label::new(RichText::new(&info.spend_key).monospace().color(p.text)).wrap());
    });
    copy_row(app, ui, "Copy spend key", &info.spend_key, true);
    copy_row(app, ui, "Your address", &info.address, true);
    ui.checkbox(&mut app.create_saved, "I have saved my spend key somewhere safe");
    if primary(ui, "Open my wallet", app.create_saved) {
        app.settings.backed_up = true;
        app.settings.save();
        app.unlock_with(info.spend_key.clone());
    }
}

fn import(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    back(app, ui, Screen::Welcome);
    ui.heading(RichText::new("Import a wallet").color(p.text_strong));
    ui.label(RichText::new("Paste your 64-character spend key, or the contents of a wallet.key.json from the shrugg command-line wallet.").color(p.text_soft));
    ui.add(egui::TextEdit::multiline(&mut app.import_text).font(egui::TextStyle::Monospace).desired_rows(4).desired_width(f32::INFINITY));
    error(ui, &p, &app.last_error);
    if primary(ui, "Import", !app.import_text.trim().is_empty()) {
        let text = app.import_text.clone();
        match app.import_wallet(&text) {
            Ok(info) => {
                app.settings.backed_up = true;
                app.settings.save();
                app.import_text.clear();
                app.unlock_with(info.spend_key);
            }
            Err(e) => app.last_error = Some(e),
        }
    }
}

fn locked(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    ui.add_space(120.0);
    ui.vertical_centered(|ui| {
        logo(ui);
        ui.add_space(12.0);
        ui.label(RichText::new("Rand Wallet").size(26.0).strong().color(p.text_strong));
        ui.label(RichText::new(format!("Locked. Your key is in {}.", crate::secrets::location())).color(p.text_soft));
    });
    ui.add_space(60.0);
    if primary(ui, "Unlock", true) && !app.unlock() {
        app.last_error = Some("No wallet found in the credential store.".into());
    }
    error(ui, &p, &app.last_error);
    if secondary(ui, &p, "Forget this wallet") {
        app.forget_wallet();
    }
}

fn home(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    ui.horizontal(|ui| {
        ui.label(RichText::new("Rand Wallet").strong().color(p.text_strong));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if small_button(ui, &p, "Settings") {
                app.rpc_draft = app.settings.rpc_url.clone();
                app.chain_draft = app.settings.chain_id.to_string();
                app.connection = None;
                app.screen = Screen::Settings;
            }
            if small_button(ui, &p, if app.syncing { "Syncing…" } else { "Refresh" }) {
                app.sync();
            }
        });
    });

    // Balance card on the aurora colours.
    let balance = app.balance();
    let pending = app.store.lock().unwrap().pending_out();
    let address = app.address();
    Frame::default()
        .fill(AURORA_FROM.lerp_to_gamma(AURORA_TO, 0.3))
        .corner_radius(CornerRadius::same(24))
        .inner_margin(Margin::same(20))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new("Balance").small().color(Color32::from_white_alpha(200)));
            ui.horizontal(|ui| {
                ui.label(RichText::new(amount::format(balance)).size(40.0).strong().color(Color32::WHITE));
                ui.label(RichText::new("SHRUGG").strong().color(Color32::from_white_alpha(220)));
            });
            if pending > 0 {
                ui.label(RichText::new(format!("{} SHRUGG pending", amount::format(pending))).small().color(Color32::from_white_alpha(200)));
            }
            ui.horizontal(|ui| {
                let just = app.copied_at.map(|t| t.elapsed().as_secs_f32() < 1.5).unwrap_or(false);
                let chip = egui::Button::new(RichText::new(format!("{} {}", shortened(&address, 10, 6), if just { "✓" } else { "⧉" })).monospace().size(12.0).color(Color32::WHITE))
                    .fill(Color32::from_white_alpha(40))
                    .stroke(Stroke::NONE)
                    .corner_radius(CornerRadius::same(255));
                if ui.add(chip).clicked() {
                    app.copy(ui.ctx(), &address);
                }
            });
            if let Some(e) = &app.last_error {
                ui.label(RichText::new(e).small().color(Color32::from_white_alpha(230)));
            }
        });

    ui.add_space(6.0);
    ui.columns(3, |cols| {
        if action(&mut cols[0], &p, "⤓", "Receive") {
            app.screen = Screen::Receive;
        }
        if action(&mut cols[1], &p, "➤", "Send") {
            app.recipient.clear();
            app.amount_text.clear();
            app.address_error = None;
            app.screen = Screen::Send;
        }
        if action(&mut cols[2], &p, "💧", "Faucet") {
            app.notice = Some("Asking the faucet for 100 SHRUGG…".into());
            app.syncing = true;
            app.job(Job::Faucet);
        }
    });
    if let Some(n) = app.notice.clone() {
        muted(ui, &p, &n);
    }
    if !app.settings.backed_up {
        card(ui, &p, |ui| {
            ui.label(RichText::new("⚠ Back up your spend key in Settings.").color(p.warning));
        });
    }

    ui.add_space(6.0);
    label(ui, &p, "Activity");
    let items = activity_items(app);
    if items.is_empty() {
        card(ui, &p, |ui| {
            ui.label(RichText::new("No activity yet. Tap Faucet to get 100 testnet SHRUGG, or share your address to receive.").color(p.text_soft));
        });
    }
    for item in items {
        if activity_row(ui, &p, &item) {
            app.screen = Screen::Detail(item.clone());
        }
    }
}

fn action(ui: &mut Ui, p: &Palette, icon: &str, text: &str) -> bool {
    ui.vertical_centered(|ui| {
        let b = egui::Button::new(RichText::new(icon).size(20.0).color(p.accent))
            .fill(p.surface2)
            .stroke(Stroke::new(1.0_f32, p.border))
            .corner_radius(CornerRadius::same(28))
            .min_size(egui::vec2(56.0, 56.0));
        let clicked = ui.add(b).clicked();
        ui.label(RichText::new(text).small().color(p.text_soft));
        clicked
    })
    .inner
}

fn activity_items(app: &App) -> Vec<ActivityItem> {
    let s = app.store.lock().unwrap();
    let mut out: Vec<(u64, ActivityItem)> = Vec::new();
    for n in s.notes.iter().filter(|n| n.index != u64::MAX && n.units() > 0) {
        out.push((n.height, ActivityItem::Received(n.clone())));
    }
    for sub in &s.submissions {
        out.push((sub.height.unwrap_or(u64::MAX), ActivityItem::Sent(sub.clone())));
    }
    for r in s.sent.iter().filter(|r| r.amount.parse::<u64>().unwrap_or(0) > 0) {
        out.push((r.height, ActivityItem::SentRow(r.clone())));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, i)| i).collect()
}

fn activity_row(ui: &mut Ui, p: &Palette, item: &ActivityItem) -> bool {
    let (title, subtitle, amt, color) = match item {
        ActivityItem::Received(n) => (
            if n.spent { "Received (spent)" } else { "Received" }.to_string(),
            format!("Leaf #{} · block {}", n.index, n.height),
            format!("+{}", amount::format(n.units())),
            p.positive,
        ),
        ActivityItem::Sent(s) => (
            match s.status {
                SubmissionStatus::Pending => "Sending",
                SubmissionStatus::Committed => "Sent",
                SubmissionStatus::Failed => "Not committed",
            }
            .to_string(),
            s.height.map(|h| format!("Block {h}")).unwrap_or_else(|| "Submitted".into()),
            format!("−{}", amount::format(s.units())),
            match s.status {
                SubmissionStatus::Pending => p.warning,
                SubmissionStatus::Committed => p.text,
                SubmissionStatus::Failed => p.negative,
            },
        ),
        ActivityItem::SentRow(r) => (
            "Sent".to_string(),
            format!("Leaf #{} · block {}", r.index, r.height),
            format!("−{}", amount::format(r.amount.parse().unwrap_or(0))),
            p.text,
        ),
    };
    let mut clicked = false;
    Frame::default()
        .fill(p.surface)
        .stroke(Stroke::new(1.0_f32, p.border_soft))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::same(14))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            let resp = ui
                .horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.label(RichText::new(title).strong().color(p.text));
                        ui.label(RichText::new(subtitle).small().color(p.text_mute));
                    });
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(RichText::new(amt).strong().color(color));
                    });
                })
                .response;
            clicked = resp.interact(egui::Sense::click()).clicked();
        });
    clicked
}

fn receive(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    back(app, ui, Screen::Home);
    ui.heading(RichText::new("Receive").color(p.text_strong));
    ui.label(RichText::new("Anyone can pay this address. It reveals nothing about what you hold.").color(p.text_soft));
    let address = app.address();
    if app.qr.is_none() {
        app.qr = qr::texture(ui.ctx(), &address);
    }
    if let Some(tex) = &app.qr {
        ui.vertical_centered(|ui| {
            Frame::default().fill(Color32::WHITE).corner_radius(CornerRadius::same(16)).inner_margin(Margin::same(12)).show(ui, |ui| {
                ui.add(egui::Image::from_texture(tex).fit_to_exact_size(egui::vec2(340.0, 340.0)));
            });
        });
    }
    card(ui, &p, |ui| {
        egui::ScrollArea::vertical().max_height(140.0).show(ui, |ui| {
            ui.add(egui::Label::new(RichText::new(&address).monospace().size(11.0).color(p.text)).wrap());
        });
    });
    if primary(ui, "Copy address", true) {
        app.copy(ui.ctx(), &address);
    }
}

fn send_form(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    back(app, ui, Screen::Home);
    ui.heading(RichText::new("Send").color(p.text_strong));
    label(ui, &p, "To");
    let before = app.recipient.clone();
    ui.horizontal(|ui| {
        ui.add(egui::TextEdit::singleline(&mut app.recipient).hint_text("shrugg1…").font(egui::TextStyle::Monospace).desired_width(ui.available_width() - 60.0));
        if small_button(ui, &p, "Paste") {
            if let Ok(mut cb) = arboard_paste() {
                cb = cb.trim().to_string();
                app.recipient = cb;
            }
        }
    });
    if app.recipient != before || (app.address_error.is_none() && !app.recipient.trim().is_empty() && app.recipient != before) {
        app.address_error = None;
    }
    let trimmed = app.recipient.trim().to_string();
    if !trimmed.is_empty() {
        let info = wallet_core::parse_address(&trimmed);
        app.address_error = if info.valid { None } else { Some(info.error.unwrap_or_else(|| "Not a shrugg1 address".into())) };
    } else {
        app.address_error = None;
    }
    error(ui, &p, &app.address_error);

    let balance = app.balance();
    let max = balance.saturating_sub(FEE);
    ui.horizontal(|ui| {
        label(ui, &p, "Amount");
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if small_button(ui, &p, &format!("Max {}", amount::format(max))) {
                app.amount_text = amount::format(max);
            }
        });
    });
    ui.add(egui::TextEdit::singleline(&mut app.amount_text).hint_text("0.0").desired_width(f32::INFINITY));
    let units = amount::parse(&app.amount_text);
    ui.horizontal(|ui| {
        muted(ui, &p, &format!("Available {} SHRUGG", amount::format(balance)));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| muted(ui, &p, &format!("Fee {} SHRUGG", amount::format(FEE))));
    });
    let over = units.map(|a| a.saturating_add(FEE) > balance).unwrap_or(false);
    if over {
        error(ui, &p, &Some("Amount plus fee exceeds your balance.".into()));
    }
    muted(ui, &p, "A transfer is proved on this computer, which takes about a minute. Keep the window open while it runs.");
    let valid = units.map(|a| a > 0).unwrap_or(false) && !over && app.address_error.is_none() && !trimmed.is_empty();
    if primary(ui, "Review", valid) {
        app.screen = Screen::Review;
    }
}

fn arboard_paste() -> Result<String, ()> {
    // egui exposes no synchronous paste outside an event; the OS clipboard is read through a
    // small platform shim instead.
    crate::ui::clipboard::read().ok_or(())
}

fn review(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    back(app, ui, Screen::Send);
    ui.heading(RichText::new("Review").color(p.text_strong));
    let units = amount::parse(&app.amount_text).unwrap_or(0);
    let to = app.recipient.trim().to_string();
    card(ui, &p, |ui| {
        row(ui, &p, "Amount", &format!("{} SHRUGG", amount::format(units)));
        row(ui, &p, "Fee", &format!("{} SHRUGG", amount::format(FEE)));
        row(ui, &p, "Total", &format!("{} SHRUGG", amount::format(units + FEE)));
        ui.separator();
        ui.label(RichText::new("To").small().color(p.text_mute));
        ui.label(RichText::new(shortened(&to, 14, 8)).monospace().color(p.text));
    });
    muted(ui, &p, "The chain will see two nullifiers, two commitments and a proof — never the amount or the recipient.");
    if primary(ui, "Confirm and prove", true) {
        let chain_id = app.settings.chain_id;
        app.syncing = true;
        app.screen = Screen::Working;
        app.job(Job::Send { to, amount: units, fee: FEE, chain_id });
    }
}

fn working(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    ui.add_space(160.0);
    ui.vertical_centered(|ui| {
        ui.add(egui::Spinner::new().size(40.0).color(p.accent));
        ui.add_space(12.0);
        let (title, detail) = match &app.phase {
            Phase::Syncing => ("Syncing…", String::new()),
            Phase::Selecting => ("Choosing notes…", String::new()),
            Phase::FetchingWitnesses => ("Fetching witnesses…", String::new()),
            Phase::Proving { started } => {
                let s = started.elapsed().as_secs();
                ("Proving your transfer…", format!("About a minute on this computer. Keep the window open.\n{}:{:02}", s / 60, s % 60))
            }
            Phase::Submitting => ("Submitting…", String::new()),
            Phase::WaitingForCommit { hash } => ("Waiting for the block…", format!("Transaction {} is in the mempool.", shortened(hash, 8, 6))),
            Phase::Idle => ("Working…", String::new()),
        };
        ui.heading(RichText::new(title).color(p.text_strong));
        ui.label(RichText::new(detail).color(p.text_soft));
    });
}

fn sent(app: &mut App, ui: &mut Ui, o: &crate::engine::SendOutcome) {
    let p = app.palette();
    ui.vertical_centered(|ui| {
        ui.add_space(20.0);
        ui.label(RichText::new("✓").size(56.0).color(p.positive));
        ui.heading(RichText::new(if o.committed_height.is_some() { "Sent" } else { "Submitted" }).color(p.text_strong));
        ui.label(RichText::new(format!("{} SHRUGG", amount::format_str(&o.amount))).size(36.0).strong().color(p.text));
    });
    copy_row(app, ui, "Transaction", &o.hash, true);
    match o.committed_height {
        Some(h) => muted(ui, &p, &format!("Committed in block {h}")),
        None => muted(ui, &p, "Accepted by the node; not yet seen in a block. It will show in Activity once committed."),
    }
    muted(ui, &p, &format!("Proved in {:.0} s · tier {} · {} KB proof", o.proving_secs, o.tier, o.proof_bytes / 1024));
    card(ui, &p, |ui| {
        ui.label(RichText::new("Disclose this payment").strong().color(p.text));
        ui.label(RichText::new("The transaction key opens exactly this payment on RandScan — the amount and the recipient — and nothing else you ever did.").size(13.0).color(p.text_soft));
    });
    copy_row(app, ui, "Transaction key", &o.tx_key, true);
    if secondary(ui, &p, "View on RandScan") {
        app.open(&format!("{EXPLORER}/transactions/{}", o.hash));
    }
    if primary(ui, "Done", true) {
        app.screen = Screen::Home;
    }
}

fn send_failed(app: &mut App, ui: &mut Ui, message: &str) {
    let p = app.palette();
    ui.add_space(80.0);
    ui.vertical_centered(|ui| {
        ui.label(RichText::new("✕").size(48.0).color(p.negative));
        ui.heading(RichText::new("Could not send").color(p.text_strong));
        ui.label(RichText::new(message).color(p.text_soft));
    });
    ui.add_space(30.0);
    if primary(ui, "Try again", true) {
        app.screen = Screen::Send;
    }
    if secondary(ui, &p, "Close") {
        app.screen = Screen::Home;
    }
}

fn detail(app: &mut App, ui: &mut Ui, item: &ActivityItem) {
    let p = app.palette();
    back(app, ui, Screen::Home);
    match item {
        ActivityItem::Received(n) => {
            ui.heading(RichText::new("Received").color(p.text_strong));
            ui.label(RichText::new(format!("+{} SHRUGG", amount::format(n.units()))).size(32.0).strong().color(p.positive));
            card(ui, &p, |ui| {
                row(ui, &p, "Status", if n.spent { "Spent" } else if n.pending.is_some() { "Held by a pending send" } else { "Unspent" });
                row(ui, &p, "Leaf", &format!("#{}", n.index));
                row(ui, &p, "Block", &n.height.to_string());
                if n.asset != 0 {
                    row(ui, &p, "Asset", &format!("bridged asset #{}", n.asset));
                }
            });
            copy_row(app, ui, "From (pk)", &n.from, true);
            copy_row(app, ui, "Commitment", &n.cm, true);
            muted(ui, &p, "The sender's pk identifies who paid you to anyone holding your viewing key, and nobody else.");
            if secondary(ui, &p, "View note on RandScan") {
                app.open(&format!("{EXPLORER}/notes/{}", n.cm));
            }
        }
        ActivityItem::Sent(s) => {
            ui.heading(RichText::new("Sent").color(p.text_strong));
            ui.label(RichText::new(format!("−{} SHRUGG", amount::format(s.units()))).size(32.0).strong().color(p.text));
            card(ui, &p, |ui| {
                row(
                    ui,
                    &p,
                    "Status",
                    match s.status {
                        SubmissionStatus::Pending => "Pending",
                        SubmissionStatus::Committed => "Committed",
                        SubmissionStatus::Failed => "Not committed (notes released)",
                    },
                );
                if let Some(h) = s.height {
                    row(ui, &p, "Block", &h.to_string());
                }
                row(ui, &p, "Fee", &format!("{} SHRUGG", amount::format_str(&s.fee)));
            });
            copy_row(app, ui, "To", &s.to, true);
            copy_row(app, ui, "Transaction", &s.hash, true);
            card(ui, &p, |ui| {
                ui.label(RichText::new("Disclose this payment").strong().color(p.text));
                ui.label(RichText::new("Copy the transaction key and paste it on the transaction's RandScan page to show exactly this payment to whoever you hand the key to.").size(13.0).color(p.text_soft));
            });
            copy_row(app, ui, "Transaction key", &s.tx_key, true);
            if secondary(ui, &p, "Open transaction on RandScan") {
                app.open(&format!("{EXPLORER}/transactions/{}", s.hash));
            }
        }
        ActivityItem::SentRow(r) => {
            ui.heading(RichText::new("Sent").color(p.text_strong));
            ui.label(RichText::new(format!("−{} SHRUGG", amount::format_str(&r.amount))).size(32.0).strong().color(p.text));
            card(ui, &p, |ui| {
                row(ui, &p, "Leaf", &format!("#{}", r.index));
                row(ui, &p, "Block", &r.height.to_string());
            });
            copy_row(app, ui, "To (pk)", &r.to_pk, true);
            muted(ui, &p, "This payment was made with your key from another device, so its transaction key is not stored here. Your viewing key opens it on RandScan.");
        }
    }
}

fn row(ui: &mut Ui, p: &Palette, k: &str, v: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(k).color(p.text_soft));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(RichText::new(v).strong().color(p.text));
        });
    });
}

fn settings(app: &mut App, ui: &mut Ui) {
    let p = app.palette();
    back(app, ui, Screen::Home);
    ui.heading(RichText::new("Settings").color(p.text_strong));

    label(ui, &p, "Network");
    card(ui, &p, |ui| {
        ui.label(RichText::new("RPC URL").small().color(p.text_mute));
        ui.add(egui::TextEdit::singleline(&mut app.rpc_draft).font(egui::TextStyle::Monospace).desired_width(f32::INFINITY));
        ui.label(RichText::new("Chain id").small().color(p.text_mute));
        ui.add(egui::TextEdit::singleline(&mut app.chain_draft).font(egui::TextStyle::Monospace).desired_width(80.0));
        if ui.add_enabled(!app.testing, egui::Button::new(if app.testing { "Testing…" } else { "Save and test connection" })).clicked() {
            app.settings.rpc_url = app.rpc_draft.trim().to_string();
            app.settings.chain_id = app.chain_draft.trim().parse().unwrap_or(app.settings.chain_id);
            app.settings.save();
            app.testing = true;
            let chain_id = app.settings.chain_id;
            app.job(Job::TestConnection { chain_id });
        }
        if let Some(c) = &app.connection {
            ui.label(RichText::new(c).size(13.0).color(p.text_soft));
        }
    });

    label(ui, &p, "Viewing key");
    if let Some(vk) = app.info.as_ref().map(|i| i.viewing_key.clone()) {
        card(ui, &p, |ui| {
            ui.label(RichText::new("Paste it on randscan.org/viewing to see every note you received or sent, in your browser. It cannot spend. Anyone you give it to sees your whole history.").size(13.0).color(p.text_soft));
        });
        copy_row(app, ui, "Viewing key", &vk, true);
        if secondary(ui, &p, "Open My history on RandScan") {
            app.open(&format!("{EXPLORER}/viewing"));
        }
    }

    label(ui, &p, "Backup");
    card(ui, &p, |ui| {
        ui.label(RichText::new(format!("The spend key is the wallet; it is stored in {}. Anyone who sees it can spend your SHRUGG. The key file is what the shrugg command-line wallet reads.", crate::secrets::location())).size(13.0).color(p.text_soft));
    });
    if let Some(info) = app.info.clone() {
        if secondary(ui, &p, "Export key file (wallet.key.json)") {
            app.settings.backed_up = true;
            app.settings.save();
            app.screen = Screen::Reveal { title: "wallet.key.json".into(), value: info.key_file.clone() };
        }
        if secondary(ui, &p, "Show spend key") {
            app.settings.backed_up = true;
            app.settings.save();
            app.screen = Screen::Reveal { title: "Spend key".into(), value: info.spend_key.clone() };
        }
    }

    label(ui, &p, "Appearance");
    let mut dark = app.settings.dark;
    if ui.checkbox(&mut dark, "Dark theme").changed() {
        app.settings.dark = dark;
        app.settings.save();
        crate::theme::apply(ui.ctx(), dark);
    }

    label(ui, &p, "Maintenance");
    if secondary(ui, &p, "Rescan from the first leaf") {
        app.syncing = true;
        app.job(Job::RescanFromZero);
        app.notice = Some("Rescanning the whole tree; nothing is lost.".into());
        app.screen = Screen::Home;
    }
    if secondary(ui, &p, "Lock") {
        app.lock();
    }
    if secondary(ui, &p, "Forget this wallet") {
        app.screen = Screen::Reveal { title: "Forget this wallet?".into(), value: String::new() };
    }

    label(ui, &p, "About");
    card(ui, &p, |ui| {
        row(ui, &p, "App", env!("CARGO_PKG_VERSION"));
        row(ui, &p, "Core", wallet_core::VERSION);
        row(ui, &p, "Chain build", wallet_core::CHAIN_BUILD);
        row(ui, &p, "Data directory", &crate::store::data_dir().display().to_string());
    });
    if secondary(ui, &p, "randprotocol.org/clients") {
        app.open("https://randprotocol.org/clients");
    }
}

fn reveal(app: &mut App, ui: &mut Ui, title: &str, value: &str) {
    let p = app.palette();
    back(app, ui, Screen::Settings);
    ui.heading(RichText::new(title).color(p.text_strong));
    if value.is_empty() {
        // The "forget" confirmation reuses this screen.
        ui.label(RichText::new("Without your spend key backup the funds are gone. This removes the key from this computer only.").color(p.text_soft));
        if primary(ui, "Forget wallet", true) {
            app.forget_wallet();
        }
        return;
    }
    ui.label(RichText::new("⚠ Never share this. Anyone who has it controls your funds.").color(p.warning));
    card(ui, &p, |ui| {
        ui.add(egui::Label::new(RichText::new(value).monospace().color(p.text)).wrap());
    });
    if primary(ui, "Copy", true) {
        app.copy(ui.ctx(), value);
    }
}

// ------------------------------------------------------------------ helpers

pub mod qr {
    use egui::{ColorImage, TextureHandle, TextureOptions};
    use qrcode::{EcLevel, QrCode};

    /// A shielded address is ~1.7 KB: byte mode, version 33+, error correction L.
    pub fn texture(ctx: &egui::Context, text: &str) -> Option<TextureHandle> {
        let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L).ok()?;
        let w = code.width();
        let quiet = 4;
        let size = w + 2 * quiet;
        let mut pixels = vec![255u8; size * size];
        for (i, c) in code.to_colors().iter().enumerate() {
            let (x, y) = (i % w + quiet, i / w + quiet);
            if *c == qrcode::Color::Dark {
                pixels[y * size + x] = 0;
            }
        }
        let image = ColorImage::from_gray([size, size], &pixels);
        Some(ctx.load_texture("address-qr", image, TextureOptions::NEAREST))
    }
}

pub mod clipboard {
    /// Read the OS clipboard as text.
    pub fn read() -> Option<String> {
        #[cfg(target_os = "macos")]
        {
            let out = std::process::Command::new("pbpaste").output().ok()?;
            return String::from_utf8(out.stdout).ok();
        }
        #[cfg(target_os = "windows")]
        {
            let out = std::process::Command::new("powershell").args(["-NoProfile", "-Command", "Get-Clipboard"]).output().ok()?;
            return String::from_utf8(out.stdout).ok();
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            for (cmd, args) in [("wl-paste", vec!["--no-newline"]), ("xclip", vec!["-selection", "clipboard", "-o"]), ("xsel", vec!["--clipboard", "--output"])] {
                if let Ok(out) = std::process::Command::new(cmd).args(&args).output() {
                    if out.status.success() {
                        return String::from_utf8(out.stdout).ok();
                    }
                }
            }
            None
        }
    }
}

pub mod png {
    //! A minimal PNG decoder for the bundled window icon (8-bit RGBA or RGB, non-interlaced),
    //! so the image crate stays out of the dependency tree. Returns `None` for anything else.

    pub fn decode(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
        if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
            return None;
        }
        let mut pos = 8;
        let (mut w, mut h, mut color, mut depth) = (0u32, 0u32, 0u8, 0u8);
        let mut idat = Vec::new();
        while pos + 8 <= bytes.len() {
            let len = u32::from_be_bytes(bytes[pos..pos + 4].try_into().ok()?) as usize;
            let kind = &bytes[pos + 4..pos + 8];
            let data = bytes.get(pos + 8..pos + 8 + len)?;
            match kind {
                b"IHDR" => {
                    w = u32::from_be_bytes(data[0..4].try_into().ok()?);
                    h = u32::from_be_bytes(data[4..8].try_into().ok()?);
                    depth = data[8];
                    color = data[9];
                    if data[12] != 0 {
                        return None;
                    }
                }
                b"IDAT" => idat.extend_from_slice(data),
                b"IEND" => break,
                _ => {}
            }
            pos += 12 + len;
        }
        if depth != 8 || !(color == 6 || color == 2) {
            return None;
        }
        let bpp = if color == 6 { 4 } else { 3 };
        let raw = inflate::zlib(&idat)?;
        let stride = w as usize * bpp;
        let mut out = vec![0u8; stride * h as usize];
        let mut prev = vec![0u8; stride];
        for y in 0..h as usize {
            let line = raw.get(y * (stride + 1)..(y + 1) * (stride + 1))?;
            let filter = line[0];
            let cur = &line[1..];
            let mut row = vec![0u8; stride];
            for i in 0..stride {
                let a = if i >= bpp { row[i - bpp] } else { 0 };
                let b = prev[i];
                let c = if i >= bpp { prev[i - bpp] } else { 0 };
                row[i] = match filter {
                    0 => cur[i],
                    1 => cur[i].wrapping_add(a),
                    2 => cur[i].wrapping_add(b),
                    3 => cur[i].wrapping_add(((a as u16 + b as u16) / 2) as u8),
                    4 => {
                        let pa = (b as i16 - c as i16).abs();
                        let pb = (a as i16 - c as i16).abs();
                        let pc = (a as i16 + b as i16 - 2 * c as i16).abs();
                        let pred = if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c };
                        cur[i].wrapping_add(pred)
                    }
                    _ => return None,
                };
            }
            out[y * stride..(y + 1) * stride].copy_from_slice(&row);
            prev = row;
        }
        let rgba = if bpp == 4 { out } else { out.chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect() };
        Some((w, h, rgba))
    }

    mod inflate {
        //! zlib/DEFLATE decoder (stored, fixed and dynamic Huffman blocks). Small and slow, which
        //! is fine for a 256×256 icon decoded once at startup.

        struct Bits<'a> {
            data: &'a [u8],
            pos: usize,
            bit: u32,
        }

        impl Bits<'_> {
            fn bit(&mut self) -> Option<u32> {
                let b = (*self.data.get(self.pos)? >> self.bit) & 1;
                self.bit += 1;
                if self.bit == 8 {
                    self.bit = 0;
                    self.pos += 1;
                }
                Some(b as u32)
            }
            fn bits(&mut self, n: u32) -> Option<u32> {
                let mut v = 0;
                for i in 0..n {
                    v |= self.bit()? << i;
                }
                Some(v)
            }
            fn align(&mut self) {
                if self.bit != 0 {
                    self.bit = 0;
                    self.pos += 1;
                }
            }
        }

        struct Huffman {
            counts: [u16; 16],
            symbols: Vec<u16>,
        }

        impl Huffman {
            fn new(lengths: &[u8]) -> Huffman {
                let mut counts = [0u16; 16];
                for &l in lengths {
                    counts[l as usize] += 1;
                }
                counts[0] = 0;
                let mut offs = [0u16; 16];
                for i in 1..16 {
                    offs[i] = offs[i - 1] + counts[i - 1];
                }
                let mut symbols = vec![0u16; lengths.len()];
                for (s, &l) in lengths.iter().enumerate() {
                    if l != 0 {
                        symbols[offs[l as usize] as usize] = s as u16;
                        offs[l as usize] += 1;
                    }
                }
                Huffman { counts, symbols }
            }
            fn decode(&self, b: &mut Bits) -> Option<u16> {
                let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
                for len in 1..16 {
                    code |= b.bit()? as i32;
                    let count = self.counts[len] as i32;
                    if code - count < first {
                        return self.symbols.get((index + (code - first)) as usize).copied();
                    }
                    index += count;
                    first += count;
                    first <<= 1;
                    code <<= 1;
                }
                None
            }
        }

        const LEN_BASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
        const LEN_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
        const DIST_BASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
        const DIST_EXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

        pub fn zlib(data: &[u8]) -> Option<Vec<u8>> {
            if data.len() < 2 {
                return None;
            }
            let mut b = Bits { data: &data[2..], pos: 0, bit: 0 };
            let mut out = Vec::new();
            loop {
                let last = b.bit()?;
                match b.bits(2)? {
                    0 => {
                        b.align();
                        let len = u16::from_le_bytes([*b.data.get(b.pos)?, *b.data.get(b.pos + 1)?]) as usize;
                        b.pos += 4;
                        out.extend_from_slice(b.data.get(b.pos..b.pos + len)?);
                        b.pos += len;
                    }
                    1 => {
                        let mut l = [0u8; 288];
                        l[..144].fill(8);
                        l[144..256].fill(9);
                        l[256..280].fill(7);
                        l[280..].fill(8);
                        let lit = Huffman::new(&l);
                        let dist = Huffman::new(&[5u8; 30]);
                        block(&mut b, &mut out, &lit, &dist)?;
                    }
                    2 => {
                        let hlit = b.bits(5)? as usize + 257;
                        let hdist = b.bits(5)? as usize + 1;
                        let hclen = b.bits(4)? as usize + 4;
                        const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                        let mut cl = [0u8; 19];
                        for &i in ORDER.iter().take(hclen) {
                            cl[i] = b.bits(3)? as u8;
                        }
                        let clh = Huffman::new(&cl);
                        let mut lengths = Vec::with_capacity(hlit + hdist);
                        while lengths.len() < hlit + hdist {
                            let sym = clh.decode(&mut b)?;
                            match sym {
                                0..=15 => lengths.push(sym as u8),
                                16 => {
                                    let prev = *lengths.last()?;
                                    for _ in 0..3 + b.bits(2)? {
                                        lengths.push(prev);
                                    }
                                }
                                17 => {
                                    for _ in 0..3 + b.bits(3)? {
                                        lengths.push(0);
                                    }
                                }
                                _ => {
                                    for _ in 0..11 + b.bits(7)? {
                                        lengths.push(0);
                                    }
                                }
                            }
                        }
                        let lit = Huffman::new(&lengths[..hlit]);
                        let dist = Huffman::new(&lengths[hlit..]);
                        block(&mut b, &mut out, &lit, &dist)?;
                    }
                    _ => return None,
                }
                if last == 1 {
                    break;
                }
            }
            Some(out)
        }

        fn block(b: &mut Bits, out: &mut Vec<u8>, lit: &Huffman, dist: &Huffman) -> Option<()> {
            loop {
                let sym = lit.decode(b)? as usize;
                match sym {
                    0..=255 => out.push(sym as u8),
                    256 => return Some(()),
                    _ => {
                        let i = sym - 257;
                        let len = LEN_BASE[i] as usize + b.bits(LEN_EXTRA[i] as u32)? as usize;
                        let d = dist.decode(b)? as usize;
                        let distance = DIST_BASE[d] as usize + b.bits(DIST_EXTRA[d] as u32)? as usize;
                        let start = out.len().checked_sub(distance)?;
                        for k in 0..len {
                            out.push(out[start + k]);
                        }
                    }
                }
            }
        }
    }
}
